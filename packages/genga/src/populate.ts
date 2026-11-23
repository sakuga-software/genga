import type { BlockSchemas } from './fields/schema';
import type { Field, Fields, MediaObject } from './fields/types';

type Visitor = (field: Field, value: unknown) => unknown;

function mapValue(field: Field, value: unknown, blocks: BlockSchemas, visit: Visitor): unknown {
  switch (field.type) {
    case 'media':
      return visit(field, value);
    case 'group':
      return mapFields(field.fields, value, blocks, visit);
    case 'array':
      return Array.isArray(value) ? value.map((item) => mapFields(field.fields, item, blocks, visit)) : value;
    case 'blocks':
      if (!Array.isArray(value)) return value;
      return value.map((item) => {
        const type = (item as { _type?: unknown })?._type;
        const definition = typeof type === 'string' ? blocks[type] : undefined;
        return definition ? mapFields(definition.fields, item, blocks, visit) : item;
      });
    default:
      return value;
  }
}

function mapFields(fields: Fields, data: unknown, blocks: BlockSchemas, visit: Visitor): unknown {
  if (!data || typeof data !== 'object') return data;
  const source = data as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  for (const [name, field] of Object.entries(fields)) {
    result[name] = mapValue(field, source[name], blocks, visit);
  }
  return result;
}

export function collectMediaIds(fields: Fields, data: unknown, blocks: BlockSchemas): string[] {
  const ids = new Set<string>();
  mapFields(fields, data, blocks, (_field, value) => {
    if (typeof value === 'string' && value) ids.add(value);
    return value;
  });
  return [...ids];
}

/**
 * Replaces each media id with its media object. A missing row gives `null`:
 * a restored version can point to media that a user deleted later.
 */
export function populate<T = Record<string, unknown>>(
  fields: Fields,
  data: Record<string, unknown>,
  blocks: BlockSchemas,
  media: ReadonlyMap<string, MediaObject>,
): T {
  return mapFields(fields, data, blocks, (_field, value) =>
    typeof value === 'string' ? (media.get(value) ?? null) : null,
  ) as T;
}
