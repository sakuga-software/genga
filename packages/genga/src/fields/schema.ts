import { z } from 'zod';
import { isSafeUrl, richTextDocSchema } from '../rich-text';
import type { Field, Fields, RelationField } from './types';
import { UUID_PATTERN } from '../uuid';

/**
 * The three ways Genga reads field values:
 * - `draft`: types are checked, `required` is not. Autosave uses it.
 * - `publish`: types and `required` are checked.
 * - `read`: never fails. A bad value takes the default value. Unknown keys are dropped.
 */
export type SchemaMode = 'draft' | 'publish' | 'read';

export type BlockSchemas = Record<string, { fields: Fields }>;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function newId(): string {
  return crypto.randomUUID();
}

export function defaultValue(field: Field): unknown {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return field.defaultValue ?? '';
    case 'slug':
    case 'date':
    case 'url':
      return '';
    case 'number':
      return field.defaultValue ?? null;
    case 'boolean':
      return field.defaultValue ?? false;
    case 'select':
      return field.defaultValue ?? field.options[0]?.value ?? '';
    case 'media':
    case 'richText':
      return null;
    case 'relation':
      return field.multiple ? [] : null;
    case 'tags':
    case 'array':
    case 'blocks':
      return [];
    case 'group':
      return defaultValues(field.fields);
  }
}

export function defaultValues(fields: Fields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, defaultValue(field)]));
}

function requiredString(schema: z.ZodString, field: Field, mode: SchemaMode) {
  return mode === 'publish' && field.required ? schema.min(1, 'Ce champ est requis.') : schema;
}

function itemId() {
  return z
    .string()
    .min(1)
    .catch(() => newId());
}

function baseSchema(field: Field, mode: SchemaMode, blocks: BlockSchemas): z.ZodType {
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const base = field.maxLength ? z.string().max(field.maxLength) : z.string();
      return requiredString(base, field, mode);
    }
    case 'slug':
      return mode === 'read'
        ? z.string()
        : requiredString(z.string(), field, mode).refine(
            (value) => value === '' || SLUG_PATTERN.test(value),
            'Utilisez des minuscules, des chiffres et des tirets.',
          );
    case 'date':
      return requiredString(z.string(), field, mode).refine(
        (value) => value === '' || DATE_PATTERN.test(value),
        'Date au format AAAA-MM-JJ.',
      );
    case 'url':
      return requiredString(z.string().trim(), field, mode).refine(
        (value) => value === '' || isSafeUrl(value),
        'Adresse refusée : http, https, mailto, tel ou chemin relatif.',
      );
    case 'number': {
      let schema = z.number();
      if (field.integer) schema = schema.int();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return mode === 'publish' && field.required ? schema : schema.nullable();
    }
    case 'boolean':
      return z.boolean();
    case 'select': {
      const values = field.options.map((option) => option.value);
      return z
        .string()
        .refine((value) => values.includes(value) || (!field.required && value === ''), 'Option inconnue.');
    }
    case 'media': {
      const id = z.string().regex(UUID_PATTERN);
      return mode === 'publish' && field.required ? id : id.nullable();
    }
    case 'relation': {
      const id = z.string().regex(UUID_PATTERN);
      if (mode === 'read') return relationReadSchema(field);
      if (!field.multiple) return mode === 'publish' && field.required ? id : id.nullable();
      let list = z.array(id).max(field.maxItems ?? 100);
      if (mode === 'publish' && field.required) list = list.min(1, 'Choisissez au moins un document.');
      return list.refine((ids) => new Set(ids).size === ids.length, 'Un document est choisi deux fois.');
    }
    case 'richText':
      return mode === 'publish' && field.required ? richTextDocSchema : richTextDocSchema.nullable();
    case 'tags': {
      const list = z.array(z.string().trim().min(1).max(60)).max(field.maxItems ?? 30);
      return mode === 'publish' && field.required ? list.min(1, 'Ajoutez au moins une étiquette.') : list;
    }
    case 'array': {
      const item = shapeObject(field.fields, mode, blocks).extend({ _id: itemId() });
      let list = z.array(item);
      if (mode === 'publish' && field.minItems !== undefined) list = list.min(field.minItems);
      if (field.maxItems !== undefined) list = list.max(field.maxItems);
      return list;
    }
    case 'blocks':
      return blocksSchema(field.allowed, mode, blocks);
    case 'group':
      return objectSchema(field.fields, mode, blocks);
  }
}

/**
 * Reads a stored relation after a change of the config: a single id becomes a list and back, a list
 * longer than `maxItems` is cut, and bad or repeated ids go out. The other links stay.
 */
function relationReadSchema(field: RelationField): z.ZodType {
  return z.unknown().transform((value) => {
    const values = Array.isArray(value) ? value : [value];
    const ids = [...new Set(values.filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)))];
    return field.multiple ? ids.slice(0, field.maxItems ?? 100) : (ids[0] ?? null);
  });
}

function blocksSchema(allowed: string[] | undefined, mode: SchemaMode, blocks: BlockSchemas): z.ZodType {
  const isAllowed = (type: string) => type in blocks && (!allowed || allowed.includes(type));
  return z.array(z.unknown()).transform((items, context) => {
    const result: Record<string, unknown>[] = [];
    items.forEach((raw, index) => {
      const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const type = typeof item._type === 'string' ? item._type : '';
      const id = typeof item._id === 'string' && item._id ? item._id : newId();
      if (!isAllowed(type)) {
        if (mode === 'read') {
          // The site skips unknown types, but the data stays, so a later config can render it again.
          if (type) result.push({ ...item, _id: id, _type: type });
          return;
        }
        context.addIssue({ code: 'custom', message: `Bloc inconnu : ${type || '(vide)'}`, path: [index, '_type'] });
        return;
      }
      const parsed = shapeObject(blocks[type].fields, mode, blocks).safeParse(item);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: 'custom', message: issue.message, path: [index, ...issue.path] });
        }
        return;
      }
      result.push({ _id: id, _type: type, ...parsed.data });
    });
    return result;
  });
}

export function fieldSchema(field: Field, mode: SchemaMode, blocks: BlockSchemas): z.ZodType {
  const schema = baseSchema(field, mode, blocks);
  if (mode !== 'read') return schema.optional().transform((value) => value ?? defaultValue(field));
  return schema.catch(() => defaultValue(field));
}

function shapeObject(fields: Fields, mode: SchemaMode, blocks: BlockSchemas) {
  return z.object(
    Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldSchema(field, mode, blocks)])),
  );
}

export function objectSchema(fields: Fields, mode: SchemaMode, blocks: BlockSchemas): z.ZodType {
  const object = shapeObject(fields, mode, blocks);
  return mode === 'read' ? object.catch(() => defaultValues(fields)) : object;
}

/** Reads stored data with the current config. It never throws. */
export function tolerantRead(fields: Fields, raw: unknown, blocks: BlockSchemas): Record<string, unknown> {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return objectSchema(fields, 'read', blocks).parse(input) as Record<string, unknown>;
}

export type ValidationIssue = { path: (string | number)[]; message: string };

export function validate(
  fields: Fields,
  raw: unknown,
  mode: Exclude<SchemaMode, 'read'>,
  blocks: BlockSchemas,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: ValidationIssue[] } {
  const parsed = objectSchema(fields, mode, blocks).safeParse(raw ?? {});
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.filter((part): part is string | number => typeof part !== 'symbol'),
      message: issue.message,
    })),
  };
}
