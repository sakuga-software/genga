import { createHash } from 'node:crypto';
import { serializeSchema } from '../config';
import type { Fields } from '../fields/types';
import { toPublicData, toPublicMedia } from '../public-data';
import type { PublishedDocument } from '../types';
import { clientAddress } from './auth';
import type { GengaContext } from './context';
import type { GengaMedia } from './media';
import { verifyPreviewToken } from './preview';
import type { GengaPublished } from './published';
import { TokenBuckets } from './token-bucket';
import { GengaSourceError, type DocumentPage, type ListQuery, type PublicDocument } from '../source';

export type { DocumentPage, ListQuery, PublicDocument };
import { isUuid } from '../uuid';

export const PUBLIC_API_PATH = '/api/v1';

export type PublicApiOptions = {
  /** Origins that can read the public API from a browser. `'*'` allows every origin. Default: none. */
  corsOrigins?: string[] | '*';
  /** Requests per minute and per client address. Default: 300. */
  rateLimit?: number;
  /** The clock of the rate limit and of the preview tokens. For tests. */
  now?: () => number;
};

const MAX_LIMIT = 100;
const MAX_EVENTS = 500;
const DEFAULT_LIMIT = 20;
const SORTABLE = new Set(['text', 'textarea', 'slug', 'date', 'number', 'select', 'boolean']);

export class PublicApiError extends GengaSourceError {}

const notFound = (message = 'Not found.') => new PublicApiError(404, 'not_found', message);
const badRequest = (message: string) => new PublicApiError(400, 'bad_request', message);

function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
}

function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  return header.split(',').some((value) => {
    const tag = value.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // Falls through to the error below.
  }
  throw badRequest('The cursor is not valid. Use the nextCursor value of the previous page.');
}

