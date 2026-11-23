import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CollectionConfig } from '../config';
import type { PreviewTarget } from '../types';

export type { PreviewTarget };
import type { GengaContext } from './context';
import { originOf } from './origin';
import { PREVIEW_PARAM } from './published';

export { PREVIEW_TOKEN_PARAM } from '../preview/bridge';
import { PREVIEW_TOKEN_PARAM } from '../preview/bridge';
export const PREVIEW_TOKEN_TTL_MS = 10 * 60_000;
export const MIN_SECRET_LENGTH = 32;

function signature(secret: string, documentId: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`genga-preview.v1.${documentId}.${expiresAt}`).digest('base64url');
}

/** A token that gives read access to the draft of one document until it expires. */
export function createPreviewToken(
  secret: string,
  documentId: string,
  options: { now?: number; ttlMs?: number } = {},
): string {
  const expiresAt = Math.floor(((options.now ?? Date.now()) + (options.ttlMs ?? PREVIEW_TOKEN_TTL_MS)) / 1000);
  return `${expiresAt.toString(36)}.${signature(secret, documentId, expiresAt)}`;
}

export function verifyPreviewToken(
  secret: string,
  token: string | null | undefined,
  documentId: string,
  now = Date.now(),
): boolean {
  if (!token || token.length > 200) return false;
  const [expiry, given, extra] = token.split('.');
  if (!expiry || !given || extra !== undefined || !/^[0-9a-z]+$/.test(expiry)) return false;
  const expiresAt = Number.parseInt(expiry, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= now) return false;
  const expected = Buffer.from(signature(secret, documentId, expiresAt));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function previewUrlOf(
  ctx: GengaContext,
  collection: CollectionConfig,
  name: string,
  doc: { id: string; slug: string },
) {
  const path = collection.path(doc.slug);
  const raw = collection.previewUrl
    ? collection.previewUrl({ id: doc.id, slug: doc.slug, collection: name, path })
    : path;
  return new URL(raw, `${ctx.siteUrl}/`);
}

/**
 * The URL of the preview frame for a document, or null when the collection has no preview.
 * A preview on another origin gets a preview token in the URL.
 */
export function previewTarget(
  ctx: GengaContext,
  name: string,
  doc: { id: string; slug: string },
): PreviewTarget | null {
  const collection = ctx.config.collections[name];
  if (!collection || collection.previewUrl === false) return null;
  const url = previewUrlOf(ctx, collection, name, doc);
  url.searchParams.set(PREVIEW_PARAM, doc.id);
  if (url.origin === originOf(ctx.siteUrl)) return { url: `${url.pathname}${url.search}`, origin: null };
  // A previewUrl function can give another origin per document: check each URL, not only the sample at start.
  if (!ctx.previewOrigins.includes(url.origin) || !ctx.previewSecret) {
    ctx.log.warn(`[genga] No preview for ${name}/${doc.slug}: the origin ${url.origin} is not a preview origin.`);
    return null;
  }
  url.searchParams.set(PREVIEW_TOKEN_PARAM, createPreviewToken(ctx.previewSecret, doc.id));
  return { url: url.href, origin: url.origin };
}

/** Throws at start if a preview on another origin is not allowed or has no secret. */
export function checkPreviewConfig(ctx: GengaContext) {
  const siteOrigin = originOf(ctx.siteUrl);
  if (ctx.previewSecret !== null && ctx.previewSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Genga: the preview secret must have at least ${MIN_SECRET_LENGTH} characters.`);
  }
  for (const [name, collection] of Object.entries(ctx.config.collections)) {
    if (!collection.previewUrl) continue;
    let url: URL;
    try {
      url = previewUrlOf(ctx, collection, name, { id: '00000000-0000-4000-8000-000000000000', slug: 'example' });
    } catch {
      throw new Error(`Genga: the preview URL of the collection "${name}" is not a valid URL.`);
    }
    if (url.origin === siteOrigin) continue;
    if (!ctx.previewOrigins.includes(url.origin)) {
      throw new Error(
        `Genga: the preview URL of the collection "${name}" has the origin ${url.origin}. Add it to the preview origins (GENGA_PREVIEW_ORIGINS).`,
      );
    }
    if (!ctx.previewSecret) {
      throw new Error(
        `Genga: the collection "${name}" has a preview on another origin. Set a preview secret (GENGA_SECRET) of ${MIN_SECRET_LENGTH} characters or more.`,
      );
    }
  }
}
