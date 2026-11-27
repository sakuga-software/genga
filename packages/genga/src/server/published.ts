import { can } from '../access';
import { tolerantRead } from '../fields/schema';
import { populate } from '../populate';
import { isUuid } from '../uuid';
import type { PublishedDocument } from '../types';
import type { GengaAuth } from './auth';
import type { GengaContext } from './context';
import { loadMediaMap } from './media';
import { collectRelationIds, type RelationResolver } from '../populate';
import { loadRelatedDocuments, loadRelationResolver, resolverOf } from './relations';

type PublishedRow = {
  id: string;
  collection: string;
  slug: string;
  published_at: Date | null;
  version_id: string;
  data: Record<string, unknown>;
};

import { PREVIEW_PARAM } from '../preview/bridge';
import { documentEtag, SOURCE_PREVIEW_HEADERS } from '../source';

export { PREVIEW_PARAM };

export type RouteResult<T> =
  | { kind: 'document'; doc: PublishedDocument<T>; preview: boolean; headers: Headers }
  | { kind: 'redirect'; location: string; headers: Headers }
  | { kind: 'not-found'; headers: Headers };

/** Preview answers: never shared, never indexed, and no preview token in a `Referer`. */
export const PREVIEW_HEADERS = SOURCE_PREVIEW_HEADERS;

function previewHeaders() {
  return new Headers(PREVIEW_HEADERS);
}

function publicHeaders(etag?: string) {
  const headers = new Headers({ 'Cache-Control': 'public, max-age=0, must-revalidate' });
  if (etag) headers.set('ETag', etag);
  return headers;
}

function sortValue(doc: PublishedDocument<unknown>, field: string | undefined): string | number {
  const value = field ? (doc.data as Record<string, unknown>)[field] : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) return value;
  return doc.publishedAt ?? '';
}

/** Sort field descending, then title ascending, so equal values keep a stable order. */
function compareNewestFirst(
  a: PublishedDocument<unknown>,
  b: PublishedDocument<unknown>,
  field: string | undefined,
  titleField: string,
): number {
  const left = sortValue(a, field);
  const right = sortValue(b, field);
  if (left !== right) {
    if (typeof left === 'number' && typeof right === 'number') return right - left;
    return String(right).localeCompare(String(left));
  }
  const title = (doc: PublishedDocument<unknown>) => String((doc.data as Record<string, unknown>)[titleField] ?? '');
  return title(a).localeCompare(title(b), 'fr');
}

