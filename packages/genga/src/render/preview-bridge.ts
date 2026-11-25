import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connectBridge } from '../preview/bridge';
import type { PublishedDocument } from '../types';

const drafts = new Map<string, Record<string, unknown>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setDraft(documentId: string, data: Record<string, unknown>) {
  drafts.set(documentId, data);
  for (const listener of listeners) listener();
}

export type PreviewDataOptions = {
  /** The origin of the Genga admin. Default: the origin of the page. */
  adminOrigin?: string;
  /** Called after each autosave of the editor, for data that renders on the server only. */
  onSaved?: (draftRev: number) => void;
};

/**
 * Returns the document to render. In preview mode, it returns the draft that the
 * editor sends at each change, and React renders again without a reload.
 */
export function usePreviewData<T>(
  doc: PublishedDocument<T>,
  preview: boolean,
  options: PreviewDataOptions = {},
): PublishedDocument<T> {
  const { adminOrigin } = options;
  const onSaved = useRef(options.onSaved);
  useEffect(() => {
    onSaved.current = options.onSaved;
  });
  useEffect(
    () =>
      preview
        ? connectBridge({
            documentId: doc.id,
            adminOrigin: adminOrigin ?? window.location.origin,
            onDraft: (data) => setDraft(doc.id, data),
            onSaved: (draftRev) => onSaved.current?.(draftRev),
          })
        : undefined,
    [preview, doc.id, adminOrigin],
  );
  const live = useSyncExternalStore(
    subscribe,
    () => drafts.get(doc.id) ?? null,
    () => null,
  );
  return preview && live ? { ...doc, data: live as T } : doc;
}
