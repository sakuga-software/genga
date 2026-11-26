import { useSyncExternalStore } from 'react';

type Block = { _id: string; _type: string } & Record<string, unknown>;
type Draft = { documentId: string; data: Record<string, unknown> };

let current: Draft | null = null;
const listeners = new Set<() => void>();
const blockIndexes = new WeakMap<Record<string, unknown>, Map<string, Block>>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setDraft(documentId: string, data: Record<string, unknown>) {
  current = { documentId, data };
  for (const listener of listeners) listener();
}

function isBlock(value: unknown): value is Block {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Block)._id === 'string' &&
    typeof (value as Block)._type === 'string'
  );
}

/** The blocks of a draft by id, in every field and at every depth. */
export function blocksOf(data: Record<string, unknown>): Map<string, Block> {
  const cached = blockIndexes.get(data);
  if (cached) return cached;
  const index = new Map<string, Block>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) {
      if (isBlock(value)) index.set(value._id, value);
      Object.values(value).forEach(visit);
    }
  };
  visit(data);
  blockIndexes.set(data, index);
  return index;
}

/** The draft that the editor sent last, or null before the first one. */
export function useDraft(): Draft | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** The block of the last draft with this id, or null. */
export function useDraftBlock(blockId: string): Block | null {
  const draft = useDraft();
  return draft ? (blocksOf(draft.data).get(blockId) ?? null) : null;
}
