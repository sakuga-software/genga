import type { Sql, TransactionSql } from 'postgres';
import { can, isOwnOnly, type DocumentAction } from '../access';
import { RESERVED_SLUGS, type CollectionConfig } from '../config';
import { defaultValues, SLUG_PATTERN, tolerantRead, validate } from '../fields/schema';
import { collectMediaIds, collectRelationIds } from '../populate';
import { slugify } from '../slugify';
import { isUuid } from '../uuid';
import type {
  AdminDocument,
  DocumentSchedule,
  DocumentStatus,
  DocumentSummary,
  PublicUser,
  ScheduleAction,
  VersionSummary,
} from '../types';
import { audit } from './auth';
import type { GengaContext } from './context';
import { badRequest, forbidden, GengaError, isUniqueViolation, notFound } from './errors';
import { loadMediaMap } from './media';
import { documentEvent } from './events';
import { previewTarget } from './preview';
import { invalidatePublished, referencingCollections, relatedRecord } from './relations';

type DocumentRow = {
  id: string;
  collection: string;
  slug: string;
  draft: Record<string, unknown>;
  draft_rev: number;
  draft_updated_at: Date;
  published_version_id: string | null;
  published_rev: number | null;
  published_at: Date | null;
  first_published_at: Date | null;
  created_by: string | null;
  author_name: string | null;
  deleted_at: Date | null;
};

export type ListOptions = {
  search?: string;
  status?: DocumentStatus | 'all';
  /** Documents whose draft has this value in one of its `tags` fields. */
  tag?: string;
  limit?: number;
  offset?: number;
};

function statusOf(row: Pick<DocumentRow, 'published_version_id' | 'published_rev' | 'draft_rev'>): DocumentStatus {
  if (!row.published_version_id) return 'draft';
  return row.published_rev === row.draft_rev ? 'published' : 'changed';
}

function conflict(draftRev: number | null) {
  return new GengaError(409, 'conflict', 'Ce document a changé depuis votre dernière lecture.', { draftRev });
}

type ScheduleRow = { action: ScheduleAction; run_at: Date; failed_at: Date | null; last_error: string | null };

/** `scheduled`: the runner acts for the user who saved the schedule, and only if the row is still due. */
type RunOptions = { scheduled?: boolean };

/** A scheduled run found its schedule cleared or moved after the runner listed it. */
const NOT_DUE = Symbol('not due');

function toSchedule(rows: ScheduleRow[]): DocumentSchedule {
  const schedule: DocumentSchedule = { publish: null, unpublish: null };
  for (const row of rows) {
    schedule[row.action] = {
      at: row.run_at.toISOString(),
      failedAt: row.failed_at?.toISOString() ?? null,
      error: row.last_error,
    };
  }
  return schedule;
}

