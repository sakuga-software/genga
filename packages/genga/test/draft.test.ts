import { describe, expect, it, vi } from 'vitest';
import { blockedNavigation, flushDraft, KEEPALIVE_MAX_BYTES } from '../src/admin/editor/draft-flush';

describe('draft flush', () => {
  it('sends the last draft with keepalive, so the request outlives the page', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    await flushDraft('doc-1', { title: 'Encore' }, 4, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/admin/api/documents/doc-1/draft');
    expect(init).toMatchObject({ method: 'PUT', keepalive: true, credentials: 'same-origin' });
    expect(JSON.parse(String(init.body))).toEqual({ data: { title: 'Encore' }, draftRev: 4 });
  });

  it('drops keepalive for a body over the browser limit', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    await flushDraft('doc-1', { body: 'x'.repeat(KEEPALIVE_MAX_BYTES) }, 1, fetcher);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBe(false);
  });

  it('swallows a network failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(flushDraft('doc-1', {}, 1, fetcher)).resolves.toBe(false);
  });
});

describe('blocked navigation', () => {
  it('saves first, and asks only when the save failed or conflicts', () => {
    expect(blockedNavigation('dirty')).toBe('save');
    expect(blockedNavigation('saving')).toBe('save');
    expect(blockedNavigation('error')).toBe('ask');
    expect(blockedNavigation('conflict')).toBe('ask');
  });
});
