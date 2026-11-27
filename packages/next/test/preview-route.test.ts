import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextState } from './next-state';
import { DOC_ID, FAILING_TOKEN, fakeSource, TOKEN } from './fake-source';
import { previewRoute, sitePath } from '../src/preview-route';
import { decodePreviewCookie } from '../src/preview-cookie';

const SITE = 'https://www.example.com';

function entry(params: Record<string, string>) {
  return new Request(`${SITE}/api/genga/preview?${new URLSearchParams(params)}`);
}

function post(body: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return new Request(`${SITE}/api/genga/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => nextState.reset());
afterEach(() => vi.unstubAllEnvs());

describe('sitePath', () => {
  it('keeps a path of this site', () => {
    expect(sitePath('/blog/hello?x=1#top')).toBe('/blog/hello?x=1#top');
  });

  it.each([
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    '/.//evil.example/x',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/%2e%2e//evil.example',
    'blog',
    '/a\nb',
    '',
    null,
  ])('refuses %j', (value) => {
    expect(sitePath(value)).toBeNull();
  });
});

describe('previewRoute GET', () => {
  it('checks the token, turns Draft Mode on and redirects to the path', async () => {
    const { source, getDraft } = fakeSource();
    const response = await previewRoute(source).GET(
      entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN, path: '/blog/hello' }),
    );
    expect(getDraft).toHaveBeenCalledWith(DOC_ID, TOKEN);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/blog/hello');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(nextState.draftMode).toBe(true);
    expect(decodePreviewCookie(nextState.cookies.get('genga-preview')?.value)).toEqual({
      documentId: DOC_ID,
      token: TOKEN,
    });
  });

  it('sets the Draft Mode cookie again as Partitioned in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { source } = fakeSource();
    await previewRoute(source).GET(entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN }));
    const bypass = nextState.cookies.get('__prerender_bypass');
    expect(bypass?.value).toBe('build-preview-id');
    expect(bypass?.options).toMatchObject({
      partitioned: true,
      secure: true,
      sameSite: 'none',
      httpOnly: true,
      maxAge: 3600,
    });
    expect(nextState.cookies.get('genga-preview')?.options).toMatchObject({ partitioned: true, maxAge: 3600 });
  });

  it('keeps the Draft Mode cookie of Next.js in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { source } = fakeSource();
    await previewRoute(source).GET(entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN }));
    expect(nextState.cookies.get('__prerender_bypass')?.options).toEqual({ sameSite: 'none' });
    expect(nextState.cookies.get('genga-preview')?.options).toMatchObject({ sameSite: 'lax', secure: false });
  });

  it('redirects to the path of the draft when the path is not of this site', async () => {
    const { source } = fakeSource();
    const response = await previewRoute(source).GET(
      entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN, path: '//evil.example/' }),
    );
    expect(response.headers.get('location')).toBe('/blog/hello');
  });

  it('answers 401 for a bad token and leaves Draft Mode off', async () => {
    const { source } = fakeSource();
    const response = await previewRoute(source).GET(entry({ 'genga-preview': DOC_ID, 'genga-token': 'bad.token' }));
    expect(response.status).toBe(401);
    expect(nextState.draftMode).toBe(false);
    expect(nextState.cookies.size).toBe(0);
  });

  it('answers 502 with the private headers when the Genga server fails', async () => {
    const { source } = fakeSource();
    const response = await previewRoute(source).GET(entry({ 'genga-preview': DOC_ID, 'genga-token': FAILING_TOKEN }));
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(nextState.draftMode).toBe(false);
  });

  it('leaves Draft Mode off when no path of the site exists', async () => {
    const { source, getDraft } = fakeSource();
    getDraft.mockResolvedValueOnce({ ...(await getDraft(DOC_ID, TOKEN))!, path: '//evil.example' });
    const response = await previewRoute(source).GET(
      entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN, path: '/.//evil.example' }),
    );
    expect(response.status).toBe(400);
    expect(nextState.draftMode).toBe(false);
  });

  it('answers 400 without credentials', async () => {
    const { source, getDraft } = fakeSource();
    const response = await previewRoute(source).GET(entry({ path: '/blog/hello' }));
    expect(response.status).toBe(400);
    expect(getDraft).not.toHaveBeenCalled();
  });
});

describe('previewRoute POST', () => {
  it('renews the cookie with a fresh token', async () => {
    const { source } = fakeSource();
    const response = await previewRoute(source).POST(post({ documentId: DOC_ID, token: TOKEN }));
    expect(response.status).toBe(204);
    expect(nextState.cookies.get('genga-preview')?.value).toBe(`${DOC_ID}:${TOKEN}`);
  });

  it('refuses a request from another origin', async () => {
    const { source, getDraft } = fakeSource();
    const response = await previewRoute(source).POST(
      post({ documentId: DOC_ID, token: TOKEN }, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(response.status).toBe(403);
    expect(getDraft).not.toHaveBeenCalled();
  });

  it('refuses a large body', async () => {
    const { source, getDraft } = fakeSource();
    const response = await previewRoute(source).POST(post({ documentId: DOC_ID, token: TOKEN, pad: 'x'.repeat(5000) }));
    expect(response.status).toBe(413);
    expect(getDraft).not.toHaveBeenCalled();
  });

  it('refuses a token that the server does not accept', async () => {
    const { source } = fakeSource();
    const response = await previewRoute(source).POST(post({ documentId: DOC_ID, token: 'other.token' }));
    expect(response.status).toBe(401);
    expect(nextState.cookies.size).toBe(0);
  });
});

describe('previewRoute DELETE', () => {
  it('turns the preview off', async () => {
    const { source } = fakeSource();
    const route = previewRoute(source);
    await route.GET(entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN }));
    const response = await route.DELETE(
      new Request(`${SITE}/api/genga/preview`, { method: 'DELETE', headers: { origin: SITE } }),
    );
    expect(response.status).toBe(204);
    expect(nextState.draftMode).toBe(false);
    expect(nextState.cookies.has('genga-preview')).toBe(false);
  });

  it('expires the Partitioned Draft Mode cookie in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { source } = fakeSource();
    const route = previewRoute(source);
    await route.GET(entry({ 'genga-preview': DOC_ID, 'genga-token': TOKEN }));
    await route.DELETE(new Request(`${SITE}/api/genga/preview`, { method: 'DELETE', headers: { origin: SITE } }));
    expect(nextState.cookies.get('__prerender_bypass')).toMatchObject({
      value: '',
      options: { partitioned: true, expires: new Date(0) },
    });
  });
});