function scheduleDate(value: unknown, label: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw badRequest(`Date de ${label} invalide.`);
  return date;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function createDocuments(ctx: GengaContext) {
  const { sql } = ctx;
  const authorLabel = () => sql`COALESCE(NULLIF(btrim(u.name), ''), u.email)`;

  function collectionOf(name: string): CollectionConfig {
    if (!Object.hasOwn(ctx.config.collections, name)) throw notFound(`Collection inconnue : ${name}`);
    return ctx.config.collections[name];
  }

  function assertCan(
    user: PublicUser,
    action: DocumentAction,
    row?: Pick<DocumentRow, 'collection' | 'created_by'>,
    collection?: string,
  ) {
    const name = row?.collection ?? collection ?? '';
    const access = collectionOf(name).access;
    if (!can(user, action, access, row ? { createdBy: row.created_by } : undefined)) throw forbidden();
  }

  function summarize(row: DocumentRow): DocumentSummary {
    const collection = collectionOf(row.collection);
    const title = row.draft?.[collection.titleField];
    return {
      id: row.id,
      collection: row.collection,
      slug: row.slug,
      title: typeof title === 'string' && title.trim() ? title : 'Sans titre',
      status: statusOf(row),
      updatedAt: row.draft_updated_at.toISOString(),
      publishedAt: row.published_at?.toISOString() ?? null,
      createdBy: row.created_by,
      authorName: row.author_name,
    };
  }

  async function findRow(id: string, lock = false): Promise<DocumentRow> {
    if (!isUuid(id)) throw notFound();
    const rows = lock
      ? await sql<DocumentRow[]>`
          SELECT d.*, NULL::text AS author_name FROM genga_documents d
          WHERE d.id = ${id} AND d.deleted_at IS NULL FOR UPDATE`
      : await sql<DocumentRow[]>`
          SELECT d.*, ${authorLabel()} AS author_name FROM genga_documents d
          LEFT JOIN genga_users u ON u.id = d.created_by
          WHERE d.id = ${id} AND d.deleted_at IS NULL`;
    if (!rows[0]) throw notFound('Document introuvable.');
    return rows[0];
  }

  function checkSlug(value: unknown): string {
    const slug = typeof value === 'string' ? value.trim() : '';
    if (!SLUG_PATTERN.test(slug)) throw badRequest('Slug invalide : minuscules, chiffres et tirets.');
    if (RESERVED_SLUGS.has(slug)) throw badRequest(`Le slug « ${slug} » est réservé.`);
    return slug;
  }

  function tagCondition(name: string, collection: CollectionConfig, tag: string) {
    const fields = Object.entries(collection.fields)
      .filter(([, field]) => field.type === 'tags')
      .map(([field]) => field);
    if (!fields.length) throw badRequest(`La collection ${name} n'a pas de champ tags.`);
    const value = sql.json([tag] as never);
    return fields
      .map((field) => sql`d.draft->(${field}::text) @> ${value}`)
      .reduce((left, right) => sql`${left} OR ${right}`);
  }

  async function list(user: PublicUser, collectionName: string, options: ListOptions = {}): Promise<DocumentSummary[]> {
    const collection = collectionOf(collectionName);
    assertCan(user, 'read', undefined, collectionName);
    const ownOnly = isOwnOnly(user, collection.access);
    const search = options.search?.trim() ? `%${escapeLike(options.search.trim())}%` : null;
    const status = options.status ?? 'all';
    const tagFilter = options.tag === undefined ? null : tagCondition(collectionName, collection, options.tag);
    const rows = await sql<DocumentRow[]>`
      SELECT d.*, ${authorLabel()} AS author_name FROM genga_documents d
      LEFT JOIN genga_users u ON u.id = d.created_by
      WHERE d.collection = ${collectionName} AND d.deleted_at IS NULL
      ${ownOnly ? sql`AND d.created_by = ${user.id}` : sql``}
      ${search ? sql`AND (d.draft->>${collection.titleField} ILIKE ${search} OR d.slug ILIKE ${search})` : sql``}
      ${tagFilter ? sql`AND (${tagFilter})` : sql``}
      ${status === 'draft' ? sql`AND d.published_version_id IS NULL` : sql``}
      ${status === 'published' ? sql`AND d.published_version_id IS NOT NULL AND d.published_rev = d.draft_rev` : sql``}
      ${status === 'changed' ? sql`AND d.published_version_id IS NOT NULL AND d.published_rev <> d.draft_rev` : sql``}
      ORDER BY d.draft_updated_at DESC, d.id
      LIMIT ${Math.min(options.limit ?? 100, 500)} OFFSET ${options.offset ?? 0}
    `;
    return rows.map(summarize);
  }

  async function counts(user: PublicUser): Promise<Record<string, Record<DocumentStatus, number>>> {
    const result: Record<string, Record<DocumentStatus, number>> = {};
    for (const [name, collection] of Object.entries(ctx.config.collections)) {
      result[name] = { draft: 0, published: 0, changed: 0 };
      if (!can(user, 'read', collection.access)) continue;
      const ownOnly = isOwnOnly(user, collection.access);
      const rows = await sql<
        { published_version_id: string | null; published_rev: number | null; draft_rev: number }[]
      >`
        SELECT published_version_id, published_rev, draft_rev FROM genga_documents
        WHERE collection = ${name} AND deleted_at IS NULL
        ${ownOnly ? sql`AND created_by = ${user.id}` : sql``}
      `;
      for (const row of rows) result[name][statusOf(row)] += 1;
    }
    return result;
  }

  async function scheduleOf(id: string, db: Sql | TransactionSql = sql): Promise<DocumentSchedule> {
    const rows = await db<ScheduleRow[]>`
      SELECT action, run_at, failed_at, last_error FROM genga_schedules WHERE document_id = ${id}
    `;
    return toSchedule(rows);
  }

  /**
   * Deletes the schedule row of `action` in the transaction of the action. A manual action
   * clears it. A scheduled run returns false when the row is no longer due.
   */
  async function consumeSchedule(tx: TransactionSql, id: string, action: ScheduleAction, options: RunOptions) {
    if (!options.scheduled) {
      await tx`DELETE FROM genga_schedules WHERE document_id = ${id} AND action = ${action}`;
      return true;
    }
    const due = await tx`
      DELETE FROM genga_schedules
      WHERE document_id = ${id} AND action = ${action} AND run_at <= now() AND failed_at IS NULL
      RETURNING 1
    `;
    return due.length > 0;
  }

  async function get(user: PublicUser, id: string): Promise<AdminDocument> {
    const row = await findRow(id);
    assertCan(user, 'read', row);
    const collection = collectionOf(row.collection);
    const draft = tolerantRead(collection.fields, row.draft, ctx.blocks);
    const [media, related] = await Promise.all([
      loadMediaMap(ctx, collection.fields, draft),
      relatedRecord(ctx, collection.fields, draft),
    ]);
    return {
      ...summarize(row),
      draft,
      draftRev: row.draft_rev,
      publishedSlug: row.first_published_at ? row.slug : null,
      previewPath: collection.path(row.slug),
      preview: previewTarget(ctx, row.collection, row),
      media: Object.fromEntries(media),
      related,
      canPublish: can(user, 'publish', collection.access, { createdBy: row.created_by }),
      canDelete: can(user, 'delete', collection.access, { createdBy: row.created_by }),
      schedule: await scheduleOf(row.id),
    };
  }

  /** The id of the live document with this slug, if the user can read it. */
  async function findBySlug(user: PublicUser, collectionName: string, slug: string): Promise<string> {
    collectionOf(collectionName);
    const [row] = await sql<Pick<DocumentRow, 'id' | 'collection' | 'created_by'>[]>`
      SELECT id, collection, created_by FROM genga_documents
      WHERE collection = ${collectionName} AND slug = ${slug} AND deleted_at IS NULL
    `;
    // A document that the user cannot read is not found: its slug stays private.
    if (!row || !can(user, 'read', collectionOf(row.collection).access, { createdBy: row.created_by })) {
      throw notFound('Document introuvable.');
    }
    return row.id;
  }

  /** The data of the published version, without media objects, or null when the document is not live. */
  async function publishedData(user: PublicUser, id: string) {
    const row = await findRow(id);
    assertCan(user, 'read', row);
    if (!row.published_version_id) return null;
    const [version] = await sql<{ id: string; slug: string; data: Record<string, unknown>; created_at: Date }[]>`
      SELECT id, slug, data, created_at FROM genga_versions WHERE id = ${row.published_version_id}
    `;
    if (!version) return null;
    const collection = collectionOf(row.collection);
    return {
      versionId: version.id,
      slug: version.slug,
      publishedAt: row.published_at?.toISOString() ?? version.created_at.toISOString(),
      data: tolerantRead(collection.fields, version.data, ctx.blocks),
    };
  }

  async function uniqueSlug(collectionName: string, base: string): Promise<string> {
    const root = RESERVED_SLUGS.has(base) || !base ? `${base || 'document'}-1` : base;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
      const [taken] = await sql`
        SELECT 1 FROM genga_documents WHERE collection = ${collectionName} AND slug = ${candidate} AND deleted_at IS NULL
      `;
      if (!taken) return candidate;
    }
    return `${root}-${crypto.randomUUID().slice(0, 8)}`;
  }

  async function create(user: PublicUser, collectionName: string, input: Record<string, unknown> = {}) {
    const collection = collectionOf(collectionName);
    assertCan(user, 'create', undefined, collectionName);
    const checked = validate(collection.fields, { ...defaultValues(collection.fields), ...input }, 'draft', ctx.blocks);
    if (!checked.ok) throw badRequest('Données invalides.', checked.issues);
    const data = checked.data;
    const title = typeof data[collection.titleField] === 'string' ? (data[collection.titleField] as string) : '';
    const slug = await uniqueSlug(collectionName, (data.slug as string) || slugify(title) || 'sans-titre');
    data.slug = slug;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO genga_documents (collection, slug, draft, created_by, draft_updated_by)
      VALUES (${collectionName}, ${slug}, ${sql.json(data as never)}, ${user.id}, ${user.id})
      RETURNING id
    `;
    await audit(ctx, user.id, 'document.create', { collection: collectionName, documentId: row.id });
    return { id: row.id, slug };
  }

  /** The slug of a document that was ever published changes only at publish, with a redirect. */
  async function saveDraft(user: PublicUser, id: string, input: unknown, draftRev: number) {
    if (!isUuid(id)) throw notFound();
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        SELECT * FROM genga_documents WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
      `;
      if (!row) throw notFound('Document introuvable.');
      assertCan(user, 'update', row);
      if (row.draft_rev !== draftRev) throw conflict(row.draft_rev);
      const collection = collectionOf(row.collection);
      const checked = validate(collection.fields, input, 'draft', ctx.blocks);
      if (!checked.ok) throw badRequest('Données invalides.', checked.issues);
      const data = checked.data;

      let slug = row.slug;
      let slugError: string | null = null;
      const wanted = typeof data.slug === 'string' ? data.slug.trim() : '';
      if (!row.first_published_at && wanted && wanted !== row.slug) {
        if (RESERVED_SLUGS.has(wanted)) {
          slugError = `Le slug « ${wanted} » est réservé.`;
        } else {
          try {
            await tx.savepoint((sp) => sp`UPDATE genga_documents SET slug = ${wanted} WHERE id = ${id}`);
            slug = wanted;
          } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            slugError = `Le slug « ${wanted} » est déjà utilisé.`;
          }
        }
      }

      const [updated] = await tx<
        { draft_rev: number; published_rev: number | null; published_version_id: string | null }[]
      >`
        UPDATE genga_documents
        SET draft = ${tx.json(data as never)}, draft_rev = draft_rev + 1, draft_updated_at = now(),
          draft_updated_by = ${user.id}
        WHERE id = ${id}
        RETURNING draft_rev, published_rev, published_version_id
      `;
      return { updated, slug, slugError, collection };
    });
    return {
      draftRev: result.updated.draft_rev,
      status: statusOf(result.updated),
      slug: result.slug,
      slugError: result.slugError,
      previewPath: result.collection.path(result.slug),
      savedAt: new Date().toISOString(),
    };
  }

  /** Without `draftRev` (a scheduled run), the draft of the moment is published. */
  async function publishDocument(user: PublicUser, id: string, draftRev: number | null, options: RunOptions = {}) {
    if (!isUuid(id)) throw notFound();
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        SELECT * FROM genga_documents WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
      `;
      if (!row) throw notFound('Document introuvable.');
      if (!(await consumeSchedule(tx, id, 'publish', options))) return NOT_DUE;
      assertCan(user, 'publish', row);
      if (draftRev !== null && row.draft_rev !== draftRev) throw conflict(row.draft_rev);
      const collection = collectionOf(row.collection);
      const checked = validate(collection.fields, row.draft, 'publish', ctx.blocks);
      if (!checked.ok)
        throw new GengaError(422, 'invalid', 'Corrigez les champs signalés avant de publier.', checked.issues);
      const slug = checkSlug(checked.data.slug || row.slug);
      // FOR SHARE makes a concurrent media delete wait for this publish, then see the new reference.
      const mediaIds = [...new Set(collectMediaIds(collection.fields, checked.data, ctx.blocks).filter(isUuid))];
      if (mediaIds.length) {
        const found = await tx<{ id: string }[]>`
          SELECT id FROM genga_media WHERE id = ANY(${mediaIds}::uuid[]) FOR SHARE
        `;
        const present = new Set(found.map((media) => media.id));
        const missing = mediaIds.filter((mediaId) => !present.has(mediaId));
        if (missing.length) {
          throw new GengaError(
            422,
            'missing_media',
            'Un média de ce document a été supprimé. Remplacez-le avant de publier.',
            {
              mediaIds: missing,
            },
          );
        }
      }

      // No lock on the targets: two documents that point to each other would deadlock at publish.
      // A target deleted after this check resolves to nothing on the site.
      const relationRefs = collectRelationIds(collection.fields, checked.data, ctx.blocks);
      if (relationRefs.length) {
        const found = await tx<{ id: string; collection: string }[]>`
          SELECT id, collection FROM genga_documents
          WHERE id = ANY(${[...new Set(relationRefs.map((ref) => ref.id))]}::uuid[]) AND deleted_at IS NULL
        `;
        const present = new Set(found.map((target) => `${target.collection}\u0000${target.id}`));
        const missing = relationRefs.filter((ref) => !present.has(`${ref.collection}\u0000${ref.id}`));
        if (missing.length) {
          throw new GengaError(
            422,
            'missing_relation',
            'Un document lié a été supprimé ou n’existe pas dans sa collection. Remplacez-le avant de publier.',
            { documentIds: missing.map((ref) => ref.id) },
          );
        }
      }

      if (slug !== row.slug) {
        try {
          await tx`UPDATE genga_documents SET slug = ${slug} WHERE id = ${id}`;
        } catch (error) {
          if (isUniqueViolation(error))
            throw new GengaError(409, 'slug_taken', `Le slug « ${slug} » est déjà utilisé.`);
          throw error;
        }
        if (row.first_published_at) {
          await tx`UPDATE genga_redirects SET to_slug = ${slug} WHERE collection = ${row.collection} AND to_slug = ${row.slug}`;
          await tx`
            INSERT INTO genga_redirects (collection, from_slug, to_slug) VALUES (${row.collection}, ${row.slug}, ${slug})
            ON CONFLICT (collection, from_slug) DO UPDATE SET to_slug = EXCLUDED.to_slug
          `;
        }
      }
      await tx`DELETE FROM genga_redirects WHERE collection = ${row.collection} AND from_slug = ${slug}`;

      const [version] = await tx<{ id: string }[]>`
        INSERT INTO genga_versions (document_id, kind, slug, data, created_by)
        VALUES (${id}, 'published', ${slug}, ${tx.json(checked.data as never)}, ${user.id})
        RETURNING id
      `;
      const [updated] = await tx<{ published_at: Date }[]>`
        UPDATE genga_documents
        SET published_version_id = ${version.id}, published_rev = draft_rev,
          published_at = COALESCE(published_at, now()), first_published_at = COALESCE(first_published_at, now())
        WHERE id = ${id}
        RETURNING published_at
      `;
      const previousSlug = row.first_published_at && slug !== row.slug ? row.slug : null;
      const eventInput = {
        collection: row.collection,
        documentId: id,
        slug,
        path: collection.path,
        previousSlug,
        versionId: version.id,
        at: new Date().toISOString(),
        referencing: referencingCollections(ctx, row.collection),
      };
      const events = [documentEvent('document.published', eventInput)];
      if (previousSlug) events.push(documentEvent('document.slug_changed', eventInput));
      await ctx.events.record(tx, events);
      return {
        events,
        collection: row.collection,
        slug,
        previousSlug,
        versionId: version.id,
        publishedAt: updated.published_at.toISOString(),
        previewPath: collection.path(slug),
      };
    });
    if (result === NOT_DUE) return NOT_DUE;
    const { events, ...published } = result;
    invalidatePublished(ctx, published.collection);
    try {
      await audit(ctx, user.id, 'document.publish', {
        collection: published.collection,
        documentId: id,
        detail: {
          versionId: published.versionId,
          previousSlug: published.previousSlug,
          ...(options.scheduled && { scheduled: true }),
        },
      });
    } finally {
      await ctx.events.dispatch(events);
    }
    return { ...published, status: 'published' as DocumentStatus };
  }

  /**
   * Takes the document offline in one transaction. An event goes to the outbox only when the
   * document was live: the events endpoint is public, and a draft slug must stay private.
   */
  async function takeOffline(
    user: PublicUser,
    id: string,
    action: 'publish' | 'delete',
    remove: boolean,
    options: RunOptions = {},
  ) {
    if (!isUuid(id)) throw notFound();
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        SELECT * FROM genga_documents WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
      `;
      if (!row) throw notFound('Document introuvable.');
      if (remove) await tx`DELETE FROM genga_schedules WHERE document_id = ${id}`;
      else if (!(await consumeSchedule(tx, id, 'unpublish', options))) return NOT_DUE;
      assertCan(user, action, row);
      await tx`
        UPDATE genga_documents
        SET published_version_id = NULL, published_rev = NULL, published_at = NULL
          ${remove ? tx`, deleted_at = now()` : tx``}
        WHERE id = ${id}
      `;
      const events = row.published_version_id
        ? [
            documentEvent(remove ? 'document.deleted' : 'document.unpublished', {
              collection: row.collection,
              documentId: id,
              slug: row.slug,
              path: collectionOf(row.collection).path,
              at: new Date().toISOString(),
              referencing: referencingCollections(ctx, row.collection),
            }),
          ]
        : [];
      await ctx.events.record(tx, events);
      return { row, events };
    });
    if (result === NOT_DUE) return NOT_DUE;
    const { row, events } = result;
    invalidatePublished(ctx, row.collection);
    try {
      await audit(ctx, user.id, remove ? 'document.delete' : 'document.unpublish', {
        collection: row.collection,
        documentId: id,
        ...(options.scheduled && { detail: { scheduled: true } }),
      });
    } finally {
      await ctx.events.dispatch(events);
    }
    return null;
  }

  async function publish(user: PublicUser, id: string, draftRev: number) {
    const result = await publishDocument(user, id, draftRev);
    if (result === NOT_DUE) throw new Error('A manual publish has no schedule to wait for.');
    return result;
  }

  async function unpublish(user: PublicUser, id: string) {
    await takeOffline(user, id, 'publish', false);
    return { status: 'draft' as DocumentStatus };
  }

  /**
   * For the runner: does a due scheduled action as the user who saved it. Returns false when
   * the schedule was cleared, moved or done after the runner listed it.
   */
  async function runScheduled(user: PublicUser, id: string, action: ScheduleAction): Promise<boolean> {
    const result =
      action === 'publish'
        ? await publishDocument(user, id, null, { scheduled: true })
        : await takeOffline(user, id, 'publish', false, { scheduled: true });
    return result !== NOT_DUE;
  }

  /**
   * Sets or clears the dates of a scheduled publish and unpublish. A key that is absent stays as
   * it is, and `null` clears it. Saving a date again clears the error of a failed run.
   */
  async function schedule(user: PublicUser, id: string, input: { publishAt?: unknown; unpublishAt?: unknown }) {
    if (!isUuid(id)) throw notFound();
    const publishAt = scheduleDate(input.publishAt, 'publication');
    const unpublishAt = scheduleDate(input.unpublishAt, 'dépublication');
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        SELECT * FROM genga_documents WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
      `;
      if (!row) throw notFound('Document introuvable.');
      assertCan(user, 'publish', row);
      const [{ now }] = await tx<{ now: Date }[]>`SELECT now()`;
      const current = await scheduleOf(id, tx);
      const nextPublish = publishAt === undefined ? current.publish && new Date(current.publish.at) : publishAt;
      const nextUnpublish =
        unpublishAt === undefined ? current.unpublish && new Date(current.unpublish.at) : unpublishAt;
      if (publishAt && publishAt <= now) throw badRequest('Choisissez une date de publication dans le futur.');
      if (unpublishAt && unpublishAt <= now) throw badRequest('Choisissez une date de dépublication dans le futur.');
      if (nextPublish && nextUnpublish && nextUnpublish <= nextPublish) {
        throw badRequest('La dépublication doit venir après la publication.');
      }
      for (const [action, date] of [
        ['publish', publishAt],
        ['unpublish', unpublishAt],
      ] as const) {
        if (date === undefined) continue;
        if (date === null) {
          await tx`DELETE FROM genga_schedules WHERE document_id = ${id} AND action = ${action}`;
          continue;
        }
        await tx`
          INSERT INTO genga_schedules (document_id, action, run_at, created_by)
          VALUES (${id}, ${action}, ${date}, ${user.id})
          ON CONFLICT (document_id, action) DO UPDATE
          SET run_at = EXCLUDED.run_at, created_by = EXCLUDED.created_by, created_at = now(),
            failed_at = NULL, last_error = NULL
        `;
      }
      return { collection: row.collection, schedule: await scheduleOf(id, tx) };
    });
    await audit(ctx, user.id, 'document.schedule', {
      collection: result.collection,
      documentId: id,
      detail: { publishAt: result.schedule.publish?.at ?? null, unpublishAt: result.schedule.unpublish?.at ?? null },
    });
    return { schedule: result.schedule };
  }

  async function saveVersion(user: PublicUser, id: string, note: unknown) {
    const row = await findRow(id);
    assertCan(user, 'update', row);
    const text = typeof note === 'string' ? note.trim().slice(0, 200) : '';
    const [version] = await sql<{ id: string }[]>`
      INSERT INTO genga_versions (document_id, kind, slug, data, note, created_by)
      VALUES (${id}, 'draft', ${row.slug}, ${sql.json(row.draft as never)}, ${text || null}, ${user.id})
      RETURNING id
    `;
    return { id: version.id };
  }

  async function versions(user: PublicUser, id: string): Promise<VersionSummary[]> {
    const row = await findRow(id);
    assertCan(user, 'read', row);
    const rows = await sql<
      { id: string; kind: VersionSummary['kind']; note: string | null; created_at: Date; author_name: string | null }[]
    >`
      SELECT v.id, v.kind, v.note, v.created_at, ${authorLabel()} AS author_name
      FROM genga_versions v LEFT JOIN genga_users u ON u.id = v.created_by
      WHERE v.document_id = ${id} ORDER BY v.created_at DESC LIMIT 100
    `;
    return rows.map((version) => ({
      id: version.id,
      kind: version.kind,
      note: version.note,
      createdAt: version.created_at.toISOString(),
      authorName: version.author_name,
      isPublished: version.id === row.published_version_id,
    }));
  }

  /**
   * Copies a version into the draft. It does not publish. The current draft is kept
   * as a version first, so the restore loses no work.
   */
  async function restore(user: PublicUser, id: string, versionId: string, draftRev: number) {
    if (!isUuid(id) || !isUuid(versionId)) throw notFound('Version introuvable.');
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<DocumentRow[]>`
        SELECT * FROM genga_documents WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
      `;
      if (!row) throw notFound('Document introuvable.');
      assertCan(user, 'update', row);
      if (row.draft_rev !== draftRev) throw conflict(row.draft_rev);
      const [version] = await tx<{ data: Record<string, unknown> }[]>`
        SELECT data FROM genga_versions WHERE id = ${versionId} AND document_id = ${id}
      `;
      if (!version) throw notFound('Version introuvable.');
      const collection = collectionOf(row.collection);
      const data = tolerantRead(collection.fields, version.data, ctx.blocks);
      // now() is the same for the whole transaction: clock_timestamp() keeps the two versions in order.
      await tx`
        INSERT INTO genga_versions (document_id, kind, slug, data, note, created_by, created_at)
        VALUES (${id}, 'draft', ${row.slug}, ${tx.json(row.draft as never)}, 'Avant restauration', ${user.id}, clock_timestamp())
      `;
      const [updated] = await tx<
        { draft_rev: number; published_rev: number | null; published_version_id: string | null }[]
      >`
        UPDATE genga_documents
        SET draft = ${tx.json(data as never)}, draft_rev = draft_rev + 1, draft_updated_at = now(), draft_updated_by = ${user.id}
        WHERE id = ${id}
        RETURNING draft_rev, published_rev, published_version_id
      `;
      await tx`
        INSERT INTO genga_versions (document_id, kind, slug, data, note, created_by, created_at)
        VALUES (${id}, 'restored', ${row.slug}, ${tx.json(data as never)}, ${`Restaurée depuis ${versionId.slice(0, 8)}`}, ${user.id}, clock_timestamp())
      `;
      return { collection: row.collection, updated, data };
    });
    await audit(ctx, user.id, 'document.restore', {
      collection: result.collection,
      documentId: id,
      detail: { versionId },
    });
    return { draftRev: result.updated.draft_rev, status: statusOf(result.updated), draft: result.data };
  }

  /** Unpublishes, then soft deletes. The slug becomes free again. */
  async function remove(user: PublicUser, id: string) {
    await takeOffline(user, id, 'delete', true);
  }

  /** For the runner: records why a scheduled action cannot run. It stays until the schedule is saved again. */
  async function failSchedule(id: string, action: ScheduleAction, message: string) {
    const rows = await sql<{ collection: string; created_by: string | null }[]>`
      UPDATE genga_schedules s SET failed_at = now(), last_error = ${message}
      FROM genga_documents d
      WHERE s.document_id = ${id} AND s.action = ${action} AND s.failed_at IS NULL AND d.id = s.document_id
      RETURNING d.collection, s.created_by
    `;
    if (!rows[0]) return;
    await audit(ctx, rows[0].created_by, 'document.schedule_failed', {
      collection: rows[0].collection,
      documentId: id,
      detail: { action, error: message },
    });
  }

  return {
    list,
    counts,
    get,
    findBySlug,
    publishedData,
    create,
    saveDraft,
    publish,
    unpublish,
    schedule,
    runScheduled,
    failSchedule,
    saveVersion,
    versions,
    restore,
    remove,
    collectionOf,
  };
}

export type GengaDocuments = ReturnType<typeof createDocuments>;
