import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown, Label } from '@heroui/react';
import { ArrowDown, ArrowUp, ChevronDown, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { I18nProvider, mergeProps, useButton, useDrag, useDrop } from 'react-aria';
import { LiveRegion } from '../components/live-region';
import { moveItem } from './block-order';
import { defaultValues, newId } from '../../fields/schema';
import type { BlocksField } from '../../fields/types';
import { pathKey, useEditor } from './editor-context';
import { FieldsInput, type FieldInputProps } from './field-input';

type Block = { _id: string; _type: string } & Record<string, unknown>;

function cloneWithNewIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneWithNewIds);
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = key === '_id' ? newId() : cloneWithNewIds(item);
    return copy;
  }
  return value;
}

function BlockDragHandle({ dragType, blockId, label }: { dragType: string; blockId: string; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { dragProps, dragButtonProps, isDragging } = useDrag({
    getItems: () => [{ [dragType]: blockId }],
    getAllowedDropOperations: () => ['move'],
    hasDragButton: true,
  });
  const { buttonProps } = useButton(dragButtonProps, ref);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      {...mergeProps(dragProps, buttonProps)}
      className={`grid size-8 shrink-0 cursor-grab place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-secondary)] ${
        isDragging ? 'cursor-grabbing opacity-50' : ''
      }`}
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
}

type BlockDropTargetProps = {
  id: string;
  dragType: string;
  isDisabled: boolean;
  label: string;
  className: string;
  onDropBlock: (blockId: string) => void;
  children: ReactNode;
};

/** A block that takes the place of the block that the user drops on it. */
function BlockDropTarget({ id, dragType, isDisabled, label, className, onDropBlock, children }: BlockDropTargetProps) {
  const ref = useRef<HTMLLIElement>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref,
    isDisabled,
    getDropOperation: (types) => (types.has(dragType) ? 'move' : 'cancel'),
    onDrop: async (event) => {
      for (const item of event.items) {
        if (item.kind === 'text' && item.types.has(dragType)) onDropBlock(await item.getText(dragType));
      }
    },
  });
  return (
    <li
      ref={ref}
      id={id}
      tabIndex={-1}
      aria-label={label}
      {...dropProps}
      className={`${className} ${isDropTarget ? 'outline-2 outline-offset-2 outline-[var(--genga-blue)]' : ''}`}
    >
      {children}
    </li>
  );
}

