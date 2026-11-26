import { describe, expect, it } from 'vitest';
import { createUser, paragraph, request, useGenga } from './helpers';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('documents', () => {
  const ctx = useGenga();

  it('rejects a stale draft_rev with a 409 conflict', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Conflit' });
    const first = await ctx.genga.documents.saveDraft(editor, id, { title: 'Version A', slug: 'conflit' }, 1);
    expect(first.draftRev).toBe(2);
    await expect(
      ctx.genga.documents.saveDraft(editor, id, { title: 'Version B', slug: 'conflit' }, 1),
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      details: { draftRev: 2 },
    });
    await expect(ctx.genga.documents.publish(editor, id, 1)).rejects.toMatchObject({ status: 409 });
  });

  it('labels the author with the name, else the email, also for a disabled account', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const seed = await createUser(ctx.genga, 'editor', 'seed@genga.test');
    await ctx.genga.sql`UPDATE genga_users SET name = '', disabled_at = now() WHERE id = ${seed.id}`;
    const seeded = await ctx.genga.documents.create(seed, 'journal', { title: 'Seed' });
    await ctx.genga.documents.create(editor, 'journal', { title: 'Editor' });
    await ctx.genga.documents.publish(seed, seeded.id, 1);

    const list = await ctx.genga.documents.list(editor, 'journal');
    expect(Object.fromEntries(list.map((doc) => [doc.title, doc.authorName]))).toEqual({
      Seed: 'seed@genga.test',
      Editor: 'editor',
    });
    expect((await ctx.genga.documents.get(editor, seeded.id)).authorName).toBe('seed@genga.test');
    const versions = await ctx.genga.documents.versions(editor, seeded.id);
    expect(versions.map((version) => version.authorName)).toEqual(['seed@genga.test']);
  });

  it('publishes, unpublishes and restores a version', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Premier' });
    const body = [{ _type: 'rich-text', content: paragraph('Bonjour') }];
    let saved = await ctx.genga.documents.saveDraft(editor, id, { title: 'Premier', slug: 'premier', body }, 1);

    await expect(ctx.genga.published.find('journal', 'premier')).resolves.toBeNull();
    const published = await ctx.genga.documents.publish(editor, id, saved.draftRev);
    expect(published.status).toBe('published');
    const live = await ctx.genga.published.find<{ title: string; body: { _id: string }[] }>('journal', 'premier');
    expect(live?.data.title).toBe('Premier');
    expect(live?.data.body[0]._id).toMatch(/[0-9a-f-]{36}/);

    saved = await ctx.genga.documents.saveDraft(
      editor,
      id,
      { title: 'Deuxième', slug: 'premier', body },
      saved.draftRev,
    );
    expect(saved.status).toBe('changed');
    expect((await ctx.genga.published.find<{ title: string }>('journal', 'premier'))?.data.title).toBe('Premier');

    const versions = await ctx.genga.documents.versions(editor, id);
    expect(versions[0]).toMatchObject({ kind: 'published', isPublished: true });
    const restored = await ctx.genga.documents.restore(editor, id, versions[0].id, saved.draftRev);
    expect(restored.draft.title).toBe('Premier');
    expect(restored.draftRev).toBe(saved.draftRev + 1);
    expect((await ctx.genga.documents.versions(editor, id))[0].kind).toBe('restored');

    await ctx.genga.documents.unpublish(editor, id);
    await expect(ctx.genga.published.find('journal', 'premier')).resolves.toBeNull();
  });

  it('refuses to publish a document with a missing required field', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: '' });
    await expect(ctx.genga.documents.publish(editor, id, 1)).rejects.toMatchObject({ status: 422, code: 'invalid' });
  });

  it('writes a redirect when the slug changes after the first publish', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Ancien titre' });
    let saved = await ctx.genga.documents.saveDraft(editor, id, { title: 'Ancien titre', slug: 'ancien' }, 1);
    expect(saved.slug).toBe('ancien');
    await ctx.genga.documents.publish(editor, id, saved.draftRev);

    saved = await ctx.genga.documents.saveDraft(
      editor,
      id,
      { title: 'Nouveau titre', slug: 'nouveau' },
      saved.draftRev,
    );
    expect(saved.slug).toBe('ancien');
    expect(await ctx.genga.published.find('journal', 'nouveau')).toBeNull();

    const published = await ctx.genga.documents.publish(editor, id, saved.draftRev);
    expect(published.slug).toBe('nouveau');
    expect(published.previousSlug).toBe('ancien');
    expect(await ctx.genga.published.redirectFor('journal', 'ancien')).toBe('/journal/nouveau');

    saved = await ctx.genga.documents.saveDraft(editor, id, { title: 'Encore', slug: 'troisieme' }, saved.draftRev);
    await ctx.genga.documents.publish(editor, id, saved.draftRev);
    expect(await ctx.genga.published.redirectFor('journal', 'ancien')).toBe('/journal/troisieme');
    expect(await ctx.genga.published.redirectFor('journal', 'nouveau')).toBe('/journal/troisieme');

    const result = await ctx.genga.published.loadForRoute(
      new Request('http://genga.test/journal/ancien'),
      'journal',
      'ancien',
    );
    expect(result).toMatchObject({ kind: 'redirect', location: '/journal/troisieme' });
  });

  it('rejects reserved and taken slugs', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const a = await ctx.genga.documents.create(editor, 'journal', { title: 'Alpha' });
    const b = await ctx.genga.documents.create(editor, 'journal', { title: 'Beta' });
    const reserved = await ctx.genga.documents.saveDraft(editor, b.id, { title: 'Beta', slug: 'admin' }, 1);
    expect(reserved.slugError).toMatch(/réservé/);
    const taken = await ctx.genga.documents.saveDraft(editor, b.id, { title: 'Beta', slug: a.slug }, reserved.draftRev);
    expect(taken.slugError).toMatch(/déjà utilisé/);
    expect(taken.slug).toBe(b.slug);
  });

  it('unpublishes on delete and frees the slug', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id, slug } = await ctx.genga.documents.create(editor, 'journal', { title: 'Supprimé' });
    await ctx.genga.documents.publish(editor, id, 1);
    expect(await ctx.genga.published.find('journal', slug)).not.toBeNull();
    await ctx.genga.documents.remove(editor, id);
    expect(await ctx.genga.published.find('journal', slug)).toBeNull();
    const again = await ctx.genga.documents.create(editor, 'journal', { title: 'Supprimé' });
    expect(again.slug).toBe(slug);
  });
  it('keeps the old URL as a redirect after unpublish, rename and republish', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Ancien nom' });
    await ctx.genga.documents.publish(editor, id, 1);
    await ctx.genga.documents.unpublish(editor, id);
    const doc = await ctx.genga.documents.get(editor, id);
    expect(doc.publishedSlug).toBe('ancien-nom');
    const saved = await ctx.genga.documents.saveDraft(editor, id, { ...doc.draft, slug: 'nouveau-nom' }, 1);
    expect(saved.slug).toBe('ancien-nom');
    await ctx.genga.documents.publish(editor, id, saved.draftRev);
    const result = await ctx.genga.published.loadForRoute(request('/journal/ancien-nom'), 'journal', 'ancien-nom');
    expect(result).toMatchObject({ kind: 'redirect', location: '/journal/nouveau-nom' });
  });

  async function waitForLockWaiters(count: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [{ waiting }] = await ctx.genga.sql<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if (waiting >= count) return;
      await pause(10);
    }
    throw new Error(`Fewer than ${count} sessions wait for a lock.`);
  }

  it('does not move the live slug when a draft save races the publish', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Course' });
    const doc = await ctx.genga.documents.get(editor, id);
    const release = deferred();
    const locked = deferred();
    const holder = ctx.genga.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM genga_documents WHERE id = ${id} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const publish = ctx.genga.documents.publish(editor, id, 1);
    await waitForLockWaiters(1);
    const save = ctx.genga.documents.saveDraft(editor, id, { ...doc.draft, slug: 'deplace' }, 1);
    await waitForLockWaiters(2);
    release.resolve();
    await holder;
    const [published, saved] = await Promise.allSettled([publish, save]);
    expect(published.status).toBe('fulfilled');
    const [row] = await ctx.genga.sql<{ slug: string }[]>`SELECT slug FROM genga_documents WHERE id = ${id}`;
    expect(row.slug).toBe('course');
    expect(await ctx.genga.published.find('journal', 'course')).not.toBeNull();
    if (saved.status === 'fulfilled') expect(saved.value.slug).toBe('course');
  });

  it('refuses a restore with an old draftRev', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'V1' });
    const version = await ctx.genga.documents.saveVersion(editor, id, 'v1');
    const doc = await ctx.genga.documents.get(editor, id);
    await ctx.genga.documents.saveDraft(editor, id, { ...doc.draft, title: 'Travail récent' }, 1);
    await expect(ctx.genga.documents.restore(editor, id, version.id, 1)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      details: { draftRev: 2 },
    });
    expect((await ctx.genga.documents.get(editor, id)).draft.title).toBe('Travail récent');
  });

  it('keeps the current draft as a version before a restore', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'V1' });
    const version = await ctx.genga.documents.saveVersion(editor, id, 'v1');
    const doc = await ctx.genga.documents.get(editor, id);
    const saved = await ctx.genga.documents.saveDraft(editor, id, { ...doc.draft, title: 'Travail récent' }, 1);
    const restored = await ctx.genga.documents.restore(editor, id, version.id, saved.draftRev);
    expect(restored.draft.title).toBe('V1');
    const [restoredRow, snapshot] = await ctx.genga.sql<{ kind: string; data: { title: string } }[]>`
      SELECT kind, data FROM genga_versions WHERE document_id = ${id} ORDER BY created_at DESC LIMIT 2
    `;
    expect(restoredRow.kind).toBe('restored');
    expect(snapshot).toMatchObject({ kind: 'draft', data: { title: 'Travail récent' } });
  });

  it('answers 404 for ids that are not UUIDs', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Uuid' });
    await expect(ctx.genga.documents.restore(editor, id, 'x', 1)).rejects.toMatchObject({ status: 404 });
    await expect(ctx.genga.documents.get(editor, '-'.repeat(36))).rejects.toMatchObject({ status: 404 });
    await expect(ctx.genga.documents.publish(editor, 'x', 1)).rejects.toMatchObject({ status: 404 });
  });
});
