import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig, media, relation, slug, text } from '../src';
import { createGenga, type Genga } from '../src/server';
import type { PublicUser } from '../src/types';
import { TEST_URL } from './global-setup';
import { createUser, pngFile, request, SITE, useGenga } from './helpers';

const config = defineConfig({
  collections: {
    authors: {
      label: 'Auteurs',
      labelSingular: 'Auteur',
      titleField: 'name',
      path: (value) => `/auteurs/${value}`,
      fields: {
        name: text({ required: true }),
        slug: slug({ from: 'name' }),
        photo: media(),
        mentor: relation({ to: 'authors' }),
      },
    },
    posts: {
      label: 'Articles',
      labelSingular: 'Article',
      titleField: 'title',
      path: (value) => `/blog/${value}`,
      fields: {
        title: text({ required: true }),
        slug: slug({ from: 'title' }),
        author: relation({ to: 'authors', required: true }),
        related: relation({ to: 'posts', multiple: true, maxItems: 3 }),
      },
    },
  },
  blocks: [],
});

describe('relation fields', () => {
  const ctx = useGenga();
  let genga: Genga;
  let editor: PublicUser;

  beforeAll(async () => {
    genga = createGenga(config, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      mediaDir: ctx.mediaDir,
      secureCookies: false,
      publicApi: true,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    await genga.ready();
  });

  afterAll(async () => {
    await genga.close();
  });

  async function setup() {
    editor = await createUser(genga, 'editor');
  }

  async function createPublished(collection: string, data: Record<string, unknown>) {
    const { id } = await genga.documents.create(editor, collection, data);
    await genga.documents.publish(editor, id, 1);
    return id;
  }

  async function edit(id: string, data: Record<string, unknown>) {
    const doc = await genga.documents.get(editor, id);
    return genga.documents.saveDraft(editor, id, { ...doc.draft, ...data }, doc.draftRev);
  }

  it('refuses a relation to an unknown collection at start', () => {
    expect(() =>
      defineConfig({
        collections: {
          posts: {
            label: 'A',
            labelSingular: 'A',
            titleField: 'title',
            path: (value) => `/${value}`,
            fields: { title: text(), slug: slug(), author: relation({ to: 'people' }) },
          },
        },
        blocks: [],
      }),
    ).toThrow('points to an unknown collection "people"');
  });

  it('resolves published targets only, with their media, and keeps their own relations as references', async () => {
    await setup();
    const upload = await genga.media.upload(editor, await pngFile(), 'Portrait');
    const mentor = await createPublished('authors', { name: 'Mentor' });
    const ada = await createPublished('authors', { name: 'Ada', photo: upload.media.id, mentor });
    await edit(ada, { name: 'Ada (brouillon)' });
    const { id: hidden } = await genga.documents.create(editor, 'authors', { name: 'Jamais publiée' });
    const post = await createPublished('posts', { title: 'Hello', author: ada, related: [] });
    const other = await createPublished('posts', { title: 'Autre', author: ada, related: [post] });

    const doc = await genga.published.find<{ author: any; related: any[] }>('posts', 'hello');
    expect(doc?.data.author).toMatchObject({
      id: ada,
      collection: 'authors',
      slug: 'ada',
      path: '/auteurs/ada',
      title: 'Ada',
      data: {
        name: 'Ada',
        photo: { id: upload.media.id, alt: 'Portrait' },
        mentor: { id: mentor, collection: 'authors' },
      },
    });
    expect(doc?.data.author.data.mentor).toEqual({ id: mentor, collection: 'authors' });

    const otherDoc = await genga.published.findById<{ related: any[] }>(other);
    expect(otherDoc?.data.related.map((item) => item.id)).toEqual([post]);

    // A draft target is left out of a multiple relation, and gives null in a single one.
    await edit(post, { author: hidden });
    const preview = await genga.published.draft<{ author: unknown }>(post);
    expect(preview?.data.author).toBeNull();
  });

  it('gives the previewed draft the published targets, not their drafts', async () => {
    await setup();
    const ada = await createPublished('authors', { name: 'Ada' });
    await edit(ada, { name: 'Ada (brouillon)' });
    const post = await createPublished('posts', { title: 'Hello', author: ada });
    await edit(post, { title: 'Hello (brouillon)' });
    const cookie = await genga.auth.createSession(editor.id, request('/'));
    const result = await genga.published.loadForRoute<{ title: string; author: { title: string } }>(
      request(`/blog/hello?genga-preview=${post}`, { cookie }),
      'posts',
      'hello',
    );
    expect(result.kind).toBe('document');
    if (result.kind !== 'document') return;
    expect(result.doc.data.title).toBe('Hello (brouillon)');
    expect(result.doc.data.author.title).toBe('Ada');
  });

  it('refreshes the cache, the event tags and the ETag when a target changes', async () => {
    await setup();
    const ada = await createPublished('authors', { name: 'Ada' });
    await createPublished('posts', { title: 'Hello', author: ada });
    const first = await genga.published.loadForRoute<{ author: { title: string } }>(
      request('/blog/hello'),
      'posts',
      'hello',
    );
    expect(first.kind === 'document' && first.doc.data.author.title).toBe('Ada');
    const firstEtag = first.headers.get('etag');

    const { draftRev } = await edit(ada, { name: 'Ada Lovelace' });
    await genga.documents.publish(editor, ada, draftRev);
    const second = await genga.published.loadForRoute<{ author: { title: string } }>(
      request('/blog/hello'),
      'posts',
      'hello',
    );
    expect(second.kind === 'document' && second.doc.data.author.title).toBe('Ada Lovelace');
    expect(second.headers.get('etag')).not.toBe(firstEtag);

    const [event] = await genga.sql<{ event: { tags: string[] } }[]>`
      SELECT event FROM genga_events WHERE event->>'documentId' = ${ada} ORDER BY seq DESC LIMIT 1
    `;
    expect(event.event.tags).toContain('genga:c:posts');

    const api = await genga.handle(request('/api/v1/collections/posts/documents/hello'));
    const body = (await api?.json()) as { document: { data: { author: { data: { name: string } } } } };
    expect(body.document.data.author.data.name).toBe('Ada Lovelace');
  });

  it('gives absolute media URLs inside a target in the public API', async () => {
    await setup();
    const upload = await genga.media.upload(editor, await pngFile(), 'Portrait');
    const ada = await createPublished('authors', { name: 'Ada', photo: upload.media.id });
    await createPublished('posts', { title: 'Hello', author: ada });
    const api = await genga.handle(request('/api/v1/collections/posts/documents/hello'));
    const body = (await api?.json()) as { document: { data: { author: { data: { photo: { url: string } } } } } };
    expect(body.document.data.author.data.photo.url.startsWith(`${SITE}/media/`)).toBe(true);
  });

  it('refuses to publish a relation to a deleted document or to another collection', async () => {
    await setup();
    const ada = await createPublished('authors', { name: 'Ada' });
    const otherPost = await createPublished('posts', { title: 'Autre', author: ada });
    const { id } = await genga.documents.create(editor, 'posts', { title: 'Hello', author: otherPost });
    await expect(genga.documents.publish(editor, id, 1)).rejects.toMatchObject({
      status: 422,
      code: 'missing_relation',
    });

    const { draftRev } = await edit(id, { author: ada });
    await genga.documents.remove(editor, ada);
    await expect(genga.documents.publish(editor, id, draftRev)).rejects.toMatchObject({ code: 'missing_relation' });
  });

  it('validates the ids: uuid, no duplicate, max items, required at publish', async () => {
    await setup();
    const ada = await createPublished('authors', { name: 'Ada' });
    await expect(genga.documents.create(editor, 'posts', { title: 'X', author: 'ada' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(genga.documents.create(editor, 'posts', { title: 'X', related: [ada, ada] })).rejects.toMatchObject({
      status: 400,
    });
    const { id } = await genga.documents.create(editor, 'posts', { title: 'Sans auteur' });
    await expect(genga.documents.publish(editor, id, 1)).rejects.toMatchObject({ status: 422, code: 'invalid' });
  });

  it('lists the readable documents and the published ones, and keeps the drafts of others private', async () => {
    await setup();
    const author = await createUser(genga, 'author');
    await createPublished('posts', {
      title: 'Publié par un éditeur',
      author: await createPublished('authors', { name: 'A' }),
    });
    const { id: secret } = await genga.documents.create(editor, 'posts', { title: 'Brouillon secret' });
    const { id: mine } = await genga.documents.create(author, 'posts', { title: 'Mon brouillon' });

    const cookie = (await genga.auth.createSession(author.id, request('/'))).split(';')[0];
    const list = async (params: string) => {
      const response = await genga.handle(
        request(`/admin/api/relations?collection=posts&${params}`, { headers: { cookie } }),
      );
      return ((await response?.json()) as { options: { id: string; title: string; status: string }[] }).options;
    };
    const titles = (await list('q=')).map((option) => option.title).sort();
    expect(titles).toEqual(['Mon brouillon', 'Publié par un éditeur']);
    expect(await list('q=secret')).toEqual([]);
    expect(await list(`ids=${secret},${mine}`)).toMatchObject([{ id: mine, title: 'Mon brouillon', status: 'draft' }]);
  });
});
