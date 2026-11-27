import type {
  ArrayField,
  BlocksField,
  BooleanField,
  DateField,
  Fields,
  GroupField,
  MediaField,
  NumberField,
  RelationField,
  RichTextField,
  SelectField,
  SlugField,
  TagsField,
  TextareaField,
  TextField,
  UrlField,
} from './types';

type Options<F> = Omit<F, 'type'>;

export const text = (options: Options<TextField> = {}): TextField => ({ type: 'text', ...options });
export const textarea = (options: Options<TextareaField> = {}): TextareaField => ({ type: 'textarea', ...options });
export const slug = (options: Options<SlugField> = {}): SlugField => ({ type: 'slug', ...options });
export const number = (options: Options<NumberField> = {}): NumberField => ({ type: 'number', ...options });
export const boolean = (options: Options<BooleanField> = {}): BooleanField => ({ type: 'boolean', ...options });
export const select = (options: Options<SelectField>): SelectField => ({ type: 'select', ...options });
export const date = (options: Options<DateField> = {}): DateField => ({ type: 'date', ...options });
export const url = (options: Options<UrlField> = {}): UrlField => ({ type: 'url', ...options });
export const media = (options: Options<MediaField> = {}): MediaField => ({ type: 'media', ...options });
export const richText = (options: Options<RichTextField> = {}): RichTextField => ({ type: 'richText', ...options });
export const tags = (options: Options<TagsField> = {}): TagsField => ({ type: 'tags', ...options });
export const blocks = (options: Options<BlocksField> = {}): BlocksField => ({ type: 'blocks', ...options });

export function relation<const O extends Options<RelationField>>(options: O): RelationField & O {
  return { type: 'relation', ...options };
}

export function array<const S extends Fields>(
  options: Options<ArrayField> & { fields: S },
): ArrayField & { fields: S } {
  return { type: 'array', ...options };
}

export function group<const S extends Fields>(
  options: Options<GroupField> & { fields: S },
): GroupField & { fields: S } {
  return { type: 'group', ...options };
}
