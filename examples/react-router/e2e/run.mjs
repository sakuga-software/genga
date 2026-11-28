#!/usr/bin/env node
// Runs the React Router example on the prebuilt admin, then the Playwright tests. It empties the
// database, migrates it, builds and starts the example, and gives the tests the setup link that
// the server logs. A second pass builds the example with the admin under `/cms`.
//
// Usage: pnpm build && E2E_DATABASE_URL=postgres://…/genga_e2e node examples/react-router/e2e/run.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(example, '../..');
// WARNING: the run deletes all content of this database. It never reads DATABASE_URL.
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  console.error('Set E2E_DATABASE_URL to a test database: the run deletes all its content.');
  process.exit(1);
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/_(e2e|test)$/.test(databaseName)) {
  console.error(`The database of E2E_DATABASE_URL must end in _e2e or _test, not "${databaseName}".`);
  process.exit(1);
}

const port = Number(process.env.E2E_SITE_PORT ?? 3920);
const siteUrl = `http://localhost:${port}`;
const mediaDir = mkdtempSync(path.join(tmpdir(), 'genga-rr-e2e-'));
let server = null;

async function resetDatabase() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await sql.end();
  }
  execFileSync('node', [path.join(root, 'packages/genga/bin/genga-migrate.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

function build(adminPath) {
  execFileSync('pnpm', ['run', 'build'], {
    cwd: example,
    stdio: 'inherit',
    env: { ...process.env, GENGA_ADMIN_PATH: adminPath },
  });
}

/** Starts the built example. Resolves with the setup link when the server logs one, else with null. */
function start(adminPath) {
  const child = spawn(path.join(example, 'node_modules/.bin/react-router-serve'), ['./build/server/index.js'], {
    cwd: example,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SITE_URL: siteUrl,
      GENGA_ADMIN_PATH: adminPath,
      GENGA_ADMIN_EMAIL: 'admin@example.com',
      GENGA_MEDIA_DIR: mediaDir,
      GENGA_TRUSTED_PROXIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the stop also reaches its child processes.
    detached: true,
  });
  server = child;
  let resolveSetup;
  const setup = new Promise((resolve) => (resolveSetup = resolve));
  // The server logs a one-time setup link: keep it out of the CI logs.
  const forward = (stream, write) =>
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      const link = /(https?:\/\/\S+\/setup\?token=[\w-]+)/.exec(line)?.[1];
      if (link) resolveSetup(link);
      else if (line) write(`[site] ${line}`);
    });
  forward(child.stdout, console.log);
  forward(child.stderr, console.error);
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[site] exited with ${code}`);
  });
  return setup;
}

function stop() {
  if (!server) return Promise.resolve();
  const child = server;
  server = null;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // The process group already stopped.
    }
  };
  signal('SIGTERM');
  // react-router-serve can outlive SIGTERM on macOS: the group gets SIGKILL after 5 seconds.
  const timer = setTimeout(() => signal('SIGKILL'), 5_000);
  return exited.finally(() => clearTimeout(timer));
}

async function waitFor(url, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server does not answer yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${url} did not answer 200.`);
}

function playwright(project, env) {
  const child = spawn('pnpm', ['exec', 'playwright', 'test', '--project', project, ...process.argv.slice(2)], {
    cwd: example,
    stdio: 'inherit',
    env: { ...process.env, E2E_SITE_URL: siteUrl, ...env },
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error('[e2e] Playwright did not start:', error);
      resolve(1);
    });
  });
}

let status = 1;
let stage = 'the reset of the database';
try {
  await resetDatabase();
  stage = 'the build with /admin';
  build('/admin');
  stage = 'the start of the site';
  const setup = start('/admin');
  await waitFor(`${siteUrl}/`);
  const setupUrl = await Promise.race([setup, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))]);
  if (!setupUrl) throw new Error('The server logged no setup link.');
  stage = 'Playwright, admin';
  status = await playwright('admin', { E2E_SETUP_URL: setupUrl });
  if (status === 0) {
    await stop();
    stage = 'the build with /cms';
    build('/cms');
    start('/cms');
    await waitFor(`${siteUrl}/`);
    stage = 'Playwright, custom admin path';
    status = await playwright('custom-path', { E2E_ADMIN_PATH: '/cms' });
  }
} catch (error) {
  console.error(`[e2e] The run failed at ${stage}:`, error);
  status = 1;
} finally {
  await stop();
  rmSync(mediaDir, { recursive: true, force: true });
}
process.exit(status);
