import type { BlockSchemas } from './fields/schema';
import type { Field, Fields, MediaField, MediaObject, RelationField } from './fields/types';

/** Called for each media field and each relation field. The other leaf fields keep their value. */
type Visitor = (field: MediaField | RelationField, value: unknown) => unknown;

function mapValue(field: Field, value: unknown, blocks: BlockSchemas, visit: Visitor): unknown {
  switch (field.type) {
    case 'media':
    case 'relation':
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
  mapFields(fields, data, blocks, (field, value) => {
    if (field.type === 'media' && typeof value === 'string' && value) ids.add(value);
    return value;
  });
  return [...ids];
}

function relationIds(field: RelationField, value: unknown): string[] {
  if (!field.multiple) return typeof value === 'string' && value !== '' ? [value] : [];
  const values = Array.isArray(value) ? value : [];
  return values.filter((id): id is string => typeof id === 'string' && id !== '');
}

/** The document ids of the relation fields, with the collection that each field points to. */
export function collectRelationIds(
  fields: Fields,
  data: unknown,
  blocks: BlockSchemas,
): { id: string; collection: string }[] {
  const found = new Map<string, { id: string; collection: string }>();
  mapFields(fields, data, blocks, (field, value) => {
    if (field.type !== 'relation') return value;
    for (const id of relationIds(field, value)) found.set(`${field.to}\u0000${id}`, { id, collection: field.to });
    return value;
  });
  return [...found.values()];
}

/**
 * Gives the value of one relation target, or null when the target does not resolve. The default
 * gives a `RelationRef` and reads nothing.
 */
export type RelationResolver = (field: RelationField, id: string) => unknown;

const refOnly: RelationResolver = (field, id) => ({ id, collection: field.to });

/**
 * Replaces each media id with its media object. A missing row gives `null`:
 * a restored version can point to media that a user deleted later.
 * Each relation id goes through `resolve`. A single relation that does not resolve gives `null`;
 * a multiple relation leaves it out.
 */
export function populate<T = Record<string, unknown>>(
  fields: Fields,
  data: Record<string, unknown>,
  blocks: BlockSchemas,
  media: ReadonlyMap<string, MediaObject>,
  resolve: RelationResolver = refOnly,
): T {
  return mapFields(fields, data, blocks, (field, value) => {
    if (field.type === 'media') return typeof value === 'string' ? (media.get(value) ?? null) : null;
    const resolved = relationIds(field, value)
      .map((id) => resolve(field, id))
      .filter((item) => item !== null && item !== undefined);
    return field.multiple ? resolved : (resolved[0] ?? null);
  }) as T;
}
