import { SLUG_PATTERN } from 'genga';
import type { GengaRouteResult, GengaSource, PreviewInput } from 'genga/remote';
import { cache } from 'react';
import { readPreviewCookie } from './preview-cookie';

/** `resolveRoute` reads the published document when the preview input has no document id. */
const PUBLISHED: PreviewInput = { documentId: '' };

async function load<T = Record<string, unknown>>(
  source: GengaSource,
  collection: string,
  slug: string,
): Promise<GengaRouteResult<T>> {
  // The Data Cache keeps no 404. A slug that no document can have gets no request to the Genga server.
  if (!SLUG_PATTERN.test(slug)) {
    return { kind: 'not-found', cache: { tags: source.tagsFor(collection, slug) }, headers: new Headers() };
  }
  const preview = await readPreviewCookie();
  if (preview) {
    const result = await source.resolveRoute<T>(preview, collection, slug);
    if (result.kind === 'document') return result;
  }
  return source.resolveRoute<T>(PUBLISHED, collection, slug);
}

/**
 * The page of a slug, in a Server Component: the published document, a redirect, or not found.
 * In Draft Mode with a valid preview token for this page, it gives the draft. When the token
 * expired, or when the preview is of another page, it gives the published document.
 * Calls with the same arguments in one request share one read.
 */
export const loadPage: typeof load = cache(load);
