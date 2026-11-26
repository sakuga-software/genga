import { useEffect, useId, useRef, useState } from 'react';
import { Button, ComboBox, Description, Input, Label, ListBox } from '@heroui/react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { apiRequest } from '../../client/api';
import type { RelationField } from '../../fields/types';
import type { DocumentStatus, RelationOption } from '../../types';
import { StatusChip } from '../components/status-chip';
import { pathKey, useEditor } from './editor-context';

const SEARCH_DELAY_MS = 200;

type RelationInputProps = {
  label: string;
  field: RelationField;
  value: unknown;
  onChange: (value: string | string[] | null) => void;
  path: (string | number)[];
};

type TargetLabel = { title: string; status: DocumentStatus } | null;

function idsOf(field: RelationField, value: unknown): string[] {
  if (!field.multiple) return typeof value === 'string' && value !== '' ? [value] : [];
  const values = Array.isArray(value) ? value : [];
  return values.filter((id): id is string => typeof id === 'string' && id !== '');
}

function query(collection: string, params: Record<string, string>) {
  return `relations?${new URLSearchParams({ collection, ...params })}`;
}

/**
 * A relation field: the chosen documents, then a combobox that searches the target collection.
 * The preview shows the published version of each target; a draft target shows nothing on the site.
 */
export function RelationInput({ label, field, value, onChange, path }: RelationInputProps) {
  const { errors, readOnly, rememberRelated, schema } = useEditor();
  const ids = idsOf(field, value);
  const [labels, setLabels] = useState<Map<string, TargetLabel>>(new Map());
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const labelId = useId();
  const errorId = useId();
  const error = errors[pathKey(path)];
  const target = schema.collections[field.to];
  const full = field.multiple ? ids.length >= (field.maxItems ?? 100) : false;
  const missingKey = ids.filter((id) => !labels.has(id)).join(',');
  const searchRun = useRef(0);

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    void apiRequest<{ options: RelationOption[] }>(query(field.to, { ids: missingKey })).then(
      (result) => {
        if (cancelled) return;
        for (const option of result.options) if (option.related) rememberRelated(option.related);
        setLabels((current) => {
          const next = new Map(current);
          for (const id of missingKey.split(',')) next.set(id, null);
          for (const option of result.options) next.set(option.id, { title: option.title, status: option.status });
          return next;
        });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [field.to, missingKey, rememberRelated]);

  useEffect(() => {
    const run = (searchRun.current += 1);
    setLoading(true);
    const timer = setTimeout(() => {
      void apiRequest<{ options: RelationOption[] }>(query(field.to, { q: search })).then(
        (result) => {
          if (run !== searchRun.current) return;
          setOptions(result.options);
          setLoading(false);
        },
        () => {
          if (run === searchRun.current) setLoading(false);
        },
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [field.to, search]);

  function titleOf(id: string) {
    return labels.get(id)?.title ?? (labels.has(id) ? 'Document indisponible' : 'Chargement…');
  }

  function commit(next: string[]) {
    onChange(field.multiple ? next : (next[0] ?? null));
  }

  function choose(id: string) {
    const option = options.find((item) => item.id === id);
    if (option) setLabels((current) => new Map(current).set(id, { title: option.title, status: option.status }));
    commit(field.multiple ? [...ids.filter((item) => item !== id), id] : [id]);
    void apiRequest<{ options: RelationOption[] }>(query(field.to, { ids: id })).then(
      (result) => result.options[0]?.related && rememberRelated(result.options[0].related),
      () => {},
    );
    setSearch('');
    setAnnouncement(`${option?.title ?? 'Document'} ajouté.`);
  }

  function remove(id: string) {
    commit(ids.filter((item) => item !== id));
    setAnnouncement(`${titleOf(id)} retiré.`);
  }

  function move(index: number, offset: number) {
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(index + offset, 0, item);
    commit(next);
    setAnnouncement(`${titleOf(item)} déplacé en position ${index + offset + 1} sur ${next.length}.`);
  }

  const available = options.filter((option) => !ids.includes(option.id));

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium">
        {label}
        {field.required && (
          <span aria-hidden className="text-[var(--danger)]">
            {' '}
            *
          </span>
        )}
      </span>
      {field.description && <p className="text-xs text-[var(--muted)]">{field.description}</p>}

      {ids.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={`${label} : documents choisis`}>
          {ids.map((id, index) => {
            const current = labels.get(id);
            return (
              <li
                key={id}
                className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{titleOf(id)}</span>
                {current && <StatusChip status={current.status} />}
                {!readOnly && field.multiple && ids.length > 1 && (
                  <>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={`Monter ${titleOf(id)}`}
                      isDisabled={index === 0}
                      onPress={() => move(index, -1)}
                    >
                      <ArrowUp aria-hidden className="size-4" />
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={`Descendre ${titleOf(id)}`}
                      isDisabled={index === ids.length - 1}
                      onPress={() => move(index, 1)}
                    >
                      <ArrowDown aria-hidden className="size-4" />
                    </Button>
                  </>
                )}
                {!readOnly && (
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Retirer ${titleOf(id)}`}
                    onPress={() => remove(id)}
                  >
                    <X aria-hidden className="size-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && !full && (
        <ComboBox
          aria-labelledby={labelId}
          aria-describedby={error ? errorId : undefined}
          items={available}
          inputValue={search}
          onInputChange={setSearch}
          selectedKey={null}
          onSelectionChange={(key) => key !== null && choose(String(key))}
          allowsEmptyCollection
          menuTrigger="focus"
          fullWidth
        >
          <Label className="sr-only">
            {field.multiple || ids.length === 0 ? 'Ajouter' : 'Remplacer'} : {target?.labelSingular ?? field.to}
          </Label>
          <ComboBox.InputGroup>
            <Input
              placeholder={`Rechercher ${target ? `dans ${target.label.toLowerCase()}` : 'un document'}…`}
              aria-invalid={Boolean(error) || undefined}
            />
            <ComboBox.Trigger />
          </ComboBox.InputGroup>
          <ComboBox.Popover>
            <ListBox
              renderEmptyState={() => (
                <p className="px-3 py-2 text-sm text-[var(--muted)]">
                  {loading ? 'Recherche…' : 'Aucun document ne correspond.'}
                </p>
              )}
            >
              {(option: RelationOption) => (
                <ListBox.Item id={option.id} textValue={option.title}>
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="truncate">{option.title}</span>
                    <StatusChip status={option.status} />
                  </span>
                </ListBox.Item>
              )}
            </ListBox>
          </ComboBox.Popover>
        </ComboBox>
      )}
      <Description className="text-xs">Le site montre seulement les documents publiés.</Description>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
