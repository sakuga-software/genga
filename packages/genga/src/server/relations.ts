import { can, isOwnOnly } from '../access';
import { tolerantRead } from '../fields/schema';
import type { Fields, RelatedDocument } from '../fields/types';
import { collectRelationIds, populate, type RelationResolver } from '../populate';
import type { DocumentStatus, PublicUser, RelationOption } from '../types';
import { isUuid } from '../uuid';
import type { GengaContext } from './context';
import { loadMediaMap } from './media';

const OPTION_LIMIT = 20;

function key(collection: string, id: string) {
  return `${collection}\u0000${id}`;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

type PublishedRow = {
  id: string;
  collection: string;
  slug: string;
  published_at: Date | null;
  data: Record<string, unknown>;
};

/**
 * Loads the published version of each target. A target that is not live, deleted, or in another
 * collection than its field asks is missing from the map. The data of the drafts is never read.
 */
export async function loadRelatedDocuments(
  ctx: GengaContext,
  refs: { id: string; collection: string }[],
): Promise<Map<string, RelatedDocument>> {
  const wanted = refs.filter((ref) => isUuid(ref.id) && Object.hasOwn(ctx.config.collections, ref.collection));
  if (!wanted.length) return new Map();
  const rows = await ctx.sql<PublishedRow[]>`
    SELECT d.id, d.collection, d.slug, d.published_at, v.data
    FROM genga_documents d JOIN genga_versions v ON v.id = d.published_version_id
    WHERE d.id = ANY(${[...new Set(wanted.map((ref) => ref.id))]}::uuid[]) AND d.deleted_at IS NULL
  `;
  const result = new Map<string, RelatedDocument>();
  await Promise.all(
    rows.map(async (row) => {
      const collection = ctx.config.collections[row.collection];
      if (!collection) return;
      const data = tolerantRead(collection.fields, row.data, ctx.blocks);
      const media = await loadMediaMap(ctx, collection.fields, data);
      result.set(key(row.collection, row.id), {
        id: row.id,
        collection: row.collection,
        slug: row.slug,
        path: collection.path(row.slug),
        title: String(data[collection.titleField] ?? ''),
        publishedAt: row.published_at?.toISOString() ?? null,
        // The relations of a target stay references: one level only, and no cycle.
        data: populate(collection.fields, data, ctx.blocks, media),
      });
    }),
  );
  return result;
}

export function resolverOf(related: ReadonlyMap<string, RelatedDocument>): RelationResolver {
  return (field, id) => related.get(key(field.to, id)) ?? null;
}

/** The resolver of the relation fields in `data`: published targets only. */
export async function loadRelationResolver(
  ctx: GengaContext,
  fields: Fields,
  data: unknown,
): Promise<RelationResolver> {
  return resolverOf(await loadRelatedDocuments(ctx, collectRelationIds(fields, data, ctx.blocks)));
}

/** The related documents of `data`, by `<collection>\u0000<id>`, for the editor. */
export async function relatedRecord(
  ctx: GengaContext,
  fields: Fields,
  data: unknown,
): Promise<Record<string, RelatedDocument>> {
  return Object.fromEntries(await loadRelatedDocuments(ctx, collectRelationIds(fields, data, ctx.blocks)));
}

type OptionRow = {
  id: string;
  slug: string;
  created_by: string | null;
  published_version_id: string | null;
  published_rev: number | null;
  draft_rev: number;
  draft_title: string | null;
  published_title: string | null;
};

function statusOf(row: OptionRow): DocumentStatus {
  if (!row.published_version_id) return 'draft';
  return row.published_rev === row.draft_rev ? 'published' : 'changed';
}

/**
 * The documents that a user can choose in a relation field: the documents that the user can read,
 * and every published document, because its published version is public. A document that the
 * user cannot read shows its published title only, and the search matches its published title
 * and slug only, so its draft stays private.
 */
export async function relationOptions(
  ctx: GengaContext,
  user: PublicUser,
  collectionName: string,
  query: { search?: string; ids?: string[] },
): Promise<RelationOption[]> {
  const collection = Object.hasOwn(ctx.config.collections, collectionName)
    ? ctx.config.collections[collectionName]
    : undefined;
  if (!collection) return [];
  const readsAll = can(user, 'read', collection.access) && !isOwnOnly(user, collection.access);
  const readsOwn = can(user, 'read', collection.access);
  const readable = (row: Pick<OptionRow, 'created_by'>) => readsAll || (readsOwn && row.created_by === user.id);
  const ids = query.ids?.filter(isUuid);
  const search = query.search?.trim() ? `%${escapeLike(query.search.trim())}%` : null;
  const title = collection.titleField;
  const { sql } = ctx;
  const rows = await sql<OptionRow[]>`
    SELECT d.id, d.slug, d.created_by, d.published_version_id, d.published_rev, d.draft_rev,
      d.draft->>${title} AS draft_title, v.data->>${title} AS published_title
    FROM genga_documents d LEFT JOIN genga_versions v ON v.id = d.published_version_id
    WHERE d.collection = ${collectionName} AND d.deleted_at IS NULL
      ${ids ? sql`AND d.id = ANY(${ids}::uuid[])` : sql``}
      AND (${readsAll} OR d.published_version_id IS NOT NULL ${readsOwn ? sql`OR d.created_by = ${user.id}` : sql``})
      ${
        search
          ? sql`AND (
              ((${readsAll} OR d.created_by = ${readsOwn ? user.id : null}) AND d.draft->>${title} ILIKE ${search})
              OR (d.published_version_id IS NOT NULL AND (v.data->>${title} ILIKE ${search} OR d.slug ILIKE ${search}))
            )`
          : sql``
      }
    ORDER BY d.draft_updated_at DESC, d.id
    LIMIT ${ids ? Math.min(ids.length, 200) : OPTION_LIMIT}
  `;
  const related = ids
    ? await loadRelatedDocuments(
        ctx,
        rows.map((row) => ({ id: row.id, collection: collectionName })),
      )
    : null;
  return rows.map((row) => {
    const canRead = readable(row);
    return {
      id: row.id,
      collection: collectionName,
      title: (canRead ? row.draft_title : row.published_title) || row.slug,
      status: canRead ? statusOf(row) : 'published',
      related: related?.get(key(collectionName, row.id)) ?? null,
    };
  });
}

function relationTargets(fields: Fields, blocks: GengaContext['blocks'], into: Set<string>, seen: Set<Fields>) {
  if (seen.has(fields)) return;
  seen.add(fields);
  for (const field of Object.values(fields)) {
    if (field.type === 'relation') into.add(field.to);
    if (field.type === 'group' || field.type === 'array') relationTargets(field.fields, blocks, into, seen);
    if (field.type === 'blocks') {
      for (const [type, block] of Object.entries(blocks)) {
        if (!field.allowed || field.allowed.includes(type)) relationTargets(block.fields, blocks, into, seen);
      }
    }
  }
}

const referencingCache = new WeakMap<GengaContext['config'], Map<string, string[]>>();

/**
 * The collections whose published documents embed documents of `target`. A change to a document of
 * `target` must also refresh their caches.
 */
export function referencingCollections(ctx: Pick<GengaContext, 'config' | 'blocks'>, target: string): string[] {
  let byTarget = referencingCache.get(ctx.config);
  if (!byTarget) {
    byTarget = new Map();
    for (const [name, collection] of Object.entries(ctx.config.collections)) {
      const targets = new Set<string>();
      relationTargets(collection.fields, ctx.blocks, targets, new Set());
      for (const to of targets) byTarget.set(to, [...(byTarget.get(to) ?? []), name]);
    }
    referencingCache.set(ctx.config, byTarget);
  }
  return byTarget.get(target) ?? [];
}

/** Clears the published cache of a collection and of the collections that embed its documents. */
export function invalidatePublished(ctx: GengaContext, collection: string) {
  ctx.cache.invalidate(collection);
  for (const name of referencingCollections(ctx, collection)) {
    if (name !== collection) ctx.cache.invalidate(name);
  }
}
