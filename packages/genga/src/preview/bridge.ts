import type { PreviewMessage } from '../types';

export const PREVIEW_PARAM = 'genga-preview';
export const PREVIEW_TOKEN_PARAM = 'genga-token';

type MessageLike = { origin: string; source: unknown; data: unknown };

function isMessage(value: unknown): value is PreviewMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { documentId?: unknown }).documentId === 'string'
  );
}

/**
 * True when a `message` event comes from the expected window and origin, and is a
 * Genga message for the expected document. Both sides of the bridge use this check.
 */
export function isTrustedMessage(
  event: MessageLike,
  expected: { origin: string; source: unknown; documentId: string },
): event is MessageLike & { data: PreviewMessage } {
  if (!expected.origin || expected.origin === '*' || event.origin !== expected.origin) return false;
  if (!event.source || event.source !== expected.source) return false;
  return isMessage(event.data) && event.data.documentId === expected.documentId;
}

/** Checks an origin like `https://admin.example.com` and removes a trailing slash. */
export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin === 'null' || url.origin !== value.replace(/\/+$/, '')) {
    throw new Error(`Genga: "${value}" is not an origin like https://admin.example.com.`);
  }
  return url.origin;
}

const STYLE_ID = 'genga-preview-style';
const PREVIEW_CSS = `
[data-genga-block] { position: relative; cursor: pointer; transition: outline-color 120ms; outline: 2px dashed transparent; outline-offset: 6px; }
[data-genga-block]:hover { outline-color: rgba(23, 120, 255, 0.6); }
[data-genga-block][data-genga-focused] { outline: 2px solid #1778ff; }
`;

/**
 * The head of a preview page. `meta` keys are `name` values (`description`) or `property`
 * values (`og:title`). A `null` or empty value removes the tag.
 */
export type PreviewHead = {
  title?: string | null;
  meta?: Record<string, string | null | undefined>;
};

function metaTag(key: string): Element | null {
  const value = CSS.escape(key);
  return document.head.querySelector(`meta[name="${value}"], meta[property="${value}"]`);
}

/** Writes the title and the meta tags of a preview page. Keys that `head` does not give stay as they are. */
export function applyHead(head: PreviewHead) {
  if (typeof document === 'undefined') return;
  if (typeof head.title === 'string') document.title = head.title;
  for (const [key, content] of Object.entries(head.meta ?? {})) {
    if (content === undefined) continue;
    let tag = metaTag(key);
    if (content === null || content === '') {
      tag?.remove();
      continue;
    }
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute(key.startsWith('og:') ? 'property' : 'name', key);
      document.head.append(tag);
    }
    tag.setAttribute('content', content);
  }
}

export type BridgeOptions = {
  documentId: string;
  /** The origin of the Genga admin. The bridge sends to it and accepts messages only from it. */
  adminOrigin: string;
  onDraft: (data: Record<string, unknown>) => void;
  /** Called after each autosave of the editor, for pages that render on the server only. */
  onSaved?: (draftRev: number) => void;
  /** Called with a fresh preview token, before the current one expires. */
  onToken?: (token: string) => void;
  /** Gives the title and the meta tags of a draft. The bridge writes them at each draft. */
  head?: (data: Record<string, unknown>) => PreviewHead;
};

/**
 * Connects a page in the preview frame to the editor. It sends `genga:ready`, applies
 * drafts and focus, and sends a click on a block. It does nothing outside a frame.
 * Returns the function that disconnects it.
 */
export function connectBridge({ documentId, adminOrigin, onDraft, onSaved, onToken, head }: BridgeOptions): () => void {
  if (typeof window === 'undefined' || window.parent === window) return () => {};
  const origin = normalizeOrigin(adminOrigin);
  const parent = window.parent;
  const post = (message: PreviewMessage) => parent.postMessage(message, origin);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = PREVIEW_CSS;
    document.head.append(style);
  }

  const onMessage = (event: MessageEvent) => {
    if (!isTrustedMessage(event, { origin, source: parent, documentId })) return;
    const message = event.data;
    if (message.type === 'genga:hello') post({ type: 'genga:ready', documentId });
    if (message.type === 'genga:draft') {
      onDraft(message.data);
      if (head) applyHead(head(message.data));
    }
    if (message.type === 'genga:saved' && Number.isInteger(message.draftRev)) onSaved?.(message.draftRev);
    if (message.type === 'genga:token' && typeof message.token === 'string') onToken?.(message.token);
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
