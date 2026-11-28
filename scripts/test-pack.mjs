#!/usr/bin/env node
// Proves that the published shape of `genga` works: it packs the library, installs the
// tarball into a copy of examples/react-router outside the workspace, builds the copy,
// runs `genga-migrate`, starts the production server and checks a few pages. Then it packs
// `@genga-cms/next` and builds a copy of examples/next with both tarballs.
//
// Usage: DATABASE_URL=postgres://… node scripts/test-pack.mjs [--keep] [--react-router=7|8]
// Without DATABASE_URL, the script checks the build and the pages of a site with the CMS off.
// `--react-router=7` installs React Router 7 in the copy, at the range of the peer dependency of
// `genga`. The default is the React Router 8 of the example.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const reactRouterArg = process.argv.find((arg) => arg.startsWith('--react-router'));
const reactRouterMajor = reactRouterArg === undefined ? '8' : reactRouterArg.split('=')[1];
if (!['7', '8'].includes(reactRouterMajor)) throw new Error(`--react-router takes 7 or 8, not ${reactRouterMajor}.`);
const work = mkdtempSync(path.join(tmpdir(), 'genga-pack-'));
const app = path.join(work, 'app');
const port = Number(process.env.PORT ?? 3917);

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } });
}

async function waitFor(url, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`The server did not answer on ${url}.`);
}

async function expectStatus(url, expected, contains) {
  const response = await fetch(url, { redirect: 'manual' });
  const body = await response.text();
  if (response.status !== expected) throw new Error(`${url}: status ${response.status}, expected ${expected}.`);
  if (contains && !body.includes(contains)) throw new Error(`${url}: the body does not contain "${contains}".`);
  console.log(`ok ${response.status} ${url}`);
  return body;
}

/**
 * Walks the import graph of a built file. Fails on a bare import (a package or a Node built-in)
 * and on Node globals, so the entry runs on edge runtimes.
 */
function checkEdgeSafe(entry) {
  const seen = new Set();
  const problems = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [, specifier] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      if (specifier.startsWith('.')) visit(path.resolve(path.dirname(file), specifier));
      else problems.push(`${path.basename(file)} imports ${specifier}`);
    }
    for (const name of ['Buffer', 'process.', 'require(']) {
      if (code.includes(name)) problems.push(`${path.basename(file)} uses ${name}`);
    }
  };
  visit(entry);
  if (problems.length) throw new Error(`genga/remote is not edge-safe:\n  ${problems.join('\n  ')}`);
  console.log(`ok genga/remote imports only its own ${seen.size} files`);
}

/** Fails when the tarball lacks the prebuilt admin app that `genga.handle` serves. */
function checkAdminApp(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'dist/admin-app/genga-admin.json'), 'utf8'));
  for (const name of [manifest.script, manifest.style]) readFileSync(path.join(dir, 'dist/admin-app', name));
  console.log(`ok genga ships the admin app (${manifest.script}, ${manifest.style})`);
}

/** The range of the `react-router` peer dependency of `genga` for one major, for example `^7.18.4`. */
function peerRangeOf(major) {
  const genga = JSON.parse(readFileSync(path.join(root, 'packages/genga/package.json'), 'utf8'));
  const range = genga.peerDependencies['react-router']
    .split('||')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`^${major}.`));
  if (!range) throw new Error(`The react-router peer range of genga has no React Router ${major}.`);
  return range;
}

function pinReactRouter(pkg, major) {
  const range = peerRangeOf(major);
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const name of Object.keys(deps)) {
      if (name === 'react-router' || name.startsWith('@react-router/')) deps[name] = range;
    }
  }
  // @react-router/dev 7 has the peer typescript ^5.1.0 || ^6.0.0: npm refuses TypeScript 7.
  if (major === '7') pkg.devDependencies.typescript = '^6.0.3';
}

function checkInstalledMajor(name, major) {
  const { version } = JSON.parse(readFileSync(path.join(app, 'node_modules', name, 'package.json'), 'utf8'));
  if (version.split('.')[0] !== major) throw new Error(`${name} ${version} is installed, expected ${major}.x.`);
  console.log(`ok ${name} ${version}`);
}

/**
 * Stops the server and its children. On macOS, react-router-serve can outlive the SIGTERM sent to
 * `npm run start`, so the script signals the whole process group, then kills what is left.
 */
async function stopServer(child, timeoutMs = 5_000) {
  if (!child?.pid) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    signalGroup('SIGTERM');
    const timer = setTimeout(() => signalGroup('SIGKILL'), timeoutMs);
    await exited;
    clearTimeout(timer);
  }
  signalGroup('SIGKILL');
}

