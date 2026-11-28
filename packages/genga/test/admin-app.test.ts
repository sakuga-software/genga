import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGenga, s3StorageAdapter, type Genga, type GengaOptions } from '../src/server';
import { TEST_URL } from './global-setup';
import { SITE, testConfig } from './helpers';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
let assetsDir: string;
const started: Genga[] = [];

function start(options: Partial<GengaOptions> = {}) {
  const genga = createGenga(testConfig, {
    databaseUrl: TEST_URL,
    scheduler: false,
    siteUrl: SITE,
    secureCookies: false,
    logger: quiet,
    adminAssetsDir: assetsDir,
    ...options,
  });
  started.push(genga);
  return genga;
}

const at = (pathname: string, init?: RequestInit) => new Request(new URL(pathname, SITE), init);

beforeAll(async () => {
  assetsDir = await mkdtemp(path.join(tmpdir(), 'genga-admin-app-'));
  await writeFile(
    path.join(assetsDir, 'genga-admin.json'),
    JSON.stringify({ script: 'main-abc.js', style: 'admin-abc.css' }),
  );
  await writeFile(path.join(assetsDir, 'main-abc.js'), 'console.log("admin")');
  await writeFile(path.join(assetsDir, 'admin-abc.css'), 'body{}');
  await writeFile(path.join(assetsDir, 'notes.txt'), 'not an asset');
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((genga) => genga.close()));
});

afterAll(async () => {
  await rm(assetsDir, { recursive: true, force: true });
});

describe('admin app', () => {
  it('serves the HTML shell on every admin page, with no inline script', async () => {
    const genga = start();
    for (const pathname of ['/admin', '/admin/', '/admin/login', '/admin/collections/journal/x', '/admin/whatever']) {
      const response = await genga.handle(at(pathname));
      expect(response?.status, pathname).toBe(200);
      const html = await response?.text();
      expect(html).toContain('<meta name="genga-admin-path" content="/admin">');
      expect(html).toContain('<script type="module" src="/admin/_app/main-abc.js"></script>');
      expect(html).toContain('href="/admin/_app/admin-abc.css"');
      expect(html).not.toMatch(/<script>|<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/<style|style="/);
    }
  });

  it('sends the admin headers and a strict CSP on the shell', async () => {
    const response = (await start().handle(at('/admin/media'))) as Response;
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-src 'self' http://genga.test",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('forbids every frame, on the consent page and on the other pages', async () => {
    const genga = start();
    for (const pathname of ['/admin/oauth/authorize?client_id=x', '/admin/OAuth/authorize', '/admin/login']) {
      const response = (await genga.handle(at(pathname))) as Response;
      expect(response.headers.get('content-security-policy'), pathname).toContain("frame-ancestors 'none'");
    }
  });

  it('leaves the admin pages to the route modules of 0.3 with adminApp: false', async () => {
    const genga = start({ adminApp: false });
    expect(await genga.handle(at('/admin/login'))).toBeNull();
    expect(await genga.handle(at('/admin/_app/main-abc.js'))).toBeNull();
    expect((await genga.handle(at('/admin/api/views/layout')))?.status).toBe(401);
  });

  it('allows the preview origins in frames and the media origins in images', async () => {
    const preview = (await start({
      previewOrigins: ['https://www.example.com'],
      previewSecret: 'x'.repeat(40),
    }).handle(at('/admin'))) as Response;
    expect(preview.headers.get('content-security-policy')).toContain(
      "frame-src 'self' https://www.example.com http://genga.test",
    );

    const s3 = { bucket: 'media', region: 'fr-par', accessKeyId: 'id', secretAccessKey: 'secret' };
    const signed = (await start({
      storage: s3StorageAdapter({ ...s3, endpoint: 'https://s3.fr-par.scw.cloud', delivery: 'signed' }),
    }).handle(at('/admin'))) as Response;
    expect(signed.headers.get('content-security-policy')).toContain(
      "img-src 'self' data: blob: https://s3.fr-par.scw.cloud;",
    );
    const publicDelivery = (await start({
      storage: s3StorageAdapter({ ...s3, delivery: 'public', publicUrl: 'https://media.example.com/files' }),
    }).handle(at('/admin'))) as Response;
    expect(publicDelivery.headers.get('content-security-policy')).toContain(
      "img-src 'self' data: blob: https://media.example.com;",
    );
  });

  it('serves the assets with a long cache, and 404 for any other file under _app', async () => {
    const genga = start();
    const script = (await genga.handle(at('/admin/_app/main-abc.js'))) as Response;
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await script.text()).toBe('console.log("admin")');
    const head = (await genga.handle(at('/admin/_app/admin-abc.css', { method: 'HEAD' }))) as Response;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const name of [
      'genga-admin.json',
      'notes.txt',
      'missing.js',
      '..%2Fgenga-admin.json',
      '%2E%2E%2Fmain-abc.js',
      '',
    ]) {
      const response = (await genga.handle(at(`/admin/_app/${name}`))) as Response;
      expect(response.status, name).toBe(404);
      expect(await response.text(), name).not.toContain('<html');
    }
  });

  it('refuses writes on the pages', async () => {
    const response = (await start().handle(at('/admin/login', { method: 'POST', body: 'x' }))) as Response;
    expect(response.status).toBe(405);
  });

  it('follows a custom admin path', async () => {
    const genga = start({ adminPath: '/cms' });
    const html = await ((await genga.handle(at('/cms/collections/journal'))) as Response).text();
    expect(html).toContain('<meta name="genga-admin-path" content="/cms">');
    expect(html).toContain('src="/cms/_app/main-abc.js"');
    expect(((await genga.handle(at('/cms/_app/main-abc.js'))) as Response).status).toBe(200);
    expect(await genga.handle(at('/admin'))).toBeNull();
  });

  it('answers 500 when the admin app is not built', async () => {
    const response = (await start({ adminAssetsDir: path.join(assetsDir, 'missing') }).handle(
      at('/admin'),
    )) as Response;
    expect(response.status).toBe(500);
  });
});
