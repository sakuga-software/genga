import { describe, expect, it } from 'vitest';
import { createGenga, localStorageAdapter, MEDIA_KEY_PATTERN, type StorageAdapter } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, pngFile, SITE, testConfig, useGenga } from './helpers';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

describe('media', () => {
  const ctx = useGenga();

  it('rejects SVG and HTML files renamed as PNG', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], 'logo.png', {
      type: 'image/png',
    });
    const html = new File(['<!doctype html><html><body><script>alert(1)</script></body></html>'], 'photo.png', {
      type: 'image/png',
    });
    await expect(ctx.genga.media.upload(editor, svg)).rejects.toMatchObject({ status: 415 });
    await expect(ctx.genga.media.upload(editor, html)).rejects.toMatchObject({ status: 415 });
  });

  it('stores an image with sizes, then deduplicates the same bytes', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const file = await pngFile('cover.png');
    const first = await ctx.genga.media.upload(editor, file, 'Une couverture');
    expect(first.deduplicated).toBe(false);
    expect(first.media).toMatchObject({ mime: 'image/png', width: 1200, height: 600, alt: 'Une couverture' });
    expect(first.media.sizes.map((size) => size.width)).toEqual([480, 960]);
    expect(first.media.url.replace('/media/', '')).toMatch(MEDIA_KEY_PATTERN);

    const second = await ctx.genga.media.upload(editor, await pngFile('copy.png'));
    expect(second.deduplicated).toBe(true);
    expect(second.media.id).toBe(first.media.id);

    const served = await ctx.genga.media.serve(first.media.url.replace('/media/', ''));
    expect(served.status).toBe(200);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect((await ctx.genga.media.serve('../../etc/passwd')).status).toBe(404);
    expect((await ctx.genga.media.serve(`${'a'.repeat(64)}.png`)).status).toBe(404);
  });

  it('refuses to delete a media that a draft or a published version references', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { media } = await ctx.genga.media.upload(editor, await pngFile('used.png', { r: 1, g: 2, b: 3 }));
    const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Avec image', cover: media.id });
    await expect(ctx.genga.media.remove(editor, media.id)).rejects.toMatchObject({ status: 409, code: 'media_in_use' });

    await ctx.genga.documents.publish(editor, id, 1);
    const saved = await ctx.genga.documents.saveDraft(
      editor,
      id,
      { title: 'Avec image', slug: 'avec-image', cover: null },
      1,
    );
    expect(saved.status).toBe('changed');
    await expect(ctx.genga.media.remove(editor, media.id)).rejects.toMatchObject({ code: 'media_in_use' });

    await ctx.genga.documents.unpublish(editor, id);
    await ctx.genga.media.remove(editor, media.id);
    expect((await ctx.genga.media.serve(media.url.replace('/media/', ''))).status).toBe(404);
  });

  it('reads a published document whose media row is gone', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { media } = await ctx.genga.media.upload(editor, await pngFile('gone.png', { r: 9, g: 9, b: 9 }));
    const { id, slug } = await ctx.genga.documents.create(editor, 'journal', { title: 'Orphelin', cover: media.id });
    await ctx.genga.documents.publish(editor, id, 1);
    await ctx.genga.sql`DELETE FROM genga_media WHERE id = ${media.id}`;
    const found = await ctx.genga.published.find<{ cover: unknown }>('journal', slug);
    expect(found?.data.cover).toBeNull();
  });

  it('refuses to publish a document that references a missing media', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id } = await ctx.genga.documents.create(editor, 'journal', {
      title: 'Lien mort',
      cover: crypto.randomUUID(),
    });
    await expect(ctx.genga.documents.publish(editor, id, 1)).rejects.toMatchObject({ status: 422 });
  });

  it('lets only the owner or a publisher change the alt text', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const author = await createUser(ctx.genga, 'author');
    const { media } = await ctx.genga.media.upload(editor, await pngFile('alt.png', { r: 7, g: 7, b: 7 }), 'Original');
    await expect(ctx.genga.media.updateAlt(author, media.id, 'Changé')).rejects.toMatchObject({ status: 403 });
    const own = await ctx.genga.media.upload(author, await pngFile('own.png', { r: 8, g: 8, b: 8 }));
    await expect(ctx.genga.media.updateAlt(author, own.media.id, 'Le mien')).resolves.toMatchObject({ alt: 'Le mien' });
    await expect(ctx.genga.media.updateAlt(editor, own.media.id, 'Relu')).resolves.toMatchObject({ alt: 'Relu' });
  });

  it('answers 404 for media ids that are not UUIDs', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    await expect(ctx.genga.media.updateAlt(admin, 'x', 'alt')).rejects.toMatchObject({ status: 404 });
    await expect(ctx.genga.media.remove(admin, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the files of a media that is uploaded again during its delete', async () => {
    const base = localStorageAdapter(ctx.mediaDir);
    const reached = deferred();
    const gate = deferred();
    const paused: StorageAdapter = {
      ...base,
      async delete(key) {
        reached.resolve();
        await gate.promise;
        return base.delete(key);
      },
    };
    const genga = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      storage: paused,
      secureCookies: false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const editor = await createUser(genga, 'editor');
      const file = () => pngFile('again.png', { r: 3, g: 3, b: 3 });
      const { media } = await genga.media.upload(editor, await file());
      const removing = genga.media.remove(editor, media.id);
      await reached.promise;
      const uploading = genga.media.upload(editor, await file());
      await new Promise((resolve) => setTimeout(resolve, 100));
      gate.resolve();
      await removing;
      const again = await uploading;
      expect((await genga.media.serve(again.media.url.replace('/media/', ''))).status).toBe(200);
    } finally {
      await genga.close();
    }
  });

  it('refuses media delete to an author', async () => {
    const author = await createUser(ctx.genga, 'author');
    const { media } = await ctx.genga.media.upload(author, await pngFile('author.png', { r: 4, g: 5, b: 6 }));
    await expect(ctx.genga.media.remove(author, media.id)).rejects.toMatchObject({ status: 403 });
  });
});
