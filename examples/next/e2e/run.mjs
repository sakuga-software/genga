#!/usr/bin/env node
// Runs the Next.js example against a Genga server (remote mode), then the Playwright tests.
// It empties the database, migrates it, starts the built server image app (apps/server) and
// the built example, and gives the tests a one-time setup link for the first admin.
// The admin is on `localhost` and the site on `127.0.0.1`: two sites, as a CMS on another domain.
// The site is behind a local HTTPS proxy with a certificate of the run: WebKit on Linux keeps no
// `Secure` cookie on plain HTTP, and the preview cookies are `Secure` in production.
//
// Usage: pnpm build && E2E_DATABASE_URL=postgres://…/genga_e2e node examples/next/e2e/run.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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
  console.error(
    `The database of E2E_DATABASE_URL must end in _e2e or _test, not "${databaseName}": the run deletes all its content.`,
  );
  process.exit(1);
}

const gengaPort = Number(process.env.E2E_GENGA_PORT ?? 3910);
const sitePort = Number(process.env.E2E_SITE_PORT ?? 3911);
const httpsPort = Number(process.env.E2E_SITE_HTTPS_PORT ?? 3912);
const gengaUrl = `http://localhost:${gengaPort}`;
/** The site for the browser and the Genga server. */
const siteUrl = `https://127.0.0.1:${httpsPort}`;
/** The site without the proxy, for the webhook. */
const siteDirect = `http://127.0.0.1:${sitePort}`;
const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`;
const mediaDir = mkdtempSync(path.join(tmpdir(), 'genga-next-e2e-'));
const children = [];

/** An HTTPS proxy in front of the site, with a certificate for 127.0.0.1 that lives one run. */
function startHttpsProxy(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: sitePort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'x-forwarded-proto': 'https' },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.listen(httpsPort, '127.0.0.1');
  return server;
}

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

function start(name, command, args, cwd, env) {
  // `detached` gives the server its own process group, so the stop also reaches its child processes.
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // The Genga server logs a one-time setup link: keep it out of the CI logs. The filter reads whole lines.
  const forward = (stream, write) =>
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      if (line && !line.includes('setup?token=')) write(`[${name}] ${line}`);
    });
  forward(child.stdout, console.log);
  forward(child.stderr, console.error);
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[${name}] exited with ${code}`);
  });
  children.push(child);
  return child;
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

/** A one-time link that creates the first admin, as the setup link of a new server. */
async function inviteAdmin() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    const [user] = await sql`
      INSERT INTO genga_users (email, name, role) VALUES ('admin@genga.test', 'Admin', 'admin') RETURNING id
    `;
    await sql`
      INSERT INTO genga_tokens (kind, token_hash, user_id, expires_at)
      VALUES ('invite', ${hash}, ${user.id}, ${new Date(Date.now() + 60 * 60_000)})
    `;
  } finally {
    await sql.end();
  }
  return `${gengaUrl}/admin/setup?token=${token}`;
}

let status = 1;
let stage = 'the reset of the database';
let proxy;
try {
  await resetDatabase();
  stage = 'the start of the servers';
  start('genga', 'node', [path.join(root, 'apps/server/server.mjs')], path.join(root, 'apps/server'), {
    NODE_ENV: 'production',
    PORT: String(gengaPort),
    DATABASE_URL: databaseUrl,
    GENGA_CONFIG: path.join(example, 'genga.config.mjs'),
    GENGA_PUBLIC_URL: gengaUrl,
    GENGA_SITE_URL: siteUrl,
    GENGA_PREVIEW_ORIGINS: siteUrl,
    GENGA_CORS_ORIGINS: siteUrl,
    GENGA_SECRET: randomBytes(48).toString('base64'),
    GENGA_WEBHOOKS: JSON.stringify([{ url: `${siteDirect}/api/genga/webhook`, secret: webhookSecret }]),
    GENGA_MEDIA_DIR: mediaDir,
    GENGA_TRUSTED_PROXIES: '0',
    GENGA_MCP: 'off',
  });
  start('site', path.join(example, 'node_modules/.bin/next'), ['start', '--port', String(sitePort)], example, {
    NODE_ENV: 'production',
    GENGA_URL: gengaUrl,
    GENGA_SITE_URL: siteUrl,
    GENGA_WEBHOOK_SECRET: webhookSecret,
  });
  proxy = startHttpsProxy(mediaDir);
  stage = 'the readiness of the Genga server and the site';
  await Promise.all([waitFor(`${gengaUrl}/readyz`), waitFor(`${siteDirect}/`)]);
  stage = 'the setup link';
  const setupUrl = await inviteAdmin();
  stage = 'Playwright';
  const args = ['exec', 'playwright', 'test', ...process.argv.slice(2)];
  const playwright = spawn('pnpm', args, {
    cwd: example,
    stdio: 'inherit',
    env: { ...process.env, E2E_GENGA_URL: gengaUrl, E2E_SITE_URL: siteUrl, E2E_SETUP_URL: setupUrl },
  });
  status = await new Promise((resolve) => {
    playwright.on('exit', (code) => resolve(code ?? 1));
    playwright.on('error', (error) => {
      console.error('[e2e] Playwright did not start:', error);
      resolve(1);
    });
  });
} catch (error) {
  console.error(`[e2e] The run failed at ${stage}:`, error);
} finally {
  proxy?.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The server already stopped.
    }
  }
  rmSync(mediaDir, { recursive: true, force: true });
}
process.exit(status);
