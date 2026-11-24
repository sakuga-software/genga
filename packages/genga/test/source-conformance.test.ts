import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteSource, GengaSourceError, type GengaSource } from '../src/remote';
import { createGenga, createPreviewToken, type Genga } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, paragraph, pngFile, SITE, testConfig } from './helpers';

const SECRET = 'a-preview-secret-that-is-long-enough-for-hmac';

let genga: Genga;
let mediaDir: string;

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-source-'));
  genga = createGenga(testConfig, {
    databaseUrl: TEST_URL,
    siteUrl: SITE,
    mediaDir,
    secureCookies: false,
    previewSecret: SECRET,
    publicApi: { rateLimit: 100_000 },
    logger: { info: () => {}, warn: () => {}, error: console.error },
  });
  await genga.ready();
});

afterAll(async () => {
  await genga.close();
  await rm(mediaDir, { recursive: true, force: true });
});

/** The remote source, with `fetch` answered by `genga.handle` in this process. */
const calls: { url: string; tags: string[]; preview: boolean }[] = [];
const remote = createRemoteSource({
  url: SITE,
  fetch: async (url, init, hints) => {
    calls.push({ url, ...hints });
    return (await genga.handle(new Request(url, init))) ?? new Response(null, { status: 404 });
  },
});

type Fixture = {
  cookie: string;
  draftId: string;
  draftSlug: string;
  liveId: string;
  renamedId: string;
  mediaUrl: string;
};

let fixture: Fixture;

beforeEach(async () => {
  await genga.sql`TRUNCATE genga_events, genga_media, genga_redirects, genga_versions, genga_documents, genga_sessions, genga_users CASCADE`;
  const user = await createUser(genga, 'editor');
  const cookie = (await genga.auth.createSession(user.id, new Request(SITE))).split(';')[0];
  const { media } = await genga.media.upload(user, await pngFile('source.png', { r: 10, g: 20, b: 30 }), 'Alt');
  const publish = async (data: Record<string, unknown>) => {
    const created = await genga.documents.create(user, 'journal', data);
    await genga.documents.publish(user, created.id, 1);
    return created;
  };
  const live = await publish({
    title: 'Live',
    publishedDate: '2026-01-02',
    tags: ['news'],
    cover: media.id,
    excerpt: 'Short',
    body: [{ _id: 'b1', _type: 'rich-text', content: paragraph('Hello <world>') }],
  });
  await publish({ title: 'Older', publishedDate: '2025-01-02', tags: ['news'] });
  await publish({ title: 'Oldest', publishedDate: '2024-01-02' });
  const renamed = await publish({ title: 'First name', publishedDate: '2023-01-02' });
  const saved = await genga.documents.saveDraft(
    user,
    renamed.id,
    { title: 'First name', slug: 'second-name', publishedDate: '2023-01-02' },
    1,
  );
  await genga.documents.publish(user, renamed.id, saved.draftRev);
  const draft = await genga.documents.create(user, 'journal', { title: 'Draft only' });
  fixture = {
    cookie,
    draftId: draft.id,
    draftSlug: draft.slug,
    liveId: live.id,
    renamedId: renamed.id,
    mediaUrl: media.url,
  };
});

const sources: [string, () => GengaSource][] = [
  ['embedded', () => genga],
  ['remote', () => remote],
];

/** The preview credentials of each mode: the session cookie on the same origin, a token on another. */
function previewRequest(mode: string, id: string, slug: string) {
  const url = new URL(`/journal/${slug}`, SITE);
  url.searchParams.set('genga-preview', id);
  if (mode === 'remote') url.searchParams.set('genga-token', createPreviewToken(SECRET, id));
  return new Request(url, { headers: mode === 'embedded' ? { cookie: fixture.cookie } : {} });
}

