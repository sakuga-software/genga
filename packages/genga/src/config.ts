import type { ComponentType } from 'react';
import type { AccessOverrides } from './access';
import type { BlockSchemas } from './fields/schema';
import type { Field, FieldValues, Fields } from './fields/types';

export type BlockDefinition<S extends Fields = Fields> = {
  type: string;
  label: string;
  description?: string;
  fields: S;
  component: ComponentType<FieldValues<S> & { _id: string; _type: string }>;
};

export function defineBlock<const S extends Fields>(block: BlockDefinition<S>): BlockDefinition<S> {
  return block;
}

export type CollectionConfig = {
  label: string;
  labelSingular: string;
  fields: Fields;
  /** The field that names a document in lists. */
  titleField: string;
  /** Public URL of a published document. Genga uses it for previews, redirects and sitemaps. */
  path: (slug: string) => string;
  /** Field used to sort the public lists, newest first. Default: the publication date. */
  sortField?: string;
  access?: AccessOverrides;
};

export type GengaConfig = {
  collections: Record<string, CollectionConfig>;
  // oxlint-disable-next-line typescript/no-explicit-any -- each block has its own props type.
  blocks: BlockDefinition<any>[];
  media?: { maxUploadBytes?: number };
};

export const RESERVED_SLUGS = new Set(['admin', 'media', 'api']);

export function defineConfig(config: GengaConfig): GengaConfig {
  for (const [name, collection] of Object.entries(config.collections)) {
    const slugFields = Object.values(collection.fields).filter((field) => field.type === 'slug');
    if (slugFields.length !== 1 || collection.fields.slug?.type !== 'slug') {
      throw new Error(`Genga: the collection "${name}" needs exactly one slug field, named "slug".`);
    }
    if (!collection.fields[collection.titleField]) {
      throw new Error(`Genga: the collection "${name}" has no field "${collection.titleField}".`);
    }
  }
  const types = new Set<string>();
  for (const block of config.blocks) {
    if (types.has(block.type)) throw new Error(`Genga: the block type "${block.type}" is defined twice.`);
    types.add(block.type);
  }
  return config;
}

export function blockSchemas(config: GengaConfig): BlockSchemas {
  return Object.fromEntries(config.blocks.map((block) => [block.type, { fields: block.fields as Fields }]));
}

/** The config without React components and functions. The admin receives it from a loader. */
export type SerializedSchema = {
  collections: Record<
    string,
    { name: string; label: string; labelSingular: string; titleField: string; fields: Record<string, Field> }
  >;
  blocks: Record<string, { type: string; label: string; description?: string; fields: Record<string, Field> }>;
};

export function serializeSchema(config: GengaConfig): SerializedSchema {
  return {
    collections: Object.fromEntries(
      Object.entries(config.collections).map(([name, collection]) => [
        name,
        {
          name,
          label: collection.label,
          labelSingular: collection.labelSingular,
          titleField: collection.titleField,
          fields: collection.fields,
        },
      ]),
    ),
    blocks: Object.fromEntries(
      config.blocks.map((block) => [
        block.type,
        { type: block.type, label: block.label, description: block.description, fields: block.fields as Fields },
      ]),
    ),
  };
}

export function blockSchemasFromSerialized(schema: SerializedSchema): BlockSchemas {
  return Object.fromEntries(Object.values(schema.blocks).map((block) => [block.type, { fields: block.fields }]));
}
