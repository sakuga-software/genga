import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import type { Sql, TransactionSql } from 'postgres';
import sharp from 'sharp';
import { can } from '../access';
import type { Fields, MediaObject } from '../fields/types';
import { collectMediaIds } from '../populate';
import type { MediaItem, PublicUser } from '../types';
import { isUuid } from '../uuid';
import { audit } from './auth';
import type { GengaContext } from './context';
import { badRequest, forbidden, GengaError, notFound } from './errors';
import { DEFAULT_MEDIA_PATH } from '../paths';

export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};
const IMAGE_WIDTHS = [480, 960, 1600];
const LIMIT_INPUT_PIXELS = 50_000_000;
export const MEDIA_KEY_PATTERN = /^([a-f0-9]{64})(-w\d+)?\.([a-z0-9]+)$/;

type MediaRow = {
  id: string;
  hash: string;
  key: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  sizes: { width: number; key: string }[];
  created_at: Date;
  created_by: string | null;
};

export function mediaUrl(key: string, mediaPath = DEFAULT_MEDIA_PATH) {
  return `${mediaPath}/${key}`;
}

export function toMediaObject(row: MediaRow, mediaPath = DEFAULT_MEDIA_PATH): MediaObject {
  return {
    id: row.id,
    url: mediaUrl(row.key, mediaPath),
    filename: row.filename,
    mime: row.mime,
    alt: row.alt,
    width: row.width,
    height: row.height,
    sizes: (row.sizes ?? []).map((size) => ({ width: size.width, url: mediaUrl(size.key, mediaPath) })),
  };
}

function toItem(row: MediaRow, mediaPath: string): MediaItem {
  return { ...toMediaObject(row, mediaPath), size: row.size, createdAt: row.created_at.toISOString() };
}

