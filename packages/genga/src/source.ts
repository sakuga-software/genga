import { PREVIEW_PARAM, PREVIEW_TOKEN_PARAM } from './preview/bridge';

/** A document in the public shape: absolute media URLs, rich text with `html`. */
export type PublicDocument<T = Record<string, unknown>> = {
  id: string;
  collection: string;
  slug: string;
  /** The path of the document on the site. */
  path: string;
  /** Null in a preview. */
  versionId: string | null;
  publishedAt: string | null;
  data: T;
};

export type DocumentPage<T = Record<string, unknown>> = {
  documents: PublicDocument<T>[];
  total: number;
  nextCursor: string | null;
};

/** The query of a document list: the same in the public API and in both sources. */
export type ListQuery = {
  /** 1 to 100. Default: 20. */
  limit?: number;
  cursor?: string | null;
  tag?: string | null;
  /** `publishedAt` or a simple field of the collection, with an optional `-` for descending order. */
  sort?: string | null;
};

export type CacheInfo = { tags: string[]; etag?: string } | 'no-store';

/** The answer of `resolveRoute`. Forward `headers` with the response of the page. */
export type GengaRouteResult<T = Record<string, unknown>> =
  | { kind: 'document'; doc: PublicDocument<T>; preview: boolean; cache: CacheInfo; headers: Headers }
  | { kind: 'redirect'; location: string; status: 301; cache: CacheInfo; headers: Headers }
  | { kind: 'not-found'; cache: CacheInfo; headers: Headers };

/**
 * The preview credentials of a page, for frameworks that give no `Request` to a page:
 * the preview token (remote mode) or the `Cookie` header with the admin session (embedded mode).
 */
export type PreviewInput = { documentId: string; token?: string | null; cookie?: string | null };

export type SitemapEntry = { path: string; lastModified: string | null };

/** Reads published content. `createGenga` (embedded) and `createRemoteSource` (remote) implement it. */
export interface GengaSource {
  readonly mode: 'embedded' | 'remote';
  /** The published document of a slug, or null. A renamed slug gives null: use `resolveRoute` for redirects. */
  getDocument<T = Record<string, unknown>>(collection: string, slug: string): Promise<PublicDocument<T> | null>;
  listDocuments<T = Record<string, unknown>>(collection: string, query?: ListQuery): Promise<DocumentPage<T>>;
  /** The published document, a redirect, not found, or the draft for a valid preview. */
  resolveRoute<T = Record<string, unknown>>(
    request: Request | PreviewInput,
    collection: string,
    slug: string,
  ): Promise<GengaRouteResult<T>>;
  /** The draft of a document for a valid preview token, or null. */
  getDraft<T = Record<string, unknown>>(documentId: string, token: string): Promise<PublicDocument<T> | null>;
  sitemap(): Promise<SitemapEntry[]>;
  /** The cache tags of a read. Publish events carry the same tags. */
  tagsFor(collection: string, slug?: string | null): string[];
}

/** An error of a source: a bad query, an unknown collection, or a failure of the server. */
export class GengaSourceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GengaSourceError';
  }
}

export const PUBLISHED_HEADERS = { 'Cache-Control': 'public, max-age=0, must-revalidate' } as const;

/** Preview answers are never shared, never indexed, and never send the token in a `Referer`. */
export const SOURCE_PREVIEW_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
} as const;

/** FNV-1a, 32 bits. It runs on edge runtimes, where `node:crypto` is missing. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The ETag of a published document, quoted. The version id alone is not enough: the data embeds
 * the published targets of its relation fields, which change without a new version.
 */
export function documentEtag(doc: { versionId: string | null; data: unknown }): string | undefined {
  if (!doc.versionId) return undefined;
  return `"${doc.versionId}.${fnv1a(JSON.stringify(doc.data))}"`;
}

export function publishedHeaders(etag?: string): Headers {
  const headers = new Headers(PUBLISHED_HEADERS);
  if (etag) headers.set('ETag', etag);
  return headers;
}

export function previewHeaders(): Headers {
  return new Headers(SOURCE_PREVIEW_HEADERS);
}

function isRequest(value: Request | PreviewInput): value is Request {
  return typeof (value as Request).url === 'string' && typeof (value as Request).headers?.get === 'function';
}

/** Reads the preview id, the token and the cookie of a request or of a `PreviewInput`. */
export function previewInputOf(request: Request | PreviewInput): PreviewInput | null {
  if (!isRequest(request)) return request.documentId ? request : null;
  const params = new URL(request.url).searchParams;
  const documentId = params.get(PREVIEW_PARAM);
  if (documentId === null) return null;
  return { documentId, token: params.get(PREVIEW_TOKEN_PARAM), cookie: request.headers.get('cookie') };
}