describe.each(sources)('GengaSource (%s)', (mode, source) => {
  it('has its mode and the tags of the events', () => {
    expect(source().mode).toBe(mode);
    expect(source().tagsFor('journal')).toEqual(['genga', 'genga:c:journal']);
    expect(source().tagsFor('journal', 'live')).toEqual(['genga', 'genga:c:journal', 'genga:d:journal:live']);
  });

  it('reads a published document in the public shape', async () => {
    const doc = await source().getDocument<{ title: string; cover: { url: string } }>('journal', 'live');
    expect(doc).toMatchObject({ id: fixture.liveId, slug: 'live', path: '/journal/live', data: { title: 'Live' } });
    expect(doc?.data.cover.url).toBe(`${SITE}${fixture.mediaUrl}`);
    expect((doc?.data as unknown as { body: { content: { html: string } }[] }).body[0].content.html).toBe(
      '<p>Hello &lt;world&gt;</p>',
    );
  });

  it('gives null for a draft, an old slug, a missing slug and an unknown collection', async () => {
    expect(await source().getDocument('journal', fixture.draftSlug)).toBeNull();
    expect(await source().getDocument('journal', 'first-name')).toBeNull();
    expect(await source().getDocument('journal', 'nope')).toBeNull();
    expect(await source().getDocument('nope', 'live')).toBeNull();
  });

  it('lists with limit, cursor, tag and sort', async () => {
    const titles = (page: { documents: { data: unknown }[] }) =>
      page.documents.map((doc) => (doc.data as { title: string }).title);
    const first = await source().listDocuments('journal', { limit: 2 });
    expect(titles(first)).toEqual(['Live', 'Older']);
    expect(first.total).toBe(4);
    expect(titles(await source().listDocuments('journal', { limit: 2, cursor: first.nextCursor }))).toEqual([
      'Oldest',
      'First name',
    ]);
    expect(titles(await source().listDocuments('journal', { tag: 'news' }))).toEqual(['Live', 'Older']);
    expect(titles(await source().listDocuments('journal', { sort: 'title', limit: 1 }))).toEqual(['First name']);
  });

  it('throws the same errors', async () => {
    for (const [collection, query, status] of [
      ['journal', { limit: 0 }, 400],
      ['journal', { sort: 'body' }, 400],
      ['journal', { cursor: 'nope' }, 400],
      ['nope', {}, 404],
    ] as const) {
      const error = await source()
        .listDocuments(collection, query)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GengaSourceError);
      expect(error).toMatchObject({ status, code: status === 400 ? 'bad_request' : 'not_found' });
    }
  });

  it('resolves a published route with its tags, ETag and cache headers', async () => {
    const result = await source().resolveRoute(new Request(`${SITE}/journal/live`), 'journal', 'live');
    if (result.kind !== 'document') throw new Error(`Expected a document, got ${result.kind}`);
    expect(result.preview).toBe(false);
    expect(result.doc.id).toBe(fixture.liveId);
    expect(result.cache).toEqual({
      tags: ['genga', 'genga:c:journal', 'genga:d:journal:live'],
      etag: `"${result.doc.versionId}"`,
    });
    expect(result.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(result.headers.get('etag')).toBe(`"${result.doc.versionId}"`);
  });

  it('resolves a renamed slug to a 301 with the tags of both slugs', async () => {
    const result = await source().resolveRoute(new Request(`${SITE}/journal/first-name`), 'journal', 'first-name');
    expect(result).toMatchObject({
      kind: 'redirect',
      location: '/journal/second-name',
      status: 301,
      cache: { tags: ['genga', 'genga:c:journal', 'genga:d:journal:second-name', 'genga:d:journal:first-name'] },
    });
  });

  it('resolves a missing route to not found, with its tags', async () => {
    const result = await source().resolveRoute(new Request(`${SITE}/journal/nope`), 'journal', 'nope');
    expect(result).toMatchObject({
      kind: 'not-found',
      cache: { tags: ['genga', 'genga:c:journal', 'genga:d:journal:nope'] },
    });
    expect(result.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  it('gives the draft of a valid preview, never cached and with no referrer', async () => {
    const result = await source().resolveRoute(
      previewRequest(mode, fixture.draftId, fixture.draftSlug),
      'journal',
      fixture.draftSlug,
    );
    expect(result).toMatchObject({
      kind: 'document',
      preview: true,
      cache: 'no-store',
      doc: { id: fixture.draftId, versionId: null, data: { title: 'Draft only' } },
    });
    for (const [name, value] of [
      ['cache-control', 'private, no-store'],
      ['vary', 'Cookie'],
      ['referrer-policy', 'no-referrer'],
      ['x-robots-tag', 'noindex'],
    ]) {
      expect(result.headers.get(name)).toBe(value);
    }
  });

  it('takes a PreviewInput as well as a Request', async () => {
    const credentials =
      mode === 'remote' ? { token: createPreviewToken(SECRET, fixture.draftId) } : { cookie: fixture.cookie };
    const result = await source().resolveRoute(
      { documentId: fixture.draftId, ...credentials },
      'journal',
      fixture.draftSlug,
    );
    expect(result).toMatchObject({ kind: 'document', preview: true });
  });

  it('refuses a preview for another route, another collection, or without credentials', async () => {
    const wrongSlug = await source().resolveRoute(previewRequest(mode, fixture.draftId, 'live'), 'journal', 'live');
    expect(wrongSlug).toMatchObject({ kind: 'not-found', cache: 'no-store' });
    expect(wrongSlug.headers.get('referrer-policy')).toBe('no-referrer');
    const wrongCollection = await source().resolveRoute(
      previewRequest(mode, fixture.draftId, fixture.draftSlug),
      'other',
      fixture.draftSlug,
    );
    expect(wrongCollection.kind).toBe('not-found');
    const bare = await source().resolveRoute(
      new Request(`${SITE}/journal/${fixture.draftSlug}?genga-preview=${fixture.draftId}`),
      'journal',
      fixture.draftSlug,
    );
    expect(bare).toMatchObject({ kind: 'not-found', cache: 'no-store' });
    const forged = await source().resolveRoute(
      {
        documentId: fixture.draftId,
        token: createPreviewToken('another-secret-that-is-long-enough!!', fixture.draftId),
      },
      'journal',
      fixture.draftSlug,
    );
    expect(forged.kind).toBe('not-found');
  });

  it('reads a draft with a token only', async () => {
    const doc = await source().getDraft(fixture.draftId, createPreviewToken(SECRET, fixture.draftId));
    expect(doc).toMatchObject({ id: fixture.draftId, versionId: null, path: `/journal/${fixture.draftSlug}` });
    expect(await source().getDraft(fixture.draftId, createPreviewToken(SECRET, fixture.liveId))).toBeNull();
    expect(await source().getDraft(fixture.draftId, 'nope')).toBeNull();
  });

  it('lists the sitemap', async () => {
    const entries = await source().sitemap();
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      '/journal/live',
      '/journal/older',
      '/journal/oldest',
      '/journal/second-name',
    ]);
    expect(entries.every((entry) => typeof entry.lastModified === 'string')).toBe(true);
  });
});

describe('the two sources', () => {
  it('give the same results', async () => {
    const both = async <T>(read: (source: GengaSource) => Promise<T>) => {
      const [embedded, fromRemote] = await Promise.all([read(genga), read(remote)]);
      expect(fromRemote).toEqual(embedded);
    };
    await both((source) => source.getDocument('journal', 'live'));
    await both((source) => source.listDocuments('journal', { limit: 3, sort: '-publishedAt' }));
    await both((source) => source.sitemap());
    await both((source) => source.getDraft(fixture.draftId, createPreviewToken(SECRET, fixture.draftId)));
    const route = (source: GengaSource) =>
      source.resolveRoute(new Request(`${SITE}/journal/live`), 'journal', 'live').then(({ headers, ...rest }) => ({
        ...rest,
        headers: Object.fromEntries(headers),
      }));
    await both(route);
  });

  it('gives cache hints to the fetch of the remote source', async () => {
    calls.length = 0;
    await remote.getDocument('journal', 'live');
    await remote.getDraft(fixture.draftId, createPreviewToken(SECRET, fixture.draftId));
    expect(calls.map(({ tags, preview }) => ({ tags, preview }))).toEqual([
      { tags: ['genga', 'genga:c:journal', 'genga:d:journal:live'], preview: false },
      { tags: [], preview: true },
    ]);
  });

  it('finds a renamed slug with a fetch that follows redirects', async () => {
    const following = createRemoteSource({
      url: SITE,
      fetch: async (url, init) => {
        let response = (await genga.handle(new Request(url, init))) ?? new Response(null, { status: 404 });
        const location = response.headers.get('location');
        if (response.status === 301 && location) {
          response = (await genga.handle(new Request(new URL(location, SITE), init))) as Response;
        }
        return response;
      },
    });
    expect(await following.getDocument('journal', 'first-name')).toBeNull();
    expect(
      await following.resolveRoute(new Request(`${SITE}/journal/first-name`), 'journal', 'first-name'),
    ).toMatchObject({ kind: 'redirect', location: '/journal/second-name', status: 301 });
    expect(await following.getDocument('journal', 'live')).toMatchObject({ slug: 'live' });
  });

  it('tags the sitemap with the collections of the schema, so a publish invalidates it', async () => {
    const hints: string[][] = [];
    const withSchema = createRemoteSource({
      url: SITE,
      schema: testConfig,
      fetch: async (url, init, { tags }) => {
        hints.push(tags);
        return (await genga.handle(new Request(url, init))) as Response;
      },
    });
    await withSchema.sitemap();
    expect(hints).toEqual([['genga', 'genga:c:journal']]);
  });

  it('refuses a url that is not an origin', () => {
    expect(() => createRemoteSource({ url: 'not a url' })).toThrow(/origin/);
  });
});
