import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, request, useGenga } from './helpers';

describe('public reads and preview', () => {
  const ctx = useGenga();

  async function signedIn(role: 'editor' | 'author') {
    const email = `${crypto.randomUUID()}@genga.test`;
    const user = await createUser(ctx.genga, role, email);
    await ctx.genga
      .sql`UPDATE genga_users SET password_hash = ${await hashPassword('un-mot-de-passe-long')} WHERE id = ${user.id}`;
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    return { user, cookie };
  }

  it('serves the draft in preview to a reader, private and uncached', async () => {
    const { user, cookie } = await signedIn('editor');
    const { id, slug } = await ctx.genga.documents.create(user, 'journal', { title: 'Brouillon secret' });
    const url = `/journal/${slug}?genga-preview=${id}`;

    const anonymous = await ctx.genga.published.loadForRoute(request(url), 'journal', slug);
    expect(anonymous.kind).toBe('not-found');
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(anonymous.headers.get('vary')).toBe('Cookie');

    const preview = await ctx.genga.published.loadForRoute(request(url, { cookie }), 'journal', slug);
    expect(preview).toMatchObject({ kind: 'document', preview: true, doc: { data: { title: 'Brouillon secret' } } });
    expect(preview.headers.get('cache-control')).toBe('private, no-store');

    const wrongRoute = await ctx.genga.published.loadForRoute(
      request(`/journal/autre?genga-preview=${id}`, { cookie }),
      'journal',
      'autre',
    );
    expect(wrongRoute.kind).toBe('not-found');

    const live = await ctx.genga.published.loadForRoute(request(`/journal/${slug}`), 'journal', slug);
    expect(live.kind).toBe('not-found');
  });

  it('refuses the preview of another author document', async () => {
    const editor = await signedIn('editor');
    const author = await signedIn('author');
    const { id, slug } = await ctx.genga.documents.create(editor.user, 'journal', { title: 'Pas à toi' });
    const result = await ctx.genga.published.loadForRoute(
      request(`/journal/${slug}?genga-preview=${id}`, { cookie: author.cookie }),
      'journal',
      slug,
    );
    expect(result.kind).toBe('not-found');
  });

  it('sends an ETag from the version and refreshes the cache at publish', async () => {
    const { user } = await signedIn('editor');
    const { id, slug } = await ctx.genga.documents.create(user, 'journal', {
      title: 'Un',
      publishedDate: '2026-01-01',
    });
    const first = await ctx.genga.documents.publish(user, id, 1);
    const live = await ctx.genga.published.loadForRoute(request(`/journal/${slug}`), 'journal', slug);
    expect(live.headers.get('etag')).toMatch(new RegExp(`^"${first.versionId}\\.[0-9a-z]+"$`));
    expect(live.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect((await ctx.genga.published.list('journal')).map((doc) => doc.slug)).toEqual([slug]);

    const saved = await ctx.genga.documents.saveDraft(
      user,
      id,
      { title: 'Deux', slug, publishedDate: '2026-01-01' },
      1,
    );
    await ctx.genga.documents.publish(user, id, saved.draftRev);
    expect((await ctx.genga.published.find<{ title: string }>('journal', slug))?.data.title).toBe('Deux');
    expect((await ctx.genga.published.list<{ title: string }>('journal'))[0].data.title).toBe('Deux');
  });

  it('sorts the public list by the sort field, newest first', async () => {
    const { user } = await signedIn('editor');
    for (const [title, publishedDate] of [
      ['Vieux', '2024-05-01'],
      ['Récent', '2026-05-01'],
      ['Milieu', '2025-05-01'],
    ]) {
      const { id } = await ctx.genga.documents.create(user, 'journal', { title, publishedDate });
      await ctx.genga.documents.publish(user, id, 1);
    }
    const titles = (await ctx.genga.published.list<{ title: string }>('journal')).map((doc) => doc.data.title);
    expect(titles).toEqual(['Récent', 'Milieu', 'Vieux']);
    expect(await ctx.genga.published.list('journal', { limit: 1 })).toHaveLength(1);
  });
});

describe('public list order', () => {
  const ctx = useGenga();

  it('sorts numbers newest first and breaks ties by title', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { createGenga } = await import('../src/server');
    const { defineConfig, number, slug, text } = await import('../src');
    const config = defineConfig({
      collections: {
        projects: {
          label: 'Projets',
          labelSingular: 'Projet',
          titleField: 'title',
          sortField: 'year',
          path: (value) => `/projects/${value}`,
          fields: { title: text({ required: true }), slug: slug(), year: number() },
        },
      },
      blocks: [],
    });
    const genga = createGenga(config, { databaseUrl: TEST_URL, siteUrl: 'http://genga.test', mediaDir: ctx.mediaDir });
    try {
      for (const [title, year] of [
        ['Plai', 2025],
        ['Ancien', 2023],
        ['Suricarte', 2025],
        ['Récent', 2026],
      ] as const) {
        const { id } = await genga.documents.create(editor, 'projects', { title, year });
        await genga.documents.publish(editor, id, 1);
      }
      const titles = (await genga.published.list<{ title: string }>('projects')).map((doc) => doc.data.title);
      expect(titles).toEqual(['Récent', 'Plai', 'Suricarte', 'Ancien']);
    } finally {
      await genga.close();
    }
  });
});
