export const GENGA_EVENT_TYPES = [
  'document.published',
  'document.unpublished',
  'document.deleted',
  'document.slug_changed',
  'media.updated',
  'media.deleted',
] as const;

export type GengaEventType = (typeof GENGA_EVENT_TYPES)[number];

/** A change of published content. Webhooks send it as their JSON body. */
export type GengaEvent = {
  /** UUID. It stays the same across webhook retries. */
  id: string;
  type: GengaEventType;
  /** ISO time of the change. */
  at: string;
  /** Null for media events. */
  collection: string | null;
  documentId: string | null;
  slug: string | null;
  /** The path of the document on the site. */
  path: string | null;
  /** The slug and path before a slug change. */
  previous: { slug: string; path: string } | null;
  versionId: string | null;
  /** The cache tags to invalidate. */
  tags: string[];
  /** The media id of a media event. */
  mediaId?: string;
};

export const ALL_TAG = 'genga';

/**
 * The cache tags of a read: `genga`, `genga:c:<collection>`, and with a slug,
 * `genga:d:<collection>:<slug>`. Publish events carry the same tags.
 */
export function tagsFor(collection: string, slug?: string | null): string[] {
  const tags = [ALL_TAG, `${ALL_TAG}:c:${collection}`];
  if (slug) tags.push(`${ALL_TAG}:d:${collection}:${slug}`);
  return tags;
}

/** The tags that a document event invalidates: the collection, the slug, and the old slug. */
export function documentEventTags(collection: string, slug: string, previousSlug?: string | null): string[] {
  const tags = [`${ALL_TAG}:c:${collection}`, `${ALL_TAG}:d:${collection}:${slug}`];
  if (previousSlug && previousSlug !== slug) tags.push(`${ALL_TAG}:d:${collection}:${previousSlug}`);
  return tags;
}

export function isGengaEventType(value: unknown): value is GengaEventType {
  return typeof value === 'string' && (GENGA_EVENT_TYPES as readonly string[]).includes(value);
}
