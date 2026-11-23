import { connectBridge, normalizeOrigin, PREVIEW_PARAM, PREVIEW_TOKEN_PARAM } from './bridge';

export type PreviewParams = { documentId: string; token: string | null };

/** Reads `genga-preview` and `genga-token` from a URL. Returns null outside a preview. */
export function readPreviewParams(url: string | URL = window.location.href): PreviewParams | null {
  const params = new URL(url).searchParams;
  const documentId = params.get(PREVIEW_PARAM);
  return documentId ? { documentId, token: params.get(PREVIEW_TOKEN_PARAM) } : null;
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
};

export type PreviewConnection = {
  /** The id of the document in preview, or null when the page is not a preview. */
  documentId: string | null;
  disconnect: () => void;
};

/**
 * Connects any page to the Genga editor, in any framework or none. In a preview frame,
 * it loads the draft with the preview token, then calls `onDraft` at each change.
 * Messages from another origin than `adminOrigin` are ignored.
 */
export function connectPreview(options: ConnectPreviewOptions): PreviewConnection {
  const params = typeof window === 'undefined' ? null : readPreviewParams();
  if (!params) return { documentId: null, disconnect: () => {} };
  const { documentId, token } = params;
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
  });

  if (token) {
    const apiUrl = (options.apiUrl ?? `${adminOrigin}/api/v1`).replace(/\/+$/, '');
    const url = `${apiUrl}/preview/${encodeURIComponent(documentId)}?token=${encodeURIComponent(token)}`;
    fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } })
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
    disconnect: () => {
      closed = true;
      disconnectBridge();
    },
  };
}
