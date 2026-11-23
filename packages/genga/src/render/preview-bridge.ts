import { useEffect, useSyncExternalStore } from 'react';
import type { PreviewMessage, PublishedDocument } from '../types';

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

const STYLE_ID = 'genga-preview-style';
const PREVIEW_CSS = `
[data-genga-block] { position: relative; cursor: pointer; transition: outline-color 120ms; outline: 2px dashed transparent; outline-offset: 6px; }
[data-genga-block]:hover { outline-color: rgba(23, 120, 255, 0.6); }
[data-genga-block][data-genga-focused] { outline: 2px solid #1778ff; }
`;

function isMessage(value: unknown): value is PreviewMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Connects the preview frame to the editor. Messages from another origin or from
 * another window than the parent are ignored.
 */
function connect(documentId: string): () => void {
  if (window.parent === window) return () => {};
  const origin = window.location.origin;
  const post = (message: PreviewMessage) => window.parent.postMessage(message, origin);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = PREVIEW_CSS;
    document.head.append(style);
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== origin || event.source !== window.parent || !isMessage(event.data)) return;
    const message = event.data;
    if (message.documentId !== documentId) return;
    if (message.type === 'genga:hello') post({ type: 'genga:ready', documentId });
    if (message.type === 'genga:draft') setDraft(documentId, message.data);
    if (message.type === 'genga:focus') {
      for (const element of document.querySelectorAll('[data-genga-focused]'))
        element.removeAttribute('data-genga-focused');
      if (!message.blockId) return;
      const target = document.querySelector(`[data-genga-block-id="${CSS.escape(message.blockId)}"]`);
      target?.setAttribute('data-genga-focused', '');
      target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest('[data-genga-block-id]') : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    post({
      type: 'genga:select',
      documentId,
      blockId: target.getAttribute('data-genga-block-id') ?? '',
      index: Number(target.getAttribute('data-genga-block')),
    });
  };

  window.addEventListener('message', onMessage);
  document.addEventListener('click', onClick, true);
  post({ type: 'genga:ready', documentId });
  return () => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('click', onClick, true);
  };
}

/**
 * Returns the document to render. In preview mode, it returns the draft that the
 * editor sends at each change, and React renders again without a reload.
 */
export function usePreviewData<T>(doc: PublishedDocument<T>, preview: boolean): PublishedDocument<T> {
  useEffect(() => (preview ? connect(doc.id) : undefined), [preview, doc.id]);
  const live = useSyncExternalStore(
    subscribe,
    () => drafts.get(doc.id) ?? null,
    () => null,
  );
  return preview && live ? { ...doc, data: live as T } : doc;
}
