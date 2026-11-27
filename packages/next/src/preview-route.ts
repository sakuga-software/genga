import { GengaSourceError, PREVIEW_PARAM, PREVIEW_TOKEN_PARAM, type GengaSource } from 'genga/remote';
import { cookies, draftMode } from 'next/headers';
import { readText } from './body';
import {
  DRAFT_MODE_COOKIE,
  encodePreviewCookie,
  isPreviewCredentials,
  PREVIEW_COOKIE,
  PREVIEW_COOKIE_MAX_AGE_SECONDS,
  previewCookieOptions,
  type PreviewCredentials,
} from './preview-cookie';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

/** The body of a token renewal is a small JSON object. */
const MAX_BODY_BYTES = 4 * 1024;

function answer(status: number, message?: string): Response {
  return new Response(message ?? null, {
    status,
    headers: message ? { ...PRIVATE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } : PRIVATE_HEADERS,
  });
}

/**
 * A path on this site, or null. It checks the path after URL parsing too, because the parser
 * removes dot segments: `/.//evil.example` becomes `//evil.example`, a URL of another host.
 */
export function sitePath(value: string | null): string | null {
  const isLocal = (path: string) => path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
  if (!value || !isLocal(value) || /\p{Cc}/u.test(value)) return null;
  const base = 'http://genga.invalid';
  const url = new URL(value, base);
  if (url.origin !== base || !isLocal(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

function parseJson(text: string): { documentId?: unknown; token?: unknown } | null {
  try {
    return JSON.parse(text) as { documentId?: unknown; token?: unknown } | null;
  } catch {
    return null;
  }
}

function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';
  return request.headers.get('origin') === new URL(request.url).origin;
}

/**
 * Turns Draft Mode on and stores the credentials. Next.js sets its Draft Mode cookie without
 * `Partitioned`, and Safari drops such a cookie in a frame on another site. In production the
 * function sets the cookie again with the same value, `Partitioned` and the life of a token.
 * The preview client renews both cookies with each fresh token.
 */
async function startPreview(credentials: PreviewCredentials) {
  (await draftMode()).enable();
  const jar = await cookies();
  const options = previewCookieOptions(PREVIEW_COOKIE_MAX_AGE_SECONDS);
  if (options.partitioned) {
    const draftModeCookie = jar.get(DRAFT_MODE_COOKIE);
    if (draftModeCookie) jar.set(DRAFT_MODE_COOKIE, draftModeCookie.value, options);
  }
  jar.set(PREVIEW_COOKIE, encodePreviewCookie(credentials), options);
}

/** The draft for valid credentials, null for a refused token, or an answer when the Genga server fails. */
async function checkToken(source: GengaSource, { documentId, token }: PreviewCredentials) {
  try {
    return { draft: await source.getDraft(documentId, token) };
  } catch (error) {
    if (!(error instanceof GengaSourceError)) throw error;
    console.error(`[genga] The preview check failed: the Genga server answered ${error.status}.`);
    return { failure: answer(502, 'The Genga server did not answer. Try again in a moment.') };
  }
}

export type PreviewRouteOptions = {
  /** The page after the preview starts, when the URL has no valid `path`. Default: the path of the draft. */
  fallbackPath?: string;
};

/**
 * The preview entry route, `app/api/genga/preview/route.ts`:
 *
 * - `GET ?genga-preview=<id>&genga-token=<token>&path=<path>`: the preview URL of the editor.
 *   It checks the token with the Genga server, turns Draft Mode on, and redirects to `path`
 *   or to the path of the draft.
 * - `POST { documentId, token }`: the preview client sends each fresh token of the editor.
 * - `DELETE`: turns the preview off.
 */
export function previewRoute(source: GengaSource, options: PreviewRouteOptions = {}) {
  return {
    async GET(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams;
      const credentials = { documentId: params.get(PREVIEW_PARAM), token: params.get(PREVIEW_TOKEN_PARAM) };
      if (!isPreviewCredentials(credentials.documentId, credentials.token)) {
        return answer(400, 'The preview link is not valid. Open the preview from the Genga editor.');
      }
      const checked = await checkToken(source, credentials as PreviewCredentials);
      if (checked.failure) return checked.failure;
      if (!checked.draft) return answer(401, 'The preview link expired. Reload the preview in the Genga editor.');
      const location =
        sitePath(params.get('path')) ?? sitePath(options.fallbackPath ?? null) ?? sitePath(checked.draft.path);
      if (!location) return answer(400, 'The draft has no path on this site.');
      await startPreview(credentials as PreviewCredentials);
      return new Response(null, { status: 307, headers: { ...PRIVATE_HEADERS, Location: location } });
    },

    async POST(request: Request): Promise<Response> {
      if (!isSameOrigin(request)) return answer(403);
      const text = await readText(request, MAX_BODY_BYTES);
      if (text === null) return answer(413);
      const body = parseJson(text);
      if (!body || !isPreviewCredentials(body.documentId, body.token)) return answer(400);
      const credentials = { documentId: body.documentId, token: body.token } as PreviewCredentials;
      const checked = await checkToken(source, credentials);
      if (checked.failure) return checked.failure;
      if (!checked.draft) return answer(401);
      await startPreview(credentials);
      return answer(204);
    },

    async DELETE(request: Request): Promise<Response> {
      if (!isSameOrigin(request)) return answer(403);
      (await draftMode()).disable();
      const jar = await cookies();
      const options = previewCookieOptions();
      // `disable()` deletes the cookie without `Partitioned`. The browser keeps a partitioned cookie apart.
      if (options.partitioned) jar.set(DRAFT_MODE_COOKIE, '', { ...options, expires: new Date(0) });
      jar.delete({ name: PREVIEW_COOKIE, ...options });
      return answer(204);
    },
  };
}
