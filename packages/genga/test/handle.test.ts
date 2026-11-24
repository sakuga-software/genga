import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGenga, type Genga, type GengaOptions } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, pngFile, SITE, testConfig } from './helpers';

const quiet = { info: () => {}, warn: () => {}, error: console.error };
let mediaDir: string;
const started: Genga[] = [];

function start(options: Partial<GengaOptions> = {}) {
  const genga = createGenga(testConfig, {
    databaseUrl: TEST_URL,
    siteUrl: SITE,
    mediaDir,
    secureCookies: false,
    logger: quiet,
    ...options,
  });
  started.push(genga);
  return genga;
}

const at = (pathname: string, init?: RequestInit) => new Request(new URL(pathname, SITE), init);

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-handle-'));
});

beforeEach(async () => {
  const genga = start();
  await genga.ready();
  await genga.sql`TRUNCATE genga_media, genga_documents, genga_sessions, genga_users CASCADE`;
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((genga) => genga.close()));
});

afterAll(async () => {
  await rm(mediaDir, { recursive: true, force: true });
});

describe('genga.handle', () => {
  it('returns null for the site and the admin pages', async () => {
    const genga = start();
    for (const pathname of ['/', '/journal/hello', '/admin', '/admin/login', '/admin/collections/journal', '/apis']) {
      expect(await genga.handle(at(pathname)), pathname).toBeNull();
    }
  });

  it('answers the admin API with the session rules', async () => {
    const genga = start();
    const anonymous = await genga.handle(at('/admin/api/documents?collection=journal'));
    expect(anonymous?.status).toBe(401);
    expect(anonymous?.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const user = await createUser(genga, 'admin');
    const cookie = await genga.auth.createSession(user.id, at('/admin'));
    const listed = await genga.handle(
      at('/admin/api/documents?collection=journal', { headers: { cookie: cookie.split(';')[0] } }),
    );
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual({ documents: [] });
  });

  it('keeps the public API and MCP off by default', async () => {
    const genga = start();
    expect(await genga.handle(at('/api/v1/collections'))).toBeNull();
    expect(await genga.handle(at('/mcp', { method: 'POST' }))).toBeNull();
  });

  it('serves the public API and MCP when they are on', async () => {
    const genga = start({ publicApi: true, mcp: { path: '/agents' } });
    const collections = await genga.handle(at('/api/v1/collections'));
    expect(collections?.status).toBe(200);
    expect((await collections?.json()).collections[0].name).toBe('journal');
    const mcp = await genga.handle(at('/agents', { method: 'POST' }));
    expect(mcp?.status).toBe(401);
    expect(await genga.handle(at('/mcp', { method: 'POST' }))).toBeNull();
  });

  it('serves media under the media path, and media URLs follow it', async () => {
    const genga = start({ mediaPath: '/files/' });
    expect(genga.mediaPath).toBe('/files');
    const user = await createUser(genga, 'admin');
    const { media } = await genga.media.upload(user, await pngFile('handle.png', { r: 1, g: 2, b: 3 }));
    expect(media.url).toMatch(/^\/files\/[a-f0-9]{64}\.png$/);
    expect(media.sizes[0].url.startsWith('/files/')).toBe(true);

    const file = await genga.handle(at(media.url));
    expect(file?.status).toBe(200);
    expect(file?.headers.get('content-type')).toBe('image/png');
    expect((await file?.arrayBuffer())?.byteLength).toBeGreaterThan(0);
    const head = await genga.handle(at(media.url, { method: 'HEAD' }));
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe('');
    expect((await genga.handle(at(media.url, { method: 'POST' })))?.status).toBe(405);
    expect((await genga.handle(at('/files/not-a-key.png')))?.status).toBe(404);
    expect(await genga.handle(at(media.url.replace('/files/', '/media/')))).toBeNull();
  });

  it('refuses overlapping paths at start', () => {
    expect(() => start({ adminPath: '/api', publicApi: true })).toThrow(/overlap/);
    expect(() => start({ mediaPath: '/admin/files' })).toThrow(/overlap/);
    expect(() => start({ mcp: { path: '/media' } })).toThrow(/overlap/);
    expect(() => start({ mediaPath: 'files' })).toThrow(/media path/);
    expect(() => start({ adminPath: '/api' })).not.toThrow();
  });

  it('answers 503 on its paths when the database is not reachable, and null elsewhere', async () => {
    const genga = start({ databaseUrl: 'postgres://genga:genga@127.0.0.1:9/genga', publicApi: true, mcp: {} });
    expect((await genga.handle(at('/admin/api/documents')))?.status).toBe(503);
    expect((await genga.handle(at('/api/v1/collections')))?.status).toBe(503);
    const mcp = await genga.handle(at('/mcp', { method: 'POST' }));
    expect(mcp?.status).toBe(503);
    expect(await mcp?.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    expect(await genga.handle(at('/'))).toBeNull();
  });

  it('logs one warning per deprecated alias', async () => {
    const warnings: string[] = [];
    const genga = start({ logger: { ...quiet, warn: (message: string) => warnings.push(message) } });
    await genga.api(at('/admin/api/documents'), '/documents');
    await genga.api(at('/admin/api/documents'), '/documents');
    await genga.media.serve('nope');
    expect(warnings.filter((message) => message.includes('genga.api'))).toHaveLength(1);
    expect(warnings.filter((message) => message.includes('genga.media.serve'))).toHaveLength(1);
  });
});

describe('peer address', () => {
  it('counts the peer as one more proxy hop', async () => {
    const genga = start({ publicApi: { rateLimit: 1 }, trustedProxies: 0 });
    const from = (peerAddress: string, forwarded?: string) =>
      genga.handle(at('/api/v1/collections', { headers: forwarded ? { 'x-forwarded-for': forwarded } : {} }), {
        peerAddress,
      });
    expect((await from('192.0.2.1'))?.status).toBe(200);
    expect((await from('192.0.2.1'))?.status).toBe(429);
    // A forged header without a trusted proxy does not give a new bucket.
    expect((await from('192.0.2.1', '198.51.100.4'))?.status).toBe(429);
    expect((await from('192.0.2.2'))?.status).toBe(200);
  });

  it('trusts the proxies in front of the peer', async () => {
    const genga = start({ publicApi: { rateLimit: 1 }, trustedProxies: 1 });
    const from = (forwarded: string) =>
      genga.handle(at('/api/v1/collections', { headers: { 'x-forwarded-for': forwarded } }), {
        peerAddress: '10.0.0.2',
      });
    expect((await from('203.0.113.1'))?.status).toBe(200);
    expect((await from('203.0.113.1'))?.status).toBe(429);
    expect((await from('203.0.113.2'))?.status).toBe(200);
  });

  it('keeps the body of a write', async () => {
    const genga = start();
    const user = await createUser(genga, 'admin');
    const cookie = (await genga.auth.createSession(user.id, at('/admin'))).split(';')[0];
    const form = new FormData();
    form.set('file', await pngFile('peer.png', { r: 9, g: 8, b: 7 }));
    form.set('alt', 'Peer upload');
    const response = await genga.handle(
      at('/admin/api/media', { method: 'POST', body: form, headers: { cookie, origin: SITE } }),
      { peerAddress: '192.0.2.9' },
    );
    expect(response?.status).toBe(201);
    expect((await response?.json()).media.alt).toBe('Peer upload');
  });
});
