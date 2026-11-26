import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGenga, createPreviewToken, type Genga, type PublicApiOptions } from 'genga/server';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../app/.server/config-file';
import { TEST_URL } from './global-setup';

const PUBLIC_URL = 'https://cms.example.com';
const SITE = 'https://www.example.com';
const SECRET = 'a-test-secret-that-is-long-enough-for-hmac';

const config = parseConfig({
  collections: {
    posts: {
      label: 'Posts',
      sortField: 'publishedDate',
      path: '/blog/{slug}',
      previewUrl: `${SITE}/blog/{slug}`,
      fields: {
        title: { type: 'text', required: true },
        slug: { type: 'slug', from: 'title' },
        publishedDate: { type: 'date' },
        cover: { type: 'media' },
        intro: { type: 'richText' },
        tags: { type: 'tags' },
        body: { type: 'blocks' },
      },
    },
  },
  blocks: [{ type: 'image', label: 'Image', fields: { image: { type: 'media' }, caption: { type: 'text' } } }],
});

let genga: Genga;
let mediaDir: string;
let clock = Date.now();

/** The handler of the current instance. Options other than the defaults start a new instance. */
async function api(options?: PublicApiOptions) {
  if (options) {
    await genga.close();
    genga = start(options);
  }
  return async (request: Request) => {
    const response = await genga.handle(request);
    if (!response) throw new Error(`genga.handle returned null for ${request.url}`);
    return response;
  };
}

function get(pathname: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Request(new URL(pathname, PUBLIC_URL), {
    method,
    headers: { 'x-forwarded-for': '203.0.113.7', ...headers },
  });
}

async function editor() {
  const { user } = await genga.auth.invite(`${crypto.randomUUID()}@genga.test`, 'Editor', 'editor');
  return user;
}

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] }],
});

async function publishPost(user: Awaited<ReturnType<typeof editor>>, data: Record<string, unknown>) {
  const created = await genga.documents.create(user, 'posts', data);
  const published = await genga.documents.publish(user, created.id, 1);
  return { ...created, versionId: published.versionId };
}

function start(publicApi: PublicApiOptions = {}) {
  return createGenga(config, {
    databaseUrl: TEST_URL,
    scheduler: false,
    siteUrl: PUBLIC_URL,
    mediaDir,
    previewOrigins: [SITE],
    previewSecret: SECRET,
    secureCookies: false,
    trustedProxies: 1,
    publicApi: { corsOrigins: [SITE], rateLimit: 1000, now: () => clock, ...publicApi },
    logger: { info: () => {}, warn: () => {}, error: console.error },
  });
}

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-server-media-'));
  genga = start();
  await genga.ready();
});

// A new instance per test: the published cache lives in the process and survives a TRUNCATE.
beforeEach(async () => {
  clock = Date.now();
  await genga.close();
  genga = start();
  await genga.sql`
    TRUNCATE genga_events, genga_audit, genga_redirects, genga_versions, genga_documents, genga_media, genga_tokens, genga_sessions, genga_users CASCADE
  `;
});

