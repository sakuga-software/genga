import { useId, useState } from 'react';
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  Tag,
  TagGroup,
  TextArea,
  TextField,
} from '@heroui/react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { defaultValues, newId } from '../../fields/schema';
import type { ArrayField, Field, Fields, GroupField, TagsField } from '../../fields/types';
import type { RichTextDoc } from '../../rich-text';
import { isSafeUrl } from '../../rich-text';
import { BlocksInput } from './blocks-input';
import { pathKey, useEditor } from './editor-context';
import { MediaInput } from './media-input';
import { RichTextInput } from './rich-text-input';

export type FieldInputProps = {
  name: string;
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  path: (string | number)[];
};

function labelOf(name: string, field: Field) {
  return field.label ?? name;
}

function useFieldError(path: (string | number)[]) {
  const { errors } = useEditor();
  return errors[pathKey(path)];
}

const INPUT_TYPES: Partial<Record<Field['type'], string>> = { url: 'url', date: 'date' };

function TextInput({ name, field, value, onChange, path }: FieldInputProps) {
  const error = useFieldError(path);
  const { readOnly } = useEditor();
  const text = typeof value === 'string' ? value : '';
  const isUrl = field.type === 'url';
  const urlInvalid = isUrl && text !== '' && !isSafeUrl(text);
  const message = urlInvalid ? 'Adresse refusée : http, https, mailto, tel ou chemin relatif.' : error;
  const maxLength = field.type === 'text' || field.type === 'textarea' ? field.maxLength : undefined;
  const placeholder = field.type === 'text' || field.type === 'url' ? field.placeholder : undefined;
  return (
    <TextField
      name={pathKey(path)}
      value={text}
      onChange={onChange}
      isRequired={field.required}
      isInvalid={Boolean(message)}
      isReadOnly={readOnly}
      maxLength={maxLength}
      type={INPUT_TYPES[field.type] ?? 'text'}
      fullWidth
    >
      <Label>{labelOf(name, field)}</Label>
      {field.type === 'textarea' ? (
        <TextArea rows={field.rows ?? 3} placeholder={placeholder} />
      ) : (
        <Input placeholder={placeholder} />
      )}
      {field.description && <Description>{field.description}</Description>}
      {maxLength && <Description>{`${text.length} / ${maxLength}`}</Description>}
      <FieldError>{message}</FieldError>
    </TextField>
  );
}

function NumberInput({ name, field, value, onChange, path }: FieldInputProps) {
  const error = useFieldError(path);
  const { readOnly } = useEditor();
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
  return (
    <TextField
      name={pathKey(path)}
      type="number"
      value={text}
      inputMode="numeric"
      onChange={(next) => {
        setText(next);
        const parsed = next.trim() === '' ? null : Number(next);
        onChange(parsed === null || Number.isFinite(parsed) ? parsed : value);
      }}
      isRequired={field.required}
      isInvalid={Boolean(error)}
      isReadOnly={readOnly}
      fullWidth
    >
      <Label>{labelOf(name, field)}</Label>
      <Input />
      {field.description && <Description>{field.description}</Description>}
      <FieldError>{error}</FieldError>
    </TextField>
  );
}

function BooleanInput({ name, field, value, onChange }: FieldInputProps) {
  const { readOnly } = useEditor();
  return (
    <Switch isSelected={value === true} onChange={onChange} isReadOnly={readOnly}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        {labelOf(name, field)}
      </Switch.Content>
    </Switch>
  );
}

function SelectInput({ name, field, value, onChange, path }: FieldInputProps) {
  const error = useFieldError(path);
  const { readOnly } = useEditor();
  if (field.type !== 'select') return null;
  return (
    <Select
      value={typeof value === 'string' && value ? value : null}
      onChange={(key) => onChange(key === null ? '' : String(key))}
      isRequired={field.required}
      isInvalid={Boolean(error)}
      isDisabled={readOnly}
      fullWidth
      placeholder="Choisir…"
    >
      <Label>{labelOf(name, field)}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {field.options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      {field.description && <Description>{field.description}</Description>}
      <FieldError>{error}</FieldError>
    </Select>
  );
}

function TagsInput({ name, field, value, onChange, path }: FieldInputProps & { field: TagsField }) {
  const error = useFieldError(path);
  const { readOnly } = useEditor();
  const [draft, setDraft] = useState('');
  const tags = Array.isArray(value) ? (value as string[]) : [];
  const labelId = useId();
  const add = () => {
    const next = draft.trim();
    if (next && !tags.includes(next)) onChange([...tags, next]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2">
      <TextField
        value={draft}
        onChange={setDraft}
        isReadOnly={readOnly}
        isInvalid={Boolean(error)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add();
          }
        }}
        fullWidth
      >
        <Label id={labelId}>{labelOf(name, field)}</Label>
        <Input placeholder="Saisir puis Entrée" />
        <Description>{field.description ?? 'Entrée ou virgule pour ajouter une étiquette.'}</Description>
        <FieldError>{error}</FieldError>
      </TextField>
      {tags.length > 0 && (
        <TagGroup aria-labelledby={labelId} onRemove={(keys) => onChange(tags.filter((tag) => !keys.has(tag)))}>
          <TagGroup.List>
            {tags.map((tag) => (
              <Tag key={tag} id={tag} textValue={tag}>
                {tag}
                {!readOnly && <Tag.RemoveButton aria-label={`Retirer ${tag}`} />}
              </Tag>
            ))}
          </TagGroup.List>
        </TagGroup>
      )}
    </div>
  );
}

