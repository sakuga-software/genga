import { connectBridge, normalizeOrigin, PREVIEW_PARAM, PREVIEW_TOKEN_PARAM } from './bridge';

export type PreviewParams = { documentId: string; token: string | null };

/** Preview tokens by document id. They live in memory only, never in the address bar. */
const tokens = new Map<string, string>();

/** The preview token of a document in this page, after `connectPreview` took it from the URL. */
export function previewToken(documentId: string): string | null {
  return tokens.get(documentId) ?? null;
}

/**
 * Reads `genga-preview` and `genga-token` from a URL. Returns null outside a preview. When the
 * URL has no token, it gives the token that this page keeps in memory for the document.
 */
export function readPreviewParams(url: string | URL = window.location.href): PreviewParams | null {
  const params = new URL(url).searchParams;
  const documentId = params.get(PREVIEW_PARAM);
  return documentId ? { documentId, token: params.get(PREVIEW_TOKEN_PARAM) ?? previewToken(documentId) } : null;
}

/**
 * Moves the preview token from the address bar to memory, so that it does not stay in the
 * history, in a bookmark or in a shared link.
 */
function takeTokenFromAddressBar(documentId: string, token: string | null) {
  if (!token) return;
  tokens.set(documentId, token);
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PREVIEW_TOKEN_PARAM)) return;
  url.searchParams.delete(PREVIEW_TOKEN_PARAM);
  window.history.replaceState(window.history.state, '', url.href);
}

/** A document of the public API: `data` has absolute media URLs and rich text with `html`. */
export type PreviewDocument = {
  id: string;
  collection: string;
  slug: string;
  data: Record<string, unknown>;
};

export type ConnectPreviewOptions = {
  /** The origin of the Genga admin, for example `https://cms.example.com`. */
  adminOrigin: string;
  /** Called with the draft: first from the API, then at each change in the editor. */
  onDraft: (data: Record<string, unknown>, documentId: string) => void;
  /** Base URL of the public API. Default: `<adminOrigin>/api/v1`. */
  apiUrl?: string;
  /** Called when the first draft cannot load, for example after the token expired. */
  onError?: (error: Error) => void;
  /**
   * Called after each autosave of the editor. Pages whose blocks render only on the server
   * refresh here, with the token of `connection.token()`.
   */
  onSaved?: (draftRev: number, documentId: string) => void;
  /** Called when the editor sends a fresh preview token. */
  onToken?: (token: string, documentId: string) => void;
};

export type PreviewConnection = {
  /** The id of the document in preview, or null when the page is not a preview. */
  documentId: string | null;
  /** The current preview token: the one of the URL, then each fresh one from the editor. */
  token: () => string | null;
  disconnect: () => void;
};

/**
 * Connects any page to the Genga editor, in any framework or none. In a preview frame,
 * it loads the draft with the preview token, then calls `onDraft` at each change.
 * It removes the token from the address bar and keeps it in memory; the editor renews it
 * before it expires. Messages from another origin than `adminOrigin` are ignored.
 */
export function connectPreview(options: ConnectPreviewOptions): PreviewConnection {
  const params = typeof window === 'undefined' ? null : readPreviewParams();
  if (!params) return { documentId: null, token: () => null, disconnect: () => {} };
  const { documentId, token } = params;
  takeTokenFromAddressBar(documentId, token);
  const adminOrigin = normalizeOrigin(options.adminOrigin);
  let live = false;
  let closed = false;

  const disconnectBridge = connectBridge({
    documentId,
    adminOrigin,
    onDraft: (data) => {
      live = true;
      if (!closed) options.onDraft(data, documentId);
    },
    onSaved: (draftRev) => {
      if (!closed) options.onSaved?.(draftRev, documentId);
    },
    onToken: (fresh) => {
      tokens.set(documentId, fresh);
      if (!closed) options.onToken?.(fresh, documentId);
    },
  });

  if (token) {
    const apiUrl = (options.apiUrl ?? `${adminOrigin}/api/v1`).replace(/\/+$/, '');
    const url = `${apiUrl}/preview/${encodeURIComponent(documentId)}?token=${encodeURIComponent(token)}`;
    fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Genga: the preview answered ${response.status}.`);
        const body = (await response.json()) as { document: PreviewDocument };
        if (!live && !closed) options.onDraft(body.document.data, documentId);
      })
      .catch((error: unknown) => {
        if (!closed) options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  return {
    documentId,
    token: () => previewToken(documentId),
    disconnect: () => {
      closed = true;
      disconnectBridge();
    },
  };
}
