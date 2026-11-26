import type { RichTextDoc } from '../rich-text';

type BaseField = {
  label?: string;
  description?: string;
  required?: boolean;
};

export type TextField = BaseField & { type: 'text'; defaultValue?: string; maxLength?: number; placeholder?: string };
export type TextareaField = BaseField & { type: 'textarea'; defaultValue?: string; maxLength?: number; rows?: number };
export type SlugField = BaseField & { type: 'slug'; from?: string };
export type NumberField = BaseField & {
  type: 'number';
  defaultValue?: number;
  min?: number;
  max?: number;
  integer?: boolean;
};
export type BooleanField = BaseField & { type: 'boolean'; defaultValue?: boolean };
export type SelectOption = { label: string; value: string };
export type SelectField = BaseField & { type: 'select'; options: SelectOption[]; defaultValue?: string };
export type DateField = BaseField & { type: 'date' };
export type UrlField = BaseField & { type: 'url'; placeholder?: string };
export type MediaField = BaseField & { type: 'media'; accept?: 'image' | 'any' };
export type RichTextField = BaseField & { type: 'richText' };
export type TagsField = BaseField & { type: 'tags'; maxItems?: number };
export type ArrayField = BaseField & {
  type: 'array';
  fields: Fields;
  itemLabel?: string;
  minItems?: number;
  maxItems?: number;
};
export type BlocksField = BaseField & { type: 'blocks'; allowed?: string[] };
/**
 * A link to documents of another collection, or of the same one. The draft stores document ids.
 * `populate` gives the published version of each target; a target that is not live is left out.
 */
export type RelationField = BaseField & {
  type: 'relation';
  /** The collection of the target documents. */
  to: string;
  /** A list of documents instead of one. */
  multiple?: boolean;
  /** The maximum number of documents of a `multiple` relation. */
  maxItems?: number;
};
export type GroupField = BaseField & { type: 'group'; fields: Fields };

export type Field =
  | TextField
  | TextareaField
  | SlugField
  | NumberField
  | BooleanField
  | SelectField
  | DateField
  | UrlField
  | MediaField
  | RichTextField
  | TagsField
  | ArrayField
  | BlocksField
  | GroupField
  | RelationField;

export type FieldType = Field['type'];

export type Fields = Record<string, Field>;

/** A media row after `populate`. The site renders it. */
export type MediaObject = {
  id: string;
  url: string;
  filename: string;
  mime: string;
  alt: string;
  width: number | null;
  height: number | null;
  sizes: { width: number; url: string }[];
};

/**
 * A relation target inside the data of another relation target. Genga does not load it: read the
 * document with its collection and id if you need it.
 */
export type RelationRef = { id: string; collection: string };

/**
 * A relation target after `populate`: the published version of the document. `data` holds its
 * fields with media objects; its own relations are `RelationRef` values.
 */
export type RelatedDocument<T = Record<string, unknown>> = {
  id: string;
  collection: string;
  slug: string;
  path: string;
  title: string;
  publishedAt: string | null;
  data: T;
};

/** A block after `populate`: `_id` and `_type` plus the values of the block fields. */
export type BlockData = { _id: string; _type: string; [key: string]: unknown };

export type FieldValue<F extends Field> = F extends { type: 'text' | 'textarea' | 'slug' | 'select' | 'date' | 'url' }
  ? string
  : F extends { type: 'number' }
    ? number | null
    : F extends { type: 'boolean' }
      ? boolean
      : F extends { type: 'media' }
        ? MediaObject | null
        : F extends { type: 'richText' }
          ? RichTextDoc | null
          : F extends { type: 'tags' }
            ? string[]
            : F extends { type: 'array'; fields: infer S extends Fields }
              ? Array<{ _id: string } & FieldValues<S>>
              : F extends { type: 'blocks' }
                ? BlockData[]
                : F extends { type: 'group'; fields: infer S extends Fields }
                  ? FieldValues<S>
                  : F extends { type: 'relation'; multiple: true }
                    ? RelatedDocument[]
                    : F extends { type: 'relation' }
                      ? RelatedDocument | null
                      : unknown;

export type FieldValues<S extends Fields> = { [K in keyof S]: FieldValue<S[K]> };