export function FieldsInput({
  fields,
  value,
  onChange,
  path,
}: {
  fields: Fields;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  path: (string | number)[];
}) {
  return (
    <div className="flex flex-col gap-5">
      {Object.entries(fields).map(([name, field]) => (
        <FieldInput
          key={name}
          name={name}
          field={field}
          value={value[name]}
          path={[...path, name]}
          onChange={(next) => onChange({ ...value, [name]: next })}
        />
      ))}
    </div>
  );
}

function GroupInput({ name, field, value, onChange, path }: FieldInputProps & { field: GroupField }) {
  const object = value && typeof value === 'object' ? (value as Record<string, unknown>) : defaultValues(field.fields);
  return (
    <fieldset className="rounded-xl border border-[var(--border)] p-4">
      <legend className="px-1 text-sm font-medium">{labelOf(name, field)}</legend>
      <FieldsInput fields={field.fields} value={object} onChange={onChange} path={path} />
    </fieldset>
  );
}

function ArrayInput({ name, field, value, onChange, path }: FieldInputProps & { field: ArrayField }) {
  const { readOnly } = useEditor();
  const error = useFieldError(path);
  const items = Array.isArray(value) ? (value as ({ _id: string } & Record<string, unknown>)[]) : [];
  const itemLabel = field.itemLabel ?? 'Élément';
  const move = (from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  return (
    <fieldset className="rounded-xl border border-[var(--border)] p-4">
      <legend className="px-1 text-sm font-medium">{labelOf(name, field)}</legend>
      {error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}
      <ol className="flex flex-col gap-4">
        {items.map((item, index) => (
          <li key={item._id} className="rounded-lg bg-[var(--surface-secondary)] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="genga-mono text-xs text-[var(--muted)]">
                {itemLabel} {index + 1}
              </span>
              {!readOnly && (
                <div className="flex gap-1">
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Monter ${itemLabel.toLowerCase()} ${index + 1}`}
                    isDisabled={index === 0}
                    onPress={() => move(index, index - 1)}
                  >
                    <ArrowUp aria-hidden className="size-4" />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Descendre ${itemLabel.toLowerCase()} ${index + 1}`}
                    isDisabled={index === items.length - 1}
                    onPress={() => move(index, index + 1)}
                  >
                    <ArrowDown aria-hidden className="size-4" />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Supprimer ${itemLabel.toLowerCase()} ${index + 1}`}
                    onPress={() => onChange(items.filter((_, position) => position !== index))}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </div>
              )}
            </div>
            <FieldsInput
              fields={field.fields}
              value={item}
              path={[...path, index]}
              onChange={(next) =>
                onChange(items.map((current, position) => (position === index ? { ...next, _id: item._id } : current)))
              }
            />
          </li>
        ))}
      </ol>
      {!readOnly && (field.maxItems === undefined || items.length < field.maxItems) && (
        <Button
          className="mt-4"
          size="sm"
          variant="secondary"
          onPress={() => onChange([...items, { _id: newId(), ...defaultValues(field.fields) }])}
        >
          <Plus aria-hidden className="size-4" /> Ajouter : {itemLabel.toLowerCase()}
        </Button>
      )}
    </fieldset>
  );
}

export function FieldInput(props: FieldInputProps) {
  const { field } = props;
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'url':
    case 'date':
      return <TextInput {...props} />;
    case 'slug':
      return null;
    case 'number':
      return <NumberInput {...props} />;
    case 'boolean':
      return <BooleanInput {...props} />;
    case 'select':
      return <SelectInput {...props} />;
    case 'tags':
      return <TagsInput {...props} field={field} />;
    case 'media':
      return (
        <MediaInput
          label={labelOf(props.name, field)}
          required={field.required}
          value={typeof props.value === 'string' ? props.value : null}
          onChange={props.onChange as (value: string | null) => void}
          path={props.path}
          description={field.description}
        />
      );
    case 'richText':
      return (
        <RichTextInput
          label={labelOf(props.name, field)}
          value={(props.value as RichTextDoc | null) ?? null}
          onChange={props.onChange}
          path={props.path}
          required={field.required}
        />
      );
    case 'array':
      return <ArrayInput {...props} field={field} />;
    case 'group':
      return <GroupInput {...props} field={field} />;
    case 'blocks':
      return <BlocksInput {...props} field={field} />;
  }
}
