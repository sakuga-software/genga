import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGenga, type Genga } from 'genga/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveMcp } from '../mcp-listener.mjs';
import { parseConfig } from '../app/.server/config-file';
import { TEST_URL } from './global-setup';

const config = parseConfig({
  collections: {
    posts: {
      label: 'Posts',
      path: '/blog/{slug}',
      fields: { title: { type: 'text', required: true }, slug: { type: 'slug', from: 'title' } },
    },
  },
});

const AGENT = 'https://agent.example';
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser', version: '1.0.0' } },
});

let genga: Genga;
let mediaDir: string;
let server: http.Server;
let baseUrl: string;
let token: string;
let mcpEnabled = true;

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-server-mcp-listener-'));
  genga = createGenga(config, {
    databaseUrl: TEST_URL,
    siteUrl: 'http://cms.test',
    mediaDir,
    secureCookies: false,
    trustedProxies: 0,
    allowedOrigins: [AGENT],
    mcp: { path: '/agents' },
    logger: { info: () => {}, warn: () => {}, error: console.error },
  });
  await genga.ready();
  await genga.sql`TRUNCATE genga_audit, genga_api_tokens, genga_documents, genga_users CASCADE`;
  const { user } = await genga.auth.invite('listener@genga.test', 'Editor', 'editor');
  ({ token } = await genga.tokens.create(user, { name: 'browser', scopes: ['read'] }));

  // The fallback stands for React Router: it refuses every cross-origin POST, like its CSRF check.
  server = http.createServer(async (req, res) => {
    const settings = { mcp: { enabled: mcpEnabled, path: '/agents' } };
    if (await serveMcp(req, res, { genga, settings })) return;
    res.writeHead(req.method === 'POST' && req.headers.origin ? 400 : 404, { 'x-fallback': 'react-router' });
    res.end('Bad Request');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await genga.close();
  await rm(mediaDir, { recursive: true, force: true });
});

function post(pathname: string, headers: Record<string, string>) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: INITIALIZE,
  });
}

describe('MCP listener of the headless server', () => {
  it('lets the MCP origin check answer a cross-origin POST from an allowed origin', async () => {
    const response = await post('/agents', { origin: AGENT, authorization: `Bearer ${token}` });
    expect(response.headers.get('x-fallback')).toBeNull();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"serverInfo"');
  });

  it('refuses another origin with the JSON-RPC error of MCP, not the 400 of React Router', async () => {
    const response = await post('/agents/', { origin: 'https://evil.example', authorization: `Bearer ${token}` });
    expect(response.headers.get('x-fallback')).toBeNull();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: 'Origin not allowed.' } });
  });

  it('asks for a token without one', async () => {
    const response = await post('/AGENTS', { origin: AGENT });
    expect(response.status).toBe(401);
  });

  it('gives other paths, and the MCP path when MCP is off, to React Router', async () => {
    expect((await post('/admin/login', { origin: AGENT })).headers.get('x-fallback')).toBe('react-router');
    expect((await post('/agents-x', { origin: AGENT })).headers.get('x-fallback')).toBe('react-router');
    mcpEnabled = false;
    try {
      expect((await post('/agents', { origin: AGENT })).headers.get('x-fallback')).toBe('react-router');
    } finally {
      mcpEnabled = true;
    }
  });

  it('answers 400 to a header that a Fetch request cannot carry', async () => {
    const written: { status?: number; body?: string } = {};
    const req = {
      method: 'POST',
      url: '/agents',
      headers: { host: 'cms.test' },
      rawHeaders: ['Host', 'cms.test', 'X-Bad', 'a\u0100b'],
    } as unknown as http.IncomingMessage;
    const res = {
      writeHead: (status: number) => (written.status = status),
      end: (body: string) => (written.body = body),
    } as unknown as http.ServerResponse;
    const settings = { mcp: { enabled: true, path: '/agents' } };
    expect(await serveMcp(req, res, { genga, settings })).toBe(true);
    expect(written.status).toBe(400);
  });

  it('gives a request with a Host that is not a valid URL to React Router', async () => {
    const req = {
      method: 'POST',
      url: '/agents',
      headers: { host: 'cms test' },
      rawHeaders: ['Host', 'cms test'],
    } as unknown as http.IncomingMessage;
    const settings = { mcp: { enabled: true, path: '/agents' } };
    expect(await serveMcp(req, {} as http.ServerResponse, { genga, settings })).toBe(false);
  });
});