/** Copies an example out of the workspace, with its dependencies on the tarballs. */
function copyExample(name, target, dependencies, adjust = () => {}) {
  cpSync(path.join(root, 'examples', name), target, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|build|\.react-router|\.next|data|test-results)([\\/]|$)/.test(source),
  });
  // Turbopack reads no file outside the project: the copy gets its own base config.
  cpSync(path.join(root, 'tsconfig.base.json'), path.join(target, 'tsconfig.base.json'));
  const tsconfigPath = path.join(target, 'tsconfig.json');
  writeFileSync(
    tsconfigPath,
    readFileSync(tsconfigPath, 'utf8').replace('../../tsconfig.base.json', './tsconfig.base.json'),
  );
  const pkgPath = path.join(target, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  Object.assign(pkg.dependencies, dependencies);
  adjust(pkg);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Fails when the packed `@genga-cms/next` leaves a workspace range or loses its client boundary. */
function checkNextPackage(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.peerDependencies.genga !== `~${pkg.version}`) {
    throw new Error(`@genga-cms/next has the peer genga "${pkg.peerDependencies.genga}", not "~${pkg.version}".`);
  }
  if (!readFileSync(path.join(dir, 'dist/client.mjs'), 'utf8').startsWith('"use client"')) {
    throw new Error('dist/client.mjs of @genga-cms/next does not start with "use client".');
  }
  if (!/from "\.\/client\.mjs"/.test(readFileSync(path.join(dir, 'dist/index.mjs'), 'utf8'))) {
    throw new Error('dist/index.mjs of @genga-cms/next does not import the client components from ./client.mjs.');
  }
  console.log('ok @genga-cms/next keeps its client boundary and a lockstep peer range');
}

let server;
try {
  run('pnpm', ['--filter', 'genga', 'pack', '--pack-destination', work], root);
  const tarball = readdirSync(work).find((name) => /^genga-\d.*\.tgz$/.test(name));
  if (!tarball) throw new Error('pnpm pack wrote no tarball.');

  copyExample('react-router', app, { genga: `file:../${tarball}` }, (pkg) => {
    if (reactRouterMajor !== '8') pinReactRouter(pkg, reactRouterMajor);
  });

  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app);
  for (const name of ['react-router', '@react-router/dev', '@react-router/serve']) {
    checkInstalledMajor(name, reactRouterMajor);
  }
  checkEdgeSafe(path.join(app, 'node_modules/genga/dist/remote.mjs'));
  checkAdminApp(path.join(app, 'node_modules/genga'));
  run('npm', ['run', 'typecheck'], app);
  run('npm', ['run', 'build'], app);

  const serverBuild = readFileSync(path.join(app, 'build/server/index.js'), 'utf8');
  if (!/from ["']genga\/server["']/.test(serverBuild)) {
    throw new Error('The server build does not import genga/server from node_modules.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) run(path.join(app, 'node_modules/.bin/genga-migrate'), [], app);

  server = spawn('npm', ['run', 'start'], {
    cwd: app,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SITE_URL: `http://localhost:${port}` },
  });
  const base = `http://localhost:${port}`;
  await waitFor(base);

  const home = await expectStatus(`${base}/`, 200, 'Genga example');
  if (databaseUrl) {
    const login = await expectStatus(`${base}/admin/login`, 200, '<meta name="genga-admin-path" content="/admin">');
    const css = /href="(\/admin\/_app\/admin-[^"]+\.css)"/.exec(login)?.[1];
    const script = /src="(\/admin\/_app\/main-[^"]+\.js)"/.exec(login)?.[1];
    if (!css || !script) throw new Error('The admin shell links no stylesheet or no script under /admin/_app/.');
    await expectStatus(`${base}${css}`, 200, 'data-genga-admin');
    await expectStatus(`${base}${script}`, 200);
    await expectStatus(`${base}/admin`, 200, 'id="genga-admin"');
    await expectStatus(`${base}/admin/_app/missing.js`, 404);
    await expectStatus(`${base}/admin/api/views/layout`, 401);
  } else {
    if (!home.includes('The CMS is off')) throw new Error('The home page does not say that the CMS is off.');
    await expectStatus(`${base}/admin/login`, 503);
  }
  console.log(`\nThe packed tarball installs, builds and serves with React Router ${reactRouterMajor}.`);
  await stopServer(server);
  server = undefined;

  run('pnpm', ['--filter', '@genga-cms/next', 'pack', '--pack-destination', work], root);
  const nextTarball = readdirSync(work).find((name) => /^genga-cms-next-\d.*\.tgz$/.test(name));
  if (!nextTarball) throw new Error('pnpm pack wrote no tarball of @genga-cms/next.');
  const nextApp = path.join(work, 'next');
  copyExample('next', nextApp, { genga: `file:../${tarball}`, '@genga-cms/next': `file:../${nextTarball}` });
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], nextApp);
  checkNextPackage(path.join(nextApp, 'node_modules/@genga-cms/next'));
  run('npm', ['run', 'typecheck'], nextApp);
  // The build reads no content: the pages render at their first request.
  const build = execFileSync('npm', ['run', 'build'], {
    cwd: nextApp,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', GENGA_URL: 'http://localhost:1' },
  });
  console.log(build);
  if (!/● \/blog\/\[slug\]/.test(build))
    throw new Error('The Next.js example does not build /blog/[slug] as a static route.');
  console.log('\nThe packed @genga-cms/next installs and builds the Next.js example.');
} finally {
  await stopServer(server);
  if (keep) console.log(`Kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
