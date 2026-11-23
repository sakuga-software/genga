import type { BlockSchemas } from './fields/schema';
import type { Field, Fields, MediaObject } from './fields/types';
import type { RichTextDoc } from './rich-text-sanitize';
import { richTextToHtml } from './rich-text-html';

/** A rich text value in the public shape: the TipTap JSON plus its sanitized HTML. */
export type PublicRichText = RichTextDoc & { html: string };

function absoluteUrl(url: string, baseUrl: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `${baseUrl}${url}` : url;
}

function publicMedia(value: unknown, baseUrl: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const media = value as MediaObject;
  return {
    ...media,
    url: absoluteUrl(media.url, baseUrl),
    sizes: (media.sizes ?? []).map((size) => ({ ...size, url: absoluteUrl(size.url, baseUrl) })),
  };
}

function publicValue(field: Field, value: unknown, blocks: BlockSchemas, baseUrl: string): unknown {
  switch (field.type) {
    case 'media':
      return publicMedia(value, baseUrl);
    case 'richText':
      return value && typeof value === 'object' ? { ...value, html: richTextToHtml(value as RichTextDoc) } : value;
    case 'group':
      return publicFields(field.fields, value, blocks, baseUrl);
    case 'array':
      return Array.isArray(value) ? value.map((item) => publicFields(field.fields, item, blocks, baseUrl)) : value;
    case 'blocks':
      if (!Array.isArray(value)) return value;
      return value.map((item) => {
        const type = (item as { _type?: unknown })?._type;
        const definition = typeof type === 'string' ? blocks[type] : undefined;
        return definition ? publicFields(definition.fields, item, blocks, baseUrl) : item;
      });
    default:
      return value;
  }
}

function publicFields(fields: Fields, data: unknown, blocks: BlockSchemas, baseUrl: string): unknown {
  if (!data || typeof data !== 'object') return data;
  const source = data as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  for (const [name, field] of Object.entries(fields)) {
    result[name] = publicValue(field, source[name], blocks, baseUrl);
  }
  return result;
}

/**
 * Turns populated data into the shape of the public API: media URLs become absolute
 * with `baseUrl`, and each rich text value gets an `html` string. The editor sends
 * the same shape to a preview on another origin.
 */
export function toPublicData<T = Record<string, unknown>>(
  fields: Fields,
  data: Record<string, unknown>,
  blocks: BlockSchemas,
  baseUrl: string,
): T {
  return publicFields(fields, data, blocks, baseUrl.replace(/\/+$/, '')) as T;
}

/** A media object with absolute URLs. */
export function toPublicMedia(media: MediaObject, baseUrl: string): MediaObject {
  return publicMedia(media, baseUrl.replace(/\/+$/, '')) as MediaObject;
}
