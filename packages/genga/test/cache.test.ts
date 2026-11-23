import { describe, expect, it } from 'vitest';
import { PublishedCache } from '../src/server/cache';
import { createUser, pngFile, useGenga } from './helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('published cache', () => {
  it('does not keep a value that a load started before the invalidation', async () => {
    const cache = new PublishedCache();
    const load = deferred<string>();
    const pending = cache.get('journal', 'doc:a', () => load.promise);
    cache.invalidate('journal');
    load.resolve('old');
    await expect(pending).resolves.toBe('old');
    await expect(cache.get('journal', 'doc:a', async () => 'new')).resolves.toBe('new');
  });

  it('does not answer with an entry from before the invalidation when the database fails', async () => {
    const cache = new PublishedCache();
    await cache.get('journal', 'doc:a', async () => 'old');
    cache.invalidate('journal');
    await expect(
      cache.get('journal', 'doc:a', async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow('down');
  });

  it('keeps a stale entry for a database failure when no invalidation happened', async () => {
    let now = 0;
    const cache = new PublishedCache({ now: () => now });
    await cache.get('journal', 'doc:a', async () => 'value');
    now += 10 * 60_000;
    await expect(
      cache.get('journal', 'doc:a', async () => {
        throw new Error('down');
      }),
    ).resolves.toBe('value');
  });

  it('keeps the published entries when many unknown slugs are asked', async () => {
    const cache = new PublishedCache();
    let loads = 0;
    await cache.get('journal', 'doc:real', async () => {
      loads += 1;
      return { title: 'Réel' };
    });
    for (let index = 0; index < 5_000; index += 1) {
      await cache.get('journal', `doc:missing-${index}`, async () => null);
    }
    await cache.get('journal', 'doc:real', async () => {
      loads += 1;
      return { title: 'Réel' };
    });
    expect(loads).toBe(1);
  });
});

describe('published cache with the database', () => {
  const ctx = useGenga();

  it('stops to serve a document that a reader loaded during its unpublish', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { media } = await ctx.genga.media.upload(editor, await pngFile(), 'alt');
    const doc = await ctx.genga.documents.create(editor, 'journal', { title: 'Course', cover: media.id });
    await ctx.genga.documents.publish(editor, doc.id, 1);

    const lock = deferred<void>();
    const locked = deferred<void>();
    const holder = ctx.genga.sql.begin(async (tx) => {
      await tx`LOCK TABLE genga_media IN ACCESS EXCLUSIVE MODE`;
      locked.resolve();
      await lock.promise;
    });
    await locked.promise;
    const reader = ctx.genga.published.find('journal', doc.slug);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.genga.documents.unpublish(editor, doc.id);
    lock.resolve();
    await holder;
    await reader;
    expect(await ctx.genga.published.find('journal', doc.slug)).toBeNull();
  });
});