/** The list of blocks: add, move up and down, drag and drop, duplicate, delete. A click in the preview selects a block here. */
export function BlocksInput({ name, field, value, onChange, path }: FieldInputProps & { field: BlocksField }) {
  const { schema, selectedBlockId, selectBlock, readOnly, errors } = useEditor();
  const blocks = Array.isArray(value) ? (value as Block[]) : [];
  const allowed = Object.values(schema.blocks).filter((block) => !field.allowed || field.allowed.includes(block.type));
  const headerRefs = useRef(new Map<string, HTMLButtonElement>());
  const [announcement, setAnnouncement] = useState('');
  const dragType = `application/x-genga-block-${pathKey(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}`;
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    const id = pendingFocus.current ?? selectedBlockId;
    if (!id) return;
    const header = headerRefs.current.get(id);
    if (!header) return;
    header.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (pendingFocus.current) {
      header.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, [selectedBlockId, blocks.length]);

  function update(next: Block[], focusId?: string) {
    if (focusId) {
      pendingFocus.current = focusId;
      selectBlock(focusId, 'form');
    }
    onChange(next);
  }

  function add(type: string) {
    const definition = schema.blocks[type];
    if (!definition) return;
    const block: Block = { _id: newId(), _type: type, ...defaultValues(definition.fields) };
    update([...blocks, block], block._id);
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...blocks];
    const [block] = next.splice(index, 1);
    next.splice(index + direction, 0, block);
    update(next, block._id);
  }

  function drop(blockId: string, to: number) {
    const from = blocks.findIndex((block) => block._id === blockId);
    if (from < 0 || from === to) return;
    const block = blocks[from];
    update(moveItem(blocks, from, to), block._id);
    const blockLabel = schema.blocks[block._type]?.label ?? block._type;
    setAnnouncement(`Bloc ${blockLabel} déplacé en position ${to + 1} sur ${blocks.length}.`);
  }

  function duplicate(index: number) {
    const copy = cloneWithNewIds(blocks[index]) as Block;
    const next = [...blocks];
    next.splice(index + 1, 0, copy);
    update(next, copy._id);
  }

  function remove(index: number) {
    const neighbour = blocks[index + 1] ?? blocks[index - 1];
    update(
      blocks.filter((_, position) => position !== index),
      neighbour?._id,
    );
  }

  const headingId = `${pathKey(path)}-heading`;

  return (
    <I18nProvider locale="fr-FR">
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id={headingId} className="genga-display text-lg font-semibold">
            {field.label ?? name}
            <span className="ml-2 genga-mono text-xs font-normal text-[var(--muted)]">
              {blocks.length} bloc{blocks.length > 1 ? 's' : ''}
            </span>
          </h2>
        </div>
        {errors[pathKey(path)] && <p className="text-sm text-[var(--danger)]">{errors[pathKey(path)]}</p>}
        <ol className="flex flex-col gap-3">
          {blocks.map((block, index) => {
            const definition = schema.blocks[block._type];
            const isSelected = selectedBlockId === block._id;
            const bodyId = `block-${block._id}-body`;
            const blockLabel = definition?.label ?? block._type;
            const hasError = Object.keys(errors).some((key) => key.startsWith(`${pathKey([...path, index])}.`));
            return (
              <BlockDropTarget
                key={block._id}
                id={`block-${block._id}`}
                dragType={dragType}
                isDisabled={readOnly}
                label={`Bloc ${index + 1}, ${blockLabel}`}
                onDropBlock={(blockId) => drop(blockId, index)}
                className={`rounded-xl border bg-[var(--surface)] transition-colors ${
                  isSelected
                    ? 'border-[var(--genga-blue)] shadow-[0_0_0_1px_var(--genga-blue)]'
                    : 'border-[var(--border)]'
                } ${hasError ? 'border-[var(--danger)]' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-1 p-2">
                  {!readOnly && (
                    <BlockDragHandle
                      dragType={dragType}
                      blockId={block._id}
                      label={`Déplacer le bloc ${index + 1}, ${blockLabel}`}
                    />
                  )}
                  <button
                    type="button"
                    ref={(element) => {
                      if (element) headerRefs.current.set(block._id, element);
                      else headerRefs.current.delete(block._id);
                    }}
                    aria-expanded={isSelected}
                    aria-controls={bodyId}
                    onClick={() => selectBlock(isSelected ? null : block._id, 'form')}
                    className="flex min-w-0 flex-1 basis-24 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-secondary)]"
                  >
                    <span className="genga-mono grid size-6 shrink-0 place-items-center rounded bg-[var(--surface-tertiary)] text-xs text-[var(--muted)]">
                      {index + 1}
                    </span>
                    <span className="truncate font-medium">{blockLabel}</span>
                    {hasError && <span className="text-xs text-[var(--danger)]">À corriger</span>}
                    <ChevronDown
                      aria-hidden
                      className={`ml-auto size-4 shrink-0 transition-transform ${isSelected ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {!readOnly && (
                    <div className="ml-auto flex shrink-0 gap-0.5">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Monter le bloc ${index + 1}, ${blockLabel}`}
                        isDisabled={index === 0}
                        onPress={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Descendre le bloc ${index + 1}, ${blockLabel}`}
                        isDisabled={index === blocks.length - 1}
                        onPress={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden className="size-4" />
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Dupliquer le bloc ${index + 1}, ${blockLabel}`}
                        onPress={() => duplicate(index)}
                      >
                        <Copy aria-hidden className="size-4" />
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Supprimer le bloc ${index + 1}, ${blockLabel}`}
                        onPress={() => remove(index)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>
                <div id={bodyId} hidden={!isSelected} className="border-t border-[var(--border)] p-4">
                  {definition ? (
                    isSelected && (
                      <FieldsInput
                        fields={definition.fields}
                        value={block}
                        path={[...path, index]}
                        onChange={(next) =>
                          onChange(
                            blocks.map((current, position) =>
                              position === index ? { ...next, _id: block._id, _type: block._type } : current,
                            ),
                          )
                        }
                      />
                    )
                  ) : (
                    <p className="text-sm text-[var(--muted)]">
                      Type de bloc inconnu : il reste dans les données mais le site ne l’affiche pas.
                    </p>
                  )}
                </div>
              </BlockDropTarget>
            );
          })}
        </ol>
        <LiveRegion message={announcement} minIntervalMs={0} />
        {blocks.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">
            Aucun bloc. Ajoutez un premier bloc pour composer la page.
          </p>
        )}
        {!readOnly && (
          <Dropdown>
            <Button variant="secondary" className="self-start">
              <Plus aria-hidden className="size-4" /> Ajouter un bloc
            </Button>
            <Dropdown.Popover>
              <Dropdown.Menu aria-label="Types de blocs" onAction={(key) => add(String(key))}>
                {allowed.map((block) => (
                  <Dropdown.Item key={block.type} id={block.type} textValue={block.label}>
                    <div className="flex flex-col">
                      <Label>{block.label}</Label>
                      {block.description && <span className="text-xs text-[var(--muted)]">{block.description}</span>}
                    </div>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
      </section>
    </I18nProvider>
  );
}