export function createPublished(ctx: GengaContext, auth: GengaAuth) {
  const { sql } = ctx;

  async function toDocument<T>(
    row: PublishedRow,
    versionId: string | null,
    raw: unknown,
    preloaded?: RelationResolver,
  ): Promise<PublishedDocument<T>> {
    const collection = ctx.config.collections[row.collection];
    const data = tolerantRead(collection.fields, raw, ctx.blocks);
    const [media, resolve] = await Promise.all([
      loadMediaMap(ctx, collection.fields, data),
      preloaded ?? loadRelationResolver(ctx, collection.fields, data),
    ]);
    return {
      id: row.id,
      collection: row.collection,
      slug: row.slug,
      versionId,
      publishedAt: row.published_at?.toISOString() ?? null,
      data: populate<T>(collection.fields, data, ctx.blocks, media, resolve),
    };
  }

  async function find<T = Record<string, unknown>>(
    collection: string,
    slug: string,
  ): Promise<PublishedDocument<T> | null> {
    if (!ctx.config.collections[collection]) return null;
    return ctx.cache.get(collection, `doc:${slug}`, async () => {
      const [row] = await sql<PublishedRow[]>`
        SELECT d.id, d.collection, d.slug, d.published_at, v.id AS version_id, v.data
        FROM genga_documents d JOIN genga_versions v ON v.id = d.published_version_id
        WHERE d.collection = ${collection} AND d.slug = ${slug} AND d.deleted_at IS NULL
      `;
      return row ? toDocument<T>(row, row.version_id, row.data) : null;
    });
  }

  async function list<T = Record<string, unknown>>(
    collection: string,
    options: { limit?: number } = {},
  ): Promise<PublishedDocument<T>[]> {
    const config = ctx.config.collections[collection];
    if (!config) return [];
    const all = await ctx.cache.get(collection, 'list', async () => {
      const rows = await sql<PublishedRow[]>`
        SELECT d.id, d.collection, d.slug, d.published_at, v.id AS version_id, v.data
        FROM genga_documents d JOIN genga_versions v ON v.id = d.published_version_id
        WHERE d.collection = ${collection} AND d.deleted_at IS NULL
      `;
      // One query loads the relation targets of the whole list.
      const refs = rows.flatMap((row) =>
        collectRelationIds(config.fields, tolerantRead(config.fields, row.data, ctx.blocks), ctx.blocks),
      );
      const resolve = resolverOf(await loadRelatedDocuments(ctx, refs));
      const docs = await Promise.all(rows.map((row) => toDocument<T>(row, row.version_id, row.data, resolve)));
      return docs.sort((a, b) => compareNewestFirst(a, b, config.sortField, config.titleField));
    });
    return options.limit ? all.slice(0, options.limit) : all;
  }

  /** The published version of a document, by id. */
  async function findById<T = Record<string, unknown>>(id: string): Promise<PublishedDocument<T> | null> {
    if (!isUuid(id)) return null;
    const [row] = await sql<PublishedRow[]>`
      SELECT d.id, d.collection, d.slug, d.published_at, v.id AS version_id, v.data
      FROM genga_documents d JOIN genga_versions v ON v.id = d.published_version_id
      WHERE d.id = ${id} AND d.deleted_at IS NULL
    `;
    if (!row || !ctx.config.collections[row.collection]) return null;
    return toDocument<T>(row, row.version_id, row.data);
  }

  /**
   * The draft of a document, with media objects. It does no access check:
   * the caller checks one first, for example a preview token.
   */
  async function draft<T = Record<string, unknown>>(id: string): Promise<PublishedDocument<T> | null> {
    if (!isUuid(id)) return null;
    const [row] = await sql<(PublishedRow & { draft: Record<string, unknown> })[]>`
      SELECT id, collection, slug, published_at, published_version_id AS version_id, draft
      FROM genga_documents WHERE id = ${id} AND deleted_at IS NULL
    `;
    if (!row || !ctx.config.collections[row.collection]) return null;
    return toDocument<T>(row, null, row.draft);
  }

  async function redirectFor(collection: string, slug: string): Promise<string | null> {
    const config = ctx.config.collections[collection];
    if (!config) return null;
    return ctx.cache.get(collection, `redirect:${slug}`, async () => {
      const [row] = await sql<{ to_slug: string }[]>`
        SELECT to_slug FROM genga_redirects WHERE collection = ${collection} AND from_slug = ${slug}
      `;
      return row ? config.path(row.to_slug) : null;
    });
  }

  /**
   * Loads the document of a public route. With `?genga-preview=<id>`, it loads the draft
   * for a signed-in user who can read it, if the id belongs to this route.
   * Preview answers are `private, no-store`, also when they fail.
   */
  async function loadForRoute<T = Record<string, unknown>>(
    request: Request,
    collection: string,
    slug: string,
  ): Promise<RouteResult<T>> {
    const url = new URL(request.url);
    const previewId = url.searchParams.get(PREVIEW_PARAM);
    if (previewId !== null) {
      const headers = previewHeaders();
      const user = await auth.getUser(request);
      const config = ctx.config.collections[collection];
      if (!user || !config || !isUuid(previewId)) return { kind: 'not-found', headers };
      const [row] = await sql<(PublishedRow & { draft: Record<string, unknown>; created_by: string | null })[]>`
        SELECT id, collection, slug, published_at, published_version_id AS version_id, draft, created_by
        FROM genga_documents WHERE id = ${previewId} AND deleted_at IS NULL
      `;
      if (!row || row.collection !== collection || row.slug !== slug) return { kind: 'not-found', headers };
      if (!can(user, 'read', config.access, { createdBy: row.created_by })) return { kind: 'not-found', headers };
      return { kind: 'document', doc: await toDocument<T>(row, null, row.draft), preview: true, headers };
    }
    const doc = await find<T>(collection, slug);
    if (doc) return { kind: 'document', doc, preview: false, headers: publicHeaders(documentEtag(doc)) };
    const location = await redirectFor(collection, slug);
    if (location) return { kind: 'redirect', location, headers: publicHeaders() };
    return { kind: 'not-found', headers: publicHeaders() };
  }

  async function sitemap(): Promise<{ path: string; lastModified: string | null }[]> {
    const entries: { path: string; lastModified: string | null }[] = [];
    for (const [name, config] of Object.entries(ctx.config.collections)) {
      const rows = await sql<{ slug: string; created_at: Date }[]>`
        SELECT d.slug, v.created_at FROM genga_documents d JOIN genga_versions v ON v.id = d.published_version_id
        WHERE d.collection = ${name} AND d.deleted_at IS NULL ORDER BY v.created_at DESC
      `;
      for (const row of rows) entries.push({ path: config.path(row.slug), lastModified: row.created_at.toISOString() });
    }
    return entries;
  }

  return { find, findById, draft, list, redirectFor, loadForRoute, sitemap };
}

export type GengaPublished = ReturnType<typeof createPublished>;
