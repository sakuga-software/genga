import { cookies, draftMode } from 'next/headers';

/** The cookie of the preview: the id of the document and its preview token. */
export const PREVIEW_COOKIE = 'genga-preview';
/** The name that Next.js gives to the Draft Mode cookie. */
export const DRAFT_MODE_COOKIE = '__prerender_bypass';
/**
 * The life of the preview cookies. A token lives 10 minutes. The cookies live longer: after a
 * token expires, the page still connects to the editor, and the next fresh token of the editor
 * gives the draft again.
 */
export const PREVIEW_COOKIE_MAX_AGE_SECONDS = 60 * 60;

const MAX_TOKEN_LENGTH = 200;

export type PreviewCredentials = { documentId: string; token: string };

export function isPreviewCredentials(documentId: unknown, token: unknown): boolean {
  return (
    typeof documentId === 'string' &&
    typeof token === 'string' &&
    /^[\w-]{1,100}$/.test(documentId) &&
    token.length > 0 &&
    token.length <= MAX_TOKEN_LENGTH &&
    !/[\s;,]/.test(token)
  );
}

export function encodePreviewCookie({ documentId, token }: PreviewCredentials): string {
  return `${documentId}:${token}`;
}

export function decodePreviewCookie(value: string | undefined): PreviewCredentials | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator < 0) return null;
  const documentId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  return isPreviewCredentials(documentId, token) ? { documentId, token } : null;
}

/**
 * The attributes of the preview cookies. In production the cookies are `Partitioned`: a
 * browser that blocks third-party cookies (Safari) keeps them in the admin frame on another
 * site. `next dev` serves HTTP, so there they are `Lax` without `Secure`, as Next.js does.
 */
export function previewCookieOptions(maxAge?: number) {
  const production = process.env.NODE_ENV !== 'development';
  return {
    httpOnly: true,
    path: '/',
    secure: production,
    sameSite: production ? ('none' as const) : ('lax' as const),
    partitioned: production,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

/**
 * The credentials of the preview cookie, in Draft Mode only.
 * WARNING: `cookies()` makes the page dynamic. Call it only in Draft Mode, so public pages stay static.
 */
export async function readPreviewCookie(): Promise<PreviewCredentials | null> {
  if (!(await draftMode()).isEnabled) return null;
  return decodePreviewCookie((await cookies()).get(PREVIEW_COOKIE)?.value);
}
