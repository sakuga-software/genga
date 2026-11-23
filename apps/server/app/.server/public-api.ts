import { createHash } from 'node:crypto';
import { serializeSchema, toPublicData, toPublicMedia, type Fields, type PublishedDocument } from 'genga';
import { clientIp, verifyPreviewToken, type Genga } from 'genga/server';
import { TokenBuckets } from './token-bucket';

export const API_PREFIX = '/api/v1';

export type PublicApiOptions = {
  genga: Genga;
  /** Origin of this server. Media URLs start with it. */
  publicUrl: string;
  corsOrigins: string[] | '*';
  previewOrigins: string[];
  previewSecret: string | null;
  /** Requests per minute and per client address. */
  rateLimit: number;
  /** Hops that append to `X-Forwarded-For`, this server included. */
  trustedProxies: number;
  now?: () => number;
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const SORTABLE = new Set(['text', 'textarea', 'slug', 'date', 'number', 'select', 'boolean']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

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

/**
 * The public read API: published content only, as JSON, with ETags, CORS and a rate
 * limit per client address. Drafts leave the server only with a preview token.
 */
export function createPublicApi(options: PublicApiOptions) {
  const { genga } = options;
  const config = genga.config;
  const blocks = Object.fromEntries(config.blocks.map((block) => [block.type, { fields: block.fields as Fields }]));
  const buckets = new TokenBuckets(options.rateLimit, options.now);
  const baseUrl = options.publicUrl.replace(/\/+$/, '');

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

  function collectionOf(name: string | undefined) {
    const collection = name ? config.collections[name] : undefined;
    if (!name || !collection) throw notFound(`Unknown collection: ${name ?? ''}.`);
    return { name, collection };
  }

  function documentBody(doc: PublishedDocument) {
    const collection = config.collections[doc.collection];
    return {
      id: doc.id,
      collection: doc.collection,
      slug: doc.slug,
      path: collection.path(doc.slug),
      versionId: doc.versionId,
      publishedAt: doc.publishedAt,
      data: toPublicData(collection.fields, doc.data, blocks, baseUrl),
    };
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

  async function listDocuments(name: string, url: URL) {
    const { collection } = collectionOf(name);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw badRequest(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
    }
    const offset = decodeCursor(url.searchParams.get('cursor'));
    let docs = await genga.published.list(name);

    const tag = url.searchParams.get('tag');
    if (tag !== null) {
      const tagFields = Object.entries(collection.fields).filter(([, field]) => field.type === 'tags');
      docs = docs.filter((doc) =>
        tagFields.some(([field]) => (doc.data[field] as string[] | undefined)?.includes(tag)),
      );
    }

    const sort = url.searchParams.get('sort');
    if (sort) {
      const descending = sort.startsWith('-');
      const key = descending ? sort.slice(1) : sort;
      const field = collection.fields[key];
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
      documents: page.map(documentBody),
      total: docs.length,
      nextCursor: offset + limit < docs.length ? encodeCursor(offset + limit) : null,
    };
  }

  async function documentBySlug(name: string, slug: string, request: Request): Promise<Response | object> {
    collectionOf(name);
    const doc = await genga.published.find(name, slug);
    if (doc) return { document: documentBody(doc) };
    const [moved] = await genga.sql<{ to_slug: string }[]>`
      SELECT to_slug FROM genga_redirects WHERE collection = ${name} AND from_slug = ${slug}
    `;
    if (moved && (await genga.published.find(name, moved.to_slug))) {
      const location = `${API_PREFIX}/collections/${encodeURIComponent(name)}/documents/${encodeURIComponent(moved.to_slug)}`;
      return respond(
        request,
        301,
        { error: 'moved', message: 'The document has a new slug.', slug: moved.to_slug },
        { cache: 'public', cors: options.corsOrigins, headers: { Location: location } },
      );
    }
    throw notFound('No published document has this slug.');
  }

  async function preview(id: string, url: URL) {
    if (!options.previewSecret) throw notFound('Previews on another origin are off: GENGA_SECRET is not set.');
    if (!verifyPreviewToken(options.previewSecret, url.searchParams.get('token'), id, options.now?.())) {
      throw new HttpError(401, 'invalid_token', 'The preview token is not valid or has expired. Reload the preview.');
    }
    const doc = await genga.published.draft(id);
    if (!doc) throw notFound();
    return { document: documentBody(doc) };
  }

  async function route(request: Request, segments: string[], url: URL): Promise<Response> {
    const [resource, name, sub, slug, ...rest] = segments;
    const json = (body: object) =>
      respond(request, 200, body, { cache: 'public', cors: options.corsOrigins, etag: true });

    if (resource === 'collections' && !name) return json(schemaBody());
    if (resource === 'collections' && name && !sub) {
      collectionOf(name);
      const body = schemaBody().collections.find((collection) => collection.name === name);
      return json({ collection: body });
    }
    if (resource === 'collections' && name && sub === 'documents' && !slug) return json(await listDocuments(name, url));
    if (resource === 'collections' && name && sub === 'documents' && slug && !rest.length) {
      const result = await documentBySlug(name, slug, request);
      return result instanceof Response ? result : json(result);
    }
    if (resource === 'documents' && name && !sub) {
      const doc = await genga.published.findById(name);
      if (!doc) throw notFound('No published document has this id.');
      return json({ document: documentBody(doc) });
    }
    if (resource === 'media' && name && !sub) {
      const media = await genga.media.find(name);
      if (!media) throw notFound('No media has this id.');
      return json({ media: { ...toPublicMedia(media, baseUrl), size: media.size, createdAt: media.createdAt } });
    }
    if (resource === 'preview' && name && !sub) {
      return respond(request, 200, await preview(name, url), {
        cache: 'none',
        cors: options.previewOrigins,
        headers: { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
      });
    }
    throw notFound('Unknown API route. See docs/api.md.');
  }

  /** Answers a request under `/api/v1`. */
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean);
    const isPreview = parts[0] === 'preview';
    const cors = isPreview ? options.previewOrigins : options.corsOrigins;
    const fail = (error: HttpError) =>
      respond(
        request,
        error.status,
        { error: error.code, message: error.message, ...error.extra },
        { cache: 'none', cors, headers: error.status === 429 ? { 'Retry-After': String(error.extra.retryAfter) } : {} },
      );

    const wait = buckets.take(clientIp(request, options.trustedProxies));
    if (wait > 0) {
      return fail(new HttpError(429, 'rate_limited', 'Too many requests. Wait, then try again.', { retryAfter: wait }));
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
      return fail(new HttpError(405, 'method_not_allowed', 'The public API is read-only.'));
    }

    try {
      return await route(request, parts.map(decodeURIComponent), url);
    } catch (error) {
      if (error instanceof HttpError) return fail(error);
      if (error instanceof URIError) return fail(badRequest('The path is not valid.'));
      console.error('[genga] Public API error:', error);
      return fail(new HttpError(500, 'internal', 'Internal error.'));
    }
  };
}