function compareValues(left: unknown, right: unknown): number {
  const empty = (value: unknown) => value === null || value === undefined || value === '';
  if (empty(left) && empty(right)) return 0;
  if (empty(left)) return 1;
  if (empty(right)) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

type Services = { ctx: GengaContext; published: GengaPublished; media: GengaMedia };

/** Reads published content in the public shape: absolute media URLs, rich text with `html`. */
export function createPublicReads({ ctx, published }: Pick<Services, 'ctx' | 'published'>) {
  const config = ctx.config;
  const blocks = Object.fromEntries(config.blocks.map((block) => [block.type, { fields: block.fields as Fields }]));

  function collectionOf(name: string | undefined) {
    const collection = name && Object.hasOwn(config.collections, name) ? config.collections[name] : undefined;
    if (!name || !collection) throw notFound(`Unknown collection: ${name ?? ''}.`);
    return collection;
  }

  function toPublicDocument<T>(doc: PublishedDocument<unknown>): PublicDocument<T> {
    const collection = config.collections[doc.collection];
    return {
      id: doc.id,
      collection: doc.collection,
      slug: doc.slug,
      path: collection.path(doc.slug),
      versionId: doc.versionId,
      publishedAt: doc.publishedAt,
      data: toPublicData<T>(collection.fields, doc.data as Record<string, unknown>, blocks, ctx.siteUrl),
    };
  }

  async function list<T>(name: string, query: ListQuery = {}): Promise<DocumentPage<T>> {
    const collection = collectionOf(name);
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw badRequest(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
    }
    const offset = decodeCursor(query.cursor ?? null);
    let docs = await published.list(name);

    const tag = query.tag ?? null;
    if (tag !== null) {
      const tagFields = Object.entries(collection.fields).filter(([, field]) => field.type === 'tags');
      docs = docs.filter((doc) =>
        tagFields.some(([field]) => (doc.data[field] as string[] | undefined)?.includes(tag)),
      );
    }

    const sort = query.sort;
    if (sort) {
      const descending = sort.startsWith('-');
      const key = descending ? sort.slice(1) : sort;
      const field = Object.hasOwn(collection.fields, key) ? collection.fields[key] : undefined;
      if (key !== 'publishedAt' && !(field && SORTABLE.has(field.type))) {
        throw badRequest(`sort must be publishedAt or a simple field of the collection, with an optional "-".`);
      }
      const valueOf = (doc: PublishedDocument) => (key === 'publishedAt' ? doc.publishedAt : doc.data[key]);
      docs = [...docs].sort((a, b) => {
        const order = compareValues(valueOf(a), valueOf(b));
        return descending ? -order : order;
      });
    }

    const page = docs.slice(offset, offset + limit);
    return {
      documents: page.map((doc) => toPublicDocument<T>(doc)),
      total: docs.length,
      nextCursor: offset + limit < docs.length ? encodeCursor(offset + limit) : null,
    };
  }

  /** The published document of a slug, or its new slug after a rename, or null. */
  async function bySlug<T>(
    name: string,
    slug: string,
  ): Promise<{ document: PublicDocument<T> } | { moved: { slug: string; path: string } } | null> {
    const collection = collectionOf(name);
    const doc = await published.find(name, slug);
    if (doc) return { document: toPublicDocument<T>(doc) };
    const [moved] = await ctx.sql<{ to_slug: string }[]>`
      SELECT to_slug FROM genga_redirects WHERE collection = ${name} AND from_slug = ${slug}
    `;
    if (moved && (await published.find(name, moved.to_slug))) {
      return { moved: { slug: moved.to_slug, path: collection.path(moved.to_slug) } };
    }
    return null;
  }

  return { collectionOf, toPublicDocument, list, bySlug, blocks };
}

export type GengaPublicReads = ReturnType<typeof createPublicReads>;

/**
 * The public read API under `/api/v1`: published content only, as JSON, with ETags, CORS and a
 * rate limit per client address. Drafts leave the server only with a preview token.
 */
export function createPublicApi(
  { ctx, published, media }: Services,
  reads: GengaPublicReads,
  options: PublicApiOptions = {},
) {
  const config = ctx.config;
  const corsOrigins = options.corsOrigins ?? [];
  const buckets = new TokenBuckets(options.rateLimit ?? 300, options.now);
  const now = options.now ?? Date.now;

  function corsHeaders(request: Request, allowed: string[] | '*', headers: Headers) {
    const origin = request.headers.get('origin');
    if (allowed === '*') {
      headers.set('Access-Control-Allow-Origin', '*');
    } else {
      headers.append('Vary', 'Origin');
      if (origin && allowed.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
    }
    headers.set('Access-Control-Expose-Headers', 'ETag, Retry-After');
  }

  function respond(
    request: Request,
    status: number,
    body: unknown,
    init: { cache: 'public' | 'none'; cors: string[] | '*'; etag?: boolean; headers?: Record<string, string> },
  ): Response {
    const text = JSON.stringify(body);
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': init.cache === 'public' ? 'public, max-age=0, must-revalidate' : 'no-store',
      ...init.headers,
    });
    corsHeaders(request, init.cors, headers);
    if (init.etag && status === 200) {
      const etag = etagOf(text);
      headers.set('ETag', etag);
      if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers });
    }
    const isHead = request.method === 'HEAD';
    return new Response(isHead ? null : text, { status, headers });
  }

  function schemaBody() {
    const schema = serializeSchema(config);
    return {
      collections: Object.values(schema.collections).map((collection) => ({
        ...collection,
        path: config.collections[collection.name].path('{slug}'),
      })),
      blocks: Object.values(schema.blocks),
    };
  }

  function listQuery(url: URL): ListQuery {
    const limit = url.searchParams.get('limit');
    return {
      limit: limit === null ? undefined : Number(limit),
      cursor: url.searchParams.get('cursor'),
      tag: url.searchParams.get('tag'),
      sort: url.searchParams.get('sort'),
    };
  }

  async function preview(id: string, url: URL) {
    if (!ctx.previewSecret) throw notFound('Previews on another origin are off: GENGA_SECRET is not set.');
    if (!verifyPreviewToken(ctx.previewSecret, url.searchParams.get('token'), id, now())) {
      throw new PublicApiError(
        401,
        'invalid_token',
        'The preview token is not valid or has expired. Reload the preview.',
      );
    }
    const doc = await published.draft(id);
    if (!doc) throw notFound();
    return { document: reads.toPublicDocument(doc) };
  }

  async function route(request: Request, segments: string[], url: URL): Promise<Response> {
    const [resource, name, sub, slug, ...rest] = segments;
    const json = (body: object) => respond(request, 200, body, { cache: 'public', cors: corsOrigins, etag: true });

    if (resource === 'collections' && !name) return json(schemaBody());
    if (resource === 'collections' && name && !sub) {
      reads.collectionOf(name);
      const body = schemaBody().collections.find((collection) => collection.name === name);
      return json({ collection: body });
    }
    if (resource === 'collections' && name && sub === 'documents' && !slug) {
      return json(await reads.list(name, listQuery(url)));
    }
    if (resource === 'collections' && name && sub === 'documents' && slug && !rest.length) {
      const result = await reads.bySlug(name, slug);
      if (!result) throw notFound('No published document has this slug.');
      if ('document' in result) return json(result);
      const location = `${PUBLIC_API_PATH}/collections/${encodeURIComponent(name)}/documents/${encodeURIComponent(result.moved.slug)}`;
      return respond(
        request,
        301,
        { error: 'moved', message: 'The document has a new slug.', ...result.moved },
        { cache: 'public', cors: corsOrigins, headers: { Location: location } },
      );
    }
    if (resource === 'documents' && name && !sub) {
      const doc = await published.findById(name);
      if (!doc) throw notFound('No published document has this id.');
      return json({ document: reads.toPublicDocument(doc) });
    }
    if (resource === 'media' && name && !sub) {
      const item = await media.find(name);
      if (!item) throw notFound('No media has this id.');
      return json({
        media: { ...toPublicMedia(item, ctx.siteUrl), size: item.size, createdAt: item.createdAt },
      });
    }
    if (resource === 'sitemap' && !name) return json({ entries: await published.sitemap() });
    if (resource === 'events' && !name) {
      const after = url.searchParams.get('after');
      if (after !== null && !isUuid(after)) throw badRequest('after must be the id of an event.');
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam === null ? MAX_EVENTS : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS) {
        throw badRequest(`limit must be an integer from 1 to ${MAX_EVENTS}.`);
      }
      const page = await ctx.events.list(after, limit);
      if (!page) {
        throw new PublicApiError(
          410,
          'cursor_expired',
          'This event is unknown or older than 7 days. Invalidate the tag "genga", then read again without after.',
        );
      }
      return respond(request, 200, page, { cache: 'none', cors: corsOrigins });
    }
    if (resource === 'preview' && name && !sub) {
      return respond(request, 200, await preview(name, url), {
        cache: 'none',
        cors: ctx.previewOrigins,
        headers: { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
      });
    }
    throw notFound('Unknown API route. See docs/api.md.');
  }

  /** Answers a request under `/api/v1`. */
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.slice(PUBLIC_API_PATH.length).split('/').filter(Boolean);
    const isPreview = parts[0] === 'preview';
    const cors = isPreview ? ctx.previewOrigins : corsOrigins;
    const fail = (error: PublicApiError) =>
      respond(
        request,
        error.status,
        { error: error.code, message: error.message, ...error.extra },
        {
          cache: 'none',
          cors,
          headers: {
            ...(error.status === 429 ? { 'Retry-After': String(error.extra.retryAfter) } : {}),
            ...(isPreview ? { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } : {}),
          },
        },
      );

    const wait = buckets.take(clientAddress(request, ctx.trustedProxies));
    if (wait > 0) {
      return fail(
        new PublicApiError(429, 'rate_limited', 'Too many requests. Wait, then try again.', { retryAfter: wait }),
      );
    }

    if (request.method === 'OPTIONS') {
      const headers = new Headers({
        'Access-Control-Max-Age': '600',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      });
      corsHeaders(request, cors, headers);
      const requested = request.headers.get('access-control-request-headers');
      if (requested)
        headers.set(
          'Access-Control-Allow-Headers',
          requested
            .split(',')
            .filter((h) => /^\s*(accept|if-none-match|content-type)\s*$/i.test(h))
            .join(', ') || 'Accept',
        );
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(new PublicApiError(405, 'method_not_allowed', 'The public API is read-only.'));
    }

    try {
      return await route(request, parts.map(decodeURIComponent), url);
    } catch (error) {
      if (error instanceof PublicApiError) return fail(error);
      if (error instanceof URIError) return fail(badRequest('The path is not valid.'));
      ctx.log.error('[genga] Public API error:', error);
      return fail(new PublicApiError(500, 'internal', 'Internal error.'));
    }
  };
}
