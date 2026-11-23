import { describe, expect, it } from 'vitest';
import { readForm, readJson } from '../src/server/body';
import { clientIp } from '../src/server/auth';
import { RateLimiter } from '../src/server/rate-limit';
import { createUser, request, SITE, useGenga } from './helpers';

function streamOf(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const chunk = new Uint8Array(Math.min(16_384, size - sent)).fill(97);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

function streamRequest(size: number, type: string) {
  return new Request(`${SITE}/x`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: streamOf(size),
    duplex: 'half',
  } as RequestInit);
}

describe('body guard', () => {
  it('rejects a body by its Content-Length before it reads it', async () => {
    const body = new URLSearchParams({ email: 'a@b.c', password: 'x'.repeat(40_000) });
    const form = new Request(`${SITE}/x`, { method: 'POST', body });
    expect(form.headers.get('content-length')).toBeNull();
    const declared = new Request(`${SITE}/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '999999' },
      body: 'a=b',
    });
    await expect(readForm(declared, 16_384)).rejects.toMatchObject({ status: 413 });
  });

  it('stops a streamed body without Content-Length at the cap', async () => {
    await expect(readForm(streamRequest(200_000, 'application/x-www-form-urlencoded'), 16_384)).rejects.toMatchObject({
      status: 413,
    });
    await expect(readJson(streamRequest(200_000, 'application/json'), 16_384)).rejects.toMatchObject({ status: 413 });
  });

  it('parses a form and a JSON body under the cap', async () => {
    const form = await readForm(
      new Request(`${SITE}/x`, { method: 'POST', body: new URLSearchParams({ email: 'a@b.c' }) }),
      16_384,
    );
    expect(form.get('email')).toBe('a@b.c');
    const json = await readJson(
      new Request(`${SITE}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }),
      16_384,
    );
    expect(json).toEqual({ a: 1 });
  });
});

describe('client address', () => {
  const at = (header?: string) => new Request(`${SITE}/x`, header ? { headers: { 'x-forwarded-for': header } } : {});

  it('takes the address that the last trusted proxy added', () => {
    expect(clientIp(at('6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(at('6.6.6.6, 1.2.3.4, 10.0.0.2'), 2)).toBe('1.2.3.4');
    expect(clientIp(at('1.2.3.4'), 3)).toBe('1.2.3.4');
  });

  it('ignores the header without a trusted proxy', () => {
    expect(clientIp(at('6.6.6.6'), 0)).toBe('unknown');
    expect(clientIp(at(), 1)).toBe('unknown');
  });
});

describe('rate limiter', () => {
  it('keeps a bounded number of keys and drops the oldest one', () => {
    const limiter = new RateLimiter(1, 60_000, 3);
    for (const key of ['a', 'b', 'c', 'd']) limiter.hit(key);
    expect(limiter.size).toBe(3);
    expect(limiter.isLimited('a')).toBe(false);
    expect(limiter.isLimited('d')).toBe(true);
  });
});

describe('form size on the admin routes', () => {
  const ctx = useGenga();

  it('answers the login and setup forms with an error when the body is too large', async () => {
    const big = () =>
      request('/admin/login', {
        method: 'POST',
        headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: streamOf(200_000),
        duplex: 'half',
      } as RequestInit);
    await expect(ctx.genga.admin.loginAction(big())).resolves.toEqual({ error: 'Requête trop volumineuse.' });
    await expect(ctx.genga.admin.setupAction(big())).resolves.toEqual({ error: 'Requête trop volumineuse.' });
  });

  it('rejects an upload over the cap before it parses the form', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const cookie = await ctx.genga.auth.createSession(editor.id, request('/'));
    const response = await ctx.genga.api(
      request('/admin/api/media', {
        method: 'POST',
        cookie,
        headers: { origin: SITE, 'content-type': 'multipart/form-data; boundary=x' },
        body: streamOf(25_000_000),
        duplex: 'half',
      } as RequestInit),
      'media',
    );
    expect(response.status).toBe(413);
  });
});