export async function loadMediaMap(
  ctx: GengaContext,
  fields: Fields,
  data: unknown,
): Promise<Map<string, MediaObject>> {
  const ids = collectMediaIds(fields, data, ctx.blocks).filter(isUuid);
  if (!ids.length) return new Map();
  const rows = await ctx.sql<MediaRow[]>`SELECT * FROM genga_media WHERE id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((row) => [row.id, toMediaObject(row, ctx.mediaPath)]));
}

function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'fichier';
  // oxlint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'fichier';
}

async function processImage(input: Buffer, mime: string) {
  const image = sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS, animated: mime === 'image/gif' });
  const metadata = await image.metadata();
  // Animated GIFs keep their bytes: sharp would keep the first frame only in most outputs.
  // Other formats are encoded again, which drops EXIF, GPS and other metadata.
  let original = input;
  if (mime !== 'image/gif') {
    const rotated = sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS }).rotate();
    const format = ALLOWED_MIME[mime] === 'jpg' ? 'jpeg' : (ALLOWED_MIME[mime] as 'png' | 'webp' | 'avif');
    original = await rotated.toFormat(format, format === 'jpeg' ? { quality: 88, mozjpeg: true } : {}).toBuffer();
  }
  const oriented = await sharp(original, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
  const width = oriented.width ?? metadata.width ?? null;
  const height = oriented.height ?? metadata.height ?? null;
  const sizes: { width: number; body: Buffer }[] = [];
  for (const target of IMAGE_WIDTHS) {
    if (!width || target >= width) continue;
    const body = await sharp(original, { limitInputPixels: LIMIT_INPUT_PIXELS })
      .resize({ width: target })
      .webp({ quality: 80 })
      .toBuffer();
    sizes.push({ width: target, body });
  }
  return { original, width, height, sizes };
}

/** Upload and delete of the same bytes wait for each other, so a delete never removes the files of a new row. */
function lockHash(tx: TransactionSql, hash: string) {
  return tx`SELECT pg_advisory_xact_lock(hashtextextended(${`genga_media:${hash}`}, 0))`;
}

export function createMedia(ctx: GengaContext) {
  const { sql } = ctx;
  const toMediaItem = (row: MediaRow) => toItem(row, ctx.mediaPath);

  function canPublishSomewhere(user: PublicUser) {
    return Object.values(ctx.config.collections).some((collection) => can(user, 'publish', collection.access));
  }

  async function list(user: PublicUser, options: { search?: string; limit?: number } = {}): Promise<MediaItem[]> {
    if (!user) throw forbidden();
    const search = options.search?.trim() ? `%${options.search.trim().replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await sql<MediaRow[]>`
      SELECT * FROM genga_media
      ${search ? sql`WHERE filename ILIKE ${search} OR alt ILIKE ${search}` : sql``}
      ORDER BY created_at DESC LIMIT ${Math.min(options.limit ?? 200, 500)}
    `;
    return rows.map(toMediaItem);
  }

  async function upload(user: PublicUser, file: File, alt = ''): Promise<{ media: MediaItem; deduplicated: boolean }> {
    if (!can(user, 'media.upload')) throw forbidden();
    if (!(file instanceof Blob)) throw badRequest('Aucun fichier reçu.');
    if (file.size === 0) throw badRequest('Le fichier est vide.');
    if (file.size > ctx.maxUploadBytes) {
      throw new GengaError(
        413,
        'too_large',
        `Fichier trop lourd (max ${Math.round(ctx.maxUploadBytes / 1_000_000)} Mo).`,
      );
    }
    const input = Buffer.from(await file.arrayBuffer());
    const detected = await fileTypeFromBuffer(input);
    const extension = detected ? ALLOWED_MIME[detected.mime] : undefined;
    if (!detected || !extension) {
      throw new GengaError(
        415,
        'unsupported_type',
        'Type de fichier refusé. Formats acceptés : JPEG, PNG, WebP, AVIF, GIF, PDF.',
      );
    }
    const hash = createHash('sha256').update(input).digest('hex');
    const existing = await sql.begin(async (tx) => {
      await lockHash(tx, hash);
      const [row] = await tx<MediaRow[]>`SELECT * FROM genga_media WHERE hash = ${hash}`;
      return row;
    });
    if (existing) return { media: toMediaItem(existing), deduplicated: true };

    const key = `${hash}.${extension}`;
    let body: Buffer = input;
    let width: number | null = null;
    let height: number | null = null;
    let resized: { width: number; body: Buffer }[] = [];
    if (detected.mime.startsWith('image/')) {
      let processed;
      try {
        processed = await processImage(input, detected.mime);
      } catch (error) {
        ctx.log.warn('[genga] Image processing failed:', error);
        throw new GengaError(415, 'unsupported_type', "Cette image n'a pas pu être lue.");
      }
      body = processed.original;
      width = processed.width;
      height = processed.height;
      resized = processed.sizes;
    }
    const result = await sql.begin(async (tx) => {
      await lockHash(tx, hash);
      const [winner] = await tx<MediaRow[]>`SELECT * FROM genga_media WHERE hash = ${hash}`;
      if (winner) return { row: winner, deduplicated: true };
      const sizes: { width: number; key: string }[] = [];
      for (const size of resized) {
        const sizeKey = `${hash}-w${size.width}.webp`;
        await ctx.storage.put(sizeKey, size.body, 'image/webp');
        sizes.push({ width: size.width, key: sizeKey });
      }
      await ctx.storage.put(key, body, detected.mime);
      const [row] = await tx<MediaRow[]>`
        INSERT INTO genga_media (hash, key, filename, mime, size, width, height, alt, sizes, created_by)
        VALUES (${hash}, ${key}, ${cleanFilename(file.name || 'fichier')}, ${detected.mime}, ${body.length},
          ${width}, ${height}, ${String(alt).slice(0, 500)}, ${tx.json(sizes as never)}, ${user.id})
        RETURNING *
      `;
      return { row, deduplicated: false };
    });
    if (!result.deduplicated) await audit(ctx, user.id, 'media.upload', { detail: { mediaId: result.row.id } });
    return { media: toMediaItem(result.row), deduplicated: result.deduplicated };
  }

  async function updateAlt(user: PublicUser, id: string, alt: unknown): Promise<MediaItem> {
    if (!can(user, 'media.upload')) throw forbidden();
    if (!isUuid(id)) throw notFound('Média introuvable.');
    const text = typeof alt === 'string' ? alt.trim().slice(0, 500) : '';
    const [current] = await sql<MediaRow[]>`SELECT created_by FROM genga_media WHERE id = ${id}`;
    if (!current) throw notFound('Média introuvable.');
    // The alt text shows on every published page that uses the media.
    if (current.created_by !== user.id && !canPublishSomewhere(user)) throw forbidden();
    const [row] = await sql<MediaRow[]>`UPDATE genga_media SET alt = ${text} WHERE id = ${id} RETURNING *`;
    if (!row) throw notFound('Média introuvable.');
    for (const name of Object.keys(ctx.config.collections)) ctx.cache.invalidate(name);
    return toMediaItem(row);
  }

  /** The live documents whose draft or published version contains the media id. */
  async function references(
    id: string,
    db: Sql | TransactionSql = sql,
  ): Promise<{ id: string; collection: string; title: string }[]> {
    const rows = await db<{ id: string; collection: string; draft: Record<string, unknown> }[]>`
      SELECT d.id, d.collection, d.draft FROM genga_documents d
      LEFT JOIN genga_versions v ON v.id = d.published_version_id
      WHERE d.deleted_at IS NULL AND (
        jsonb_path_exists(d.draft, '$.** ? (@ == $id)', jsonb_build_object('id', ${id}::text))
        OR (v.id IS NOT NULL AND jsonb_path_exists(v.data, '$.** ? (@ == $id)', jsonb_build_object('id', ${id}::text)))
      )
    `;
    return rows.map((row) => {
      const collection = ctx.config.collections[row.collection];
      const title = collection ? row.draft?.[collection.titleField] : null;
      return {
        id: row.id,
        collection: row.collection,
        title: typeof title === 'string' && title ? title : 'Sans titre',
      };
    });
  }

  /** The media row stays locked while the references are checked, so a publish cannot add one in between. */
  async function remove(user: PublicUser, id: string) {
    if (!can(user, 'media.delete')) throw forbidden();
    if (!isUuid(id)) throw notFound('Média introuvable.');
    const row = await sql.begin(async (tx) => {
      const [row] = await tx<MediaRow[]>`SELECT * FROM genga_media WHERE id = ${id} FOR UPDATE`;
      if (!row) throw notFound('Média introuvable.');
      await lockHash(tx, row.hash);
      const used = await references(id, tx);
      if (used.length) {
        throw new GengaError(
          409,
          'media_in_use',
          `Ce média est utilisé par : ${used.map((doc) => doc.title).join(', ')}. Retirez-le de ces documents avant de le supprimer.`,
          { documents: used },
        );
      }
      await tx`DELETE FROM genga_media WHERE id = ${id}`;
      for (const key of [row.key, ...(row.sizes ?? []).map((size) => size.key)]) {
        await ctx.storage.delete(key).catch((error) => ctx.log.warn('[genga] Media file delete failed:', error));
      }
      return row;
    });
    await audit(ctx, user.id, 'media.delete', { detail: { mediaId: id, filename: row.filename } });
  }

  /** The metadata of one media item, without an access check. Its files are public too. */
  async function find(id: string): Promise<MediaItem | null> {
    if (!isUuid(id)) return null;
    const [row] = await sql<MediaRow[]>`SELECT * FROM genga_media WHERE id = ${id}`;
    return row ? toMediaItem(row) : null;
  }

  /** Serves `<mediaPath>/<key>`. The key must match the pattern and a database row. */
  async function serve(key: string): Promise<Response> {
    const match = MEDIA_KEY_PATTERN.exec(key);
    if (!match) return new Response('Not found', { status: 404 });
    const [row] = await sql<MediaRow[]>`SELECT * FROM genga_media WHERE hash = ${match[1]}`;
    const isOriginal = row?.key === key;
    const isSize = row?.sizes?.some((size) => size.key === key);
    if (!row || (!isOriginal && !isSize)) return new Response('Not found', { status: 404 });
    const file = await ctx.storage.get(key);
    if (!file) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type': isOriginal ? row.mime : 'image/webp',
      'Content-Length': String(file.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cross-Origin-Resource-Policy': ctx.mediaResourcePolicy,
    });
    if (row.mime === 'application/pdf') {
      headers.set('Content-Disposition', `attachment; filename="${row.filename.replace(/[^\w.-]/g, '_')}"`);
    }
    return new Response(file.body, { headers });
  }

  return { list, find, upload, updateAlt, references, remove, serve };
}

export type GengaMedia = ReturnType<typeof createMedia>;
