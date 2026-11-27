#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestListener } from '@react-router/node';
import { serveMcp } from './mcp-listener.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(root, 'build/client');
const port = Number(process.env.PORT || 3000);

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves a file of the client build. Returns false when no file matches. */
async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return false;
  }
  if (pathname === '/' || pathname.includes('\0')) return false;
  const file = path.join(clientDir, pathname);
  if (!file.startsWith(`${clientDir}${path.sep}`)) return false;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

let build;
try {
  build = await import('./build/server/index.js');
} catch (error) {
  // Settings and config errors list every problem: print them without a stack trace.
  const known = error?.name === 'SettingsError' || error?.name === 'ConfigError';
  console.error(known ? `[genga] ${error.message}` : error);
  process.exit(1);
}

const handle = createRequestListener({ build, mode: 'production' });

/**
 * Appends the TCP peer to X-Forwarded-For, so this server acts as one proxy hop and Genga
 * reads the client address from the header. The Fetch request is built from `rawHeaders`.
 */
function appendPeerAddress(req) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  const raw = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'x-forwarded-for') continue;
    raw.push(req.rawHeaders[index], req.rawHeaders[index + 1]);
  }
  raw.push('X-Forwarded-For', forwarded ? `${forwarded}, ${peer}` : peer);
  req.rawHeaders = raw;
}

const server = http.createServer(async (req, res) => {
  appendPeerAddress(req);
  try {
    if (await serveStatic(req, res)) return;
  } catch (error) {
    console.error('[genga] Static file error:', error);
  }
  try {
    if (await serveMcp(req, res, await globalThis.__gengaServer)) return;
  } catch (error) {
    console.error('[genga] MCP error:', error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal error.');
    return;
  }
  handle(req, res);
});

server.keepAliveTimeout = 65_000;
server.listen(port, '0.0.0.0', () => console.log(`[genga] Listening on port ${port}.`));

/** Stops the webhook sender and closes the database pool of the Genga instance of the build. */
async function closeGenga() {
  try {
    await (await globalThis.__gengaServer)?.genga.close();
  } catch (error) {
    console.error('[genga] Close failed:', error);
  }
}

function shutdown(signal) {
  console.log(`[genga] ${signal}: closing.`);
  server.close(() => closeGenga().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