afterAll(async () => {
  await genga.close();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('published content only', () => {
  it('never shows a draft, and shows the published version while a newer draft waits', async () => {
    const user = await editor();
    const draft = await genga.documents.create(user, 'posts', { title: 'Secret draft' });
    const handle = await api();

    const list = await (await handle(get('/api/v1/collections/posts/documents'))).json();
    expect(list).toEqual({ documents: [], total: 0, nextCursor: null });
    expect((await handle(get(`/api/v1/collections/posts/documents/${draft.slug}`))).status).toBe(404);
    expect((await handle(get(`/api/v1/documents/${draft.id}`))).status).toBe(404);

    const live = await publishPost(user, { title: 'Live', publishedDate: '2026-01-02' });
    await genga.documents.saveDraft(user, live.id, { title: 'Unpublished change', slug: live.slug }, 1);

    const bySlug = await handle(get(`/api/v1/collections/posts/documents/${live.slug}`));
    const body = await bySlug.json();
    expect(body.document).toMatchObject({ id: live.id, slug: 'live', path: '/blog/live', versionId: live.versionId });
    expect(body.document.data.title).toBe('Live');
    const byId = await (await handle(get(`/api/v1/documents/${live.id}`))).json();
    expect(byId.document.data.title).toBe('Live');

    const everything = JSON.stringify(await (await handle(get('/api/v1/collections/posts/documents'))).json());
    expect(everything).not.toContain('Secret draft');
    expect(everything).not.toContain('Unpublished change');
  });

  it('gives absolute media URLs and rich text with HTML', async () => {
    const user = await editor();
    const png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#ff6b50' } })
      .png()
      .toBuffer();
    const { media } = await genga.media.upload(
      user,
      new File([new Uint8Array(png)], 'cover.png', { type: 'image/png' }),
      'A cover',
    );
    const post = await publishPost(user, {
      title: 'With media',
      cover: media.id,
      intro: paragraph('Hello <world>'),
      body: [{ _id: 'b1', _type: 'image', image: media.id, caption: 'Caption' }],
    });

    const { document } = await (await (await api())(get(`/api/v1/documents/${post.id}`))).json();
    expect(document.data.cover).toMatchObject({ id: media.id, alt: 'A cover', width: 1200, height: 600 });
    expect(document.data.cover.url).toMatch(new RegExp(`^${PUBLIC_URL}/media/[a-f0-9]{64}\\.png$`));
    expect(document.data.cover.sizes[0].url.startsWith(`${PUBLIC_URL}/media/`)).toBe(true);
    expect(document.data.body[0].image.url).toBe(document.data.cover.url);
    expect(document.data.intro.html).toBe('<p><strong>Hello &lt;world&gt;</strong></p>');
    expect(document.data.intro.content[0].type).toBe('paragraph');

    const meta = await (await (await api())(get(`/api/v1/media/${media.id}`))).json();
    expect(meta.media).toMatchObject({ id: media.id, mime: 'image/png', alt: 'A cover', url: document.data.cover.url });
  });

  it('lists with limit, cursor, tag and sort', async () => {
    const user = await editor();
    for (const [title, publishedDate, tags] of [
      ['Old', '2024-01-01', ['news']],
      ['New', '2026-01-01', ['news', 'tech']],
      ['Middle', '2025-01-01', ['tech']],
    ] as const) {
      await publishPost(user, { title, publishedDate, tags });
    }
    const handle = await api();
    const titles = async (query: string) => {
      const body = await (await handle(get(`/api/v1/collections/posts/documents${query}`))).json();
      return { titles: body.documents.map((doc: { data: { title: string } }) => doc.data.title), body };
    };

    expect((await titles('')).titles).toEqual(['New', 'Middle', 'Old']);
    const first = await titles('?limit=2');
    expect(first.titles).toEqual(['New', 'Middle']);
    expect(first.body.total).toBe(3);
    const second = await titles(`?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.titles).toEqual(['Old']);
    expect(second.body.nextCursor).toBeNull();
    expect((await titles('?tag=tech')).titles).toEqual(['New', 'Middle']);
    expect((await titles('?sort=title')).titles).toEqual(['Middle', 'New', 'Old']);
    expect((await titles('?sort=-publishedDate&limit=1')).titles).toEqual(['New']);

    for (const query of ['?limit=0', '?limit=101', '?limit=x', '?cursor=nope', '?sort=body', '?sort=password']) {
      expect((await handle(get(`/api/v1/collections/posts/documents${query}`))).status).toBe(400);
    }
    expect((await handle(get('/api/v1/collections/nope/documents'))).status).toBe(404);
  });

  it('answers 301 to the new slug after a rename', async () => {
    const user = await editor();
    const post = await publishPost(user, { title: 'First name' });
    const saved = await genga.documents.saveDraft(user, post.id, { title: 'First name', slug: 'second-name' }, 1);
    await genga.documents.publish(user, post.id, saved.draftRev);
    const response = await (await api())(get('/api/v1/collections/posts/documents/first-name'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/api/v1/collections/posts/documents/second-name');
    expect(await response.json()).toMatchObject({ error: 'moved', slug: 'second-name' });
  });

  it('lists the collections and their fields', async () => {
    const body = await (await (await api())(get('/api/v1/collections'))).json();
    expect(body.collections[0]).toMatchObject({ name: 'posts', path: '/blog/{slug}', titleField: 'title' });
    expect(body.collections[0].fields.cover).toEqual({ type: 'media' });
    expect(body.blocks).toEqual([{ type: 'image', label: 'Image', fields: expect.any(Object) }]);
    expect((await (await api())(get('/api/v1/collections/posts'))).status).toBe(200);
  });

  it('is read-only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await (await api())(get('/api/v1/collections', {}, method))).status).toBe(405);
    }
  });
});

describe('cache headers', () => {
  it('sends an ETag and a 304, and a new ETag after a publish', async () => {
    const user = await editor();
    const post = await publishPost(user, { title: 'Cached' });
    const handle = await api();
    const url = `/api/v1/collections/posts/documents/${post.slug}`;

    const first = await handle(get(url));
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');

    const cached = await handle(get(url, { 'if-none-match': etag!, origin: SITE }));
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(cached.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(cached.headers.get('vary')).toBe('Origin');

    const list = await handle(get('/api/v1/collections/posts/documents'));
    const listTag = list.headers.get('etag')!;
    const saved = await genga.documents.saveDraft(user, post.id, { title: 'Cached again', slug: post.slug }, 1);
    await genga.documents.publish(user, post.id, saved.draftRev);
    const changed = await handle(get(url, { 'if-none-match': etag! }));
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect((await handle(get('/api/v1/collections/posts/documents', { 'if-none-match': listTag }))).status).toBe(200);
  });
});

describe('CORS', () => {
  it('allows only the listed origins', async () => {
    const handle = await api();
    const allowed = await handle(get('/api/v1/collections', { origin: SITE }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(allowed.headers.get('access-control-expose-headers')).toContain('ETag');
    const denied = await handle(get('/api/v1/collections', { origin: 'https://evil.example' }));
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.headers.get('vary')).toBe('Origin');

    const preflight = await handle(
      get(
        '/api/v1/collections',
        { origin: SITE, 'access-control-request-headers': 'if-none-match, x-evil' },
        'OPTIONS',
      ),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('if-none-match');
  });

  it('can allow every origin', async () => {
    const handle = await api({ corsOrigins: '*' });
    const response = await handle(get('/api/v1/collections', { origin: 'https://any.example' }));
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('rate limit', () => {
  it('limits each client address with a token bucket', async () => {
    const handle = await api({ rateLimit: 3 });
    for (let index = 0; index < 3; index += 1) expect((await handle(get('/api/v1/collections'))).status).toBe(200);
    const limited = await handle(get('/api/v1/collections', { origin: SITE }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('access-control-allow-origin')).toBe(SITE);
    expect((await handle(get('/api/v1/collections', { 'x-forwarded-for': '198.51.100.9' }))).status).toBe(200);
    // Spoofed addresses on the left of the trusted hop do not give a new bucket.
    expect((await handle(get('/api/v1/collections', { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).status).toBe(429);
    clock += 20_000;
    expect((await handle(get('/api/v1/collections'))).status).toBe(200);
  });
});

describe('preview', () => {
  it('gives the draft for a valid token only, never cached, to the preview origins only', async () => {
    const user = await editor();
    const post = await genga.documents.create(user, 'posts', { title: 'Draft only', intro: paragraph('Draft text') });
    const other = await genga.documents.create(user, 'posts', { title: 'Other' });
    const token = createPreviewToken(SECRET, post.id, { now: clock });
    const handle = await api();
    const url = (id: string, value: string) => `/api/v1/preview/${id}?token=${encodeURIComponent(value)}`;

    const ok = await handle(get(url(post.id, token), { origin: SITE }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('etag')).toBeNull();
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    const { document } = await ok.json();
    expect(document.data.title).toBe('Draft only');
    expect(document.data.intro.html).toBe('<p><strong>Draft text</strong></p>');

    const evil = await handle(get(url(post.id, token), { origin: 'https://evil.example' }));
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    expect((await handle(get(url(other.id, token)))).status).toBe(401);
    expect((await handle(get(`/api/v1/preview/${post.id}`))).status).toBe(401);
    expect((await handle(get(url(post.id, `${token}x`)))).status).toBe(401);
    clock += 11 * 60_000;
    const expired = await handle(get(url(post.id, token)));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: 'invalid_token' });
  });
});
