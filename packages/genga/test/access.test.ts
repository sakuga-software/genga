import { describe, expect, it } from 'vitest';
import { can } from '../src/access';
import { createUser, useGenga } from './helpers';

describe('access matrix', () => {
  const admin = { id: 'a', role: 'admin' as const };
  const editor = { id: 'e', role: 'editor' as const };
  const author = { id: 'w', role: 'author' as const };

  it('gives each role its default rights', () => {
    expect(can(admin, 'users.manage')).toBe(true);
    expect(can(editor, 'users.manage')).toBe(false);
    expect(can(editor, 'publish')).toBe(true);
    expect(can(author, 'publish')).toBe(false);
    expect(can(author, 'create')).toBe(true);
    expect(can(author, 'media.upload')).toBe(true);
    expect(can(author, 'media.delete')).toBe(false);
    expect(can(null, 'read')).toBe(false);
  });

  it('limits an author to its own documents', () => {
    expect(can(author, 'update', undefined, { createdBy: 'w' })).toBe(true);
    expect(can(author, 'update', undefined, { createdBy: 'other' })).toBe(false);
    expect(can(author, 'read', undefined, { createdBy: 'other' })).toBe(false);
    expect(can(editor, 'update', undefined, { createdBy: 'other' })).toBe(true);
  });

  it('applies collection overrides', () => {
    expect(can(editor, 'publish', { publish: ['admin'] })).toBe(false);
    expect(can(admin, 'publish', { publish: ['admin'] })).toBe(true);
    expect(can(editor, 'read', { ownOnly: ['editor'] }, { createdBy: 'other' })).toBe(false);
  });
});

describe('access in the services', () => {
  const ctx = useGenga();

  it('filters the SQL list of an author to its own documents', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const author = await createUser(ctx.genga, 'author');
    await ctx.genga.documents.create(editor, 'journal', { title: 'Écrit par un éditeur' });
    await ctx.genga.documents.create(author, 'journal', { title: 'Écrit par un auteur' });

    const authorList = await ctx.genga.documents.list(author, 'journal');
    expect(authorList.map((doc) => doc.title)).toEqual(['Écrit par un auteur']);
    const editorList = await ctx.genga.documents.list(editor, 'journal');
    expect(editorList).toHaveLength(2);
    const counts = await ctx.genga.documents.counts(author);
    expect(counts.journal.draft).toBe(1);
  });

  it('refuses to an author the documents of others and publication', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const author = await createUser(ctx.genga, 'author');
    const other = await ctx.genga.documents.create(editor, 'journal', { title: 'Autre' });
    const own = await ctx.genga.documents.create(author, 'journal', { title: 'Mien' });

    await expect(ctx.genga.documents.get(author, other.id)).rejects.toMatchObject({ status: 403 });
    await expect(ctx.genga.documents.saveDraft(author, other.id, { title: 'x' }, 1)).rejects.toMatchObject({
      status: 403,
    });
    const doc = await ctx.genga.documents.get(author, own.id);
    expect(doc.canPublish).toBe(false);
    await expect(ctx.genga.documents.publish(author, own.id, doc.draftRev)).rejects.toMatchObject({ status: 403 });
    await expect(ctx.genga.documents.remove(author, own.id)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses the publish action of an author through the HTTP API', async () => {
    const author = await createUser(ctx.genga, 'author', 'writer@genga.test');
    await ctx.genga
      .sql`UPDATE genga_users SET password_hash = ${await (await import('../src/server')).hashPassword('motdepasse-solide')} WHERE id = ${author.id}`;
    const { cookie } = await ctx.genga.auth.login(
      new Request('http://genga.test/admin/login', { method: 'POST' }),
      'writer@genga.test',
      'motdepasse-solide',
    );
    const own = await ctx.genga.documents.create(author, 'journal', { title: 'Mien' });
    const response = await ctx.genga.api(
      new Request(`http://genga.test/admin/api/documents/${own.id}/publish`, {
        method: 'POST',
        headers: { cookie: cookie.split(';')[0], origin: 'http://genga.test', 'content-type': 'application/json' },
        body: JSON.stringify({ draftRev: 1 }),
      }),
      `documents/${own.id}/publish`,
    );
    expect(response.status).toBe(403);
  });
});
