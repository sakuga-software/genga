import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as genga from 'genga';
import { defineConfig, ROLES, type CollectionConfig, type Field, type GengaConfig, type PreviewUrlInput } from 'genga';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(file: string, problems: string[]) {
    super(`The Genga config ${file} is not valid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const base = {
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
};
const positive = z.number().int().positive().optional();

const fieldSchema: z.ZodType<Field> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      ...base,
      type: z.literal('text'),
      defaultValue: z.string().optional(),
      maxLength: positive,
      placeholder: z.string().optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal('textarea'),
      defaultValue: z.string().optional(),
      maxLength: positive,
      rows: positive,
    }),
    z.strictObject({ ...base, type: z.literal('slug'), from: z.string().optional() }),
    z.strictObject({
      ...base,
      type: z.literal('number'),
      defaultValue: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      integer: z.boolean().optional(),
    }),
    z.strictObject({ ...base, type: z.literal('boolean'), defaultValue: z.boolean().optional() }),
    z.strictObject({
      ...base,
      type: z.literal('select'),
      options: z.array(z.strictObject({ label: z.string(), value: z.string() })).min(1),
      defaultValue: z.string().optional(),
    }),
    z.strictObject({ ...base, type: z.literal('date') }),
    z.strictObject({ ...base, type: z.literal('url'), placeholder: z.string().optional() }),
    z.strictObject({ ...base, type: z.literal('media'), accept: z.enum(['image', 'any']).optional() }),
    z.strictObject({ ...base, type: z.literal('richText') }),
    z.strictObject({
      ...base,
      type: z.literal('relation'),
      to: z.string().min(1),
      multiple: z.boolean().optional(),
      maxItems: positive,
    }),
    z.strictObject({ ...base, type: z.literal('tags'), maxItems: positive }),
    z.strictObject({
      ...base,
      type: z.literal('array'),
      fields: z.record(z.string(), fieldSchema),
      itemLabel: z.string().optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: positive,
    }),
    z.strictObject({ ...base, type: z.literal('blocks'), allowed: z.array(z.string()).optional() }),
    z.strictObject({ ...base, type: z.literal('group'), fields: z.record(z.string(), fieldSchema) }),
  ]),
);

const fieldName = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'A field name starts with a letter and has letters, digits or _.');
const fieldsSchema = z.record(fieldName, fieldSchema);
const roles = z.array(z.enum(ROLES));
const accessSchema = z
  .strictObject({
    read: roles.optional(),
    create: roles.optional(),
    update: roles.optional(),
    publish: roles.optional(),
    delete: roles.optional(),
    ownOnly: roles.optional(),
  })
  .optional();

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';
const PATH_KEYS = new Set(['slug']);
const PREVIEW_KEYS = new Set(['slug', 'id', 'collection', 'path']);

function template(keys: Set<string>) {
  return z.string().superRefine((value, context) => {
    for (const [, key] of value.matchAll(/\{([^}]*)\}/g)) {
      if (!keys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown placeholder {${key}}. Use ${[...keys].map((k) => `{${k}}`).join(', ')}.`,
        });
      }
    }
  });
}

const collectionSchema = z.strictObject({
  label: z.string().min(1),
  labelSingular: z.string().min(1).optional(),
  titleField: z.string().default('title'),
  path: z.union([
    template(PATH_KEYS).refine(
      (value) => value.startsWith('/') && value.includes('{slug}'),
      'The path starts with / and has {slug}, for example "/blog/{slug}".',
    ),
    z.custom<CollectionConfig['path']>(isFunction),
  ]),
  previewUrl: z
    .union([
      template(PREVIEW_KEYS).refine(
        (value) => /^https?:\/\//.test(value),
        'The preview URL is absolute, for example "https://www.example.com/blog/{slug}".',
      ),
      z.literal(false),
      z.custom<(doc: PreviewUrlInput) => string>(isFunction),
    ])
    .optional(),
  sortField: z.string().optional(),
  access: accessSchema,
  fields: fieldsSchema,
});

const configSchema = z.strictObject({
  $schema: z.string().optional(),
  collections: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]*$/, 'A collection name has lowercase letters, digits or -.'),
      collectionSchema,
    )
    .refine((value) => Object.keys(value).length > 0, 'Define at least one collection.'),
  blocks: z
    .array(
      z.object({
        type: z.string().regex(/^[a-z][a-z0-9-]*$/, 'A block type has lowercase letters, digits or -.'),
        label: z.string().min(1),
        description: z.string().optional(),
        fields: fieldsSchema,
        component: z.unknown().optional(),
      }),
    )
    .default([]),
  access: accessSchema,
  media: z.strictObject({ maxUploadBytes: z.number().int().positive().optional() }).optional(),
});

function fill(value: string, values: Record<string, string>): string {
  return value.replace(/\{([a-z]+)\}/g, (_match, key: string) => values[key] ?? '');
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Checks a raw config (from JSON or a module) and turns it into a Genga config.
 * Template strings become functions. A headless config has no block components.
 */
export function parseConfig(raw: unknown, file = 'genga.config'): GengaConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(file, formatIssues(parsed.error));
  const { collections, blocks, access, media } = parsed.data;
  try {
    return defineConfig({
      collections: Object.fromEntries(
        Object.entries(collections).map(([name, collection]) => {
          const { path, previewUrl } = collection;
          const config: CollectionConfig = {
            label: collection.label,
            labelSingular: collection.labelSingular ?? collection.label,
            titleField: collection.titleField,
            sortField: collection.sortField,
            access: collection.access ?? access,
            fields: collection.fields,
            path: typeof path === 'string' ? (slug) => fill(path, { slug }) : path,
            previewUrl:
              typeof previewUrl === 'string'
                ? (doc) => fill(previewUrl, { slug: doc.slug, id: doc.id, collection: doc.collection, path: doc.path })
                : (previewUrl ?? false),
          };
          return [name, config];
        }),
      ),
      blocks: blocks.map(({ type, label, description, fields }) => ({ type, label, description, fields })),
      media,
    });
  } catch (error) {
    throw new ConfigError(file, [(error as Error).message.replace(/^Genga: /, '')]);
  }
}

/**
 * Loads `genga.config.json` or `genga.config.mjs`. A module exports the config, or a
 * function that gets the `genga` helpers (`text`, `slug`, `defineBlock`…) and returns it,
 * because a mounted file cannot import `genga`.
 */
export async function loadConfigFile(file: string): Promise<GengaConfig> {
  if (file.endsWith('.json')) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new ConfigError(file, [`The file is not valid JSON: ${(error as Error).message}`]);
    }
    return parseConfig(raw, file);
  }
  const module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default?: unknown };
  const exported = typeof module.default === 'function' ? await module.default(genga) : module.default;
  if (!exported) throw new ConfigError(file, ['The module has no default export.']);
  return parseConfig(exported, file);
}
