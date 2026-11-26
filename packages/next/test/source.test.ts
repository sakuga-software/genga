import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteSource } from '../src/source';

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const calls: { url: string; init: RequestInit & { next?: unknown } }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        document: { id: 'd', collection: 'posts', slug: 'hello', path: '/blog/hello', data: {} },
      });
    }),
  );
  return calls;
}

describe('createRemoteSource', () => {
  it('caches published reads with the Genga tags and the safety TTL', async () => {
    const calls = stubFetch();
    await createRemoteSource({ url: 'https://cms.example.com/' }).getDocument('posts', 'hello');
    expect(calls[0].url).toBe('https://cms.example.com/api/v1/collections/posts/documents/hello');
    expect(calls[0].init.next).toEqual({
      tags: ['genga', 'genga:c:posts', 'genga:d:posts:hello'],
      revalidate: 3600,
    });
    expect(calls[0].init.cache).toBeUndefined();
  });

  it('never caches a preview read', async () => {
    const calls = stubFetch();
    await createRemoteSource({ url: 'https://cms.example.com', maxAge: 60 }).getDraft('d', 'token');
    expect(calls[0].init.cache).toBe('no-store');
    expect(calls[0].init.next).toBeUndefined();
  });

  it('does not wait on a teed body that the source cancels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // The fetch of Next.js keeps the second branch of the body for its cache.
        const [body] = new Response('{"error":"invalid_token"}').body!.tee();
        return new Response(body, { status: 401 });
      }),
    );
    const source = createRemoteSource({ url: 'https://cms.example.com' });
    await expect(source.getDraft('d', 'bad.token')).resolves.toBeNull();
  });

  it('gives the origins of the server and of the admin', () => {
    const source = createRemoteSource({ url: 'http://genga:3000/', adminOrigin: 'https://cms.example.com/' });
    expect(source.url).toBe('http://genga:3000');
    expect(source.adminOrigin).toBe('https://cms.example.com');
    expect(createRemoteSource({ url: 'https://cms.example.com' }).adminOrigin).toBe('https://cms.example.com');
  });

  it('refuses a bad maxAge', () => {
    expect(() => createRemoteSource({ url: 'https://cms.example.com', maxAge: 0 })).toThrow('maxAge');
  });
});
