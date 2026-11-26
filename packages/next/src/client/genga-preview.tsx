import { connectBridge } from 'genga/preview';
import { useRouter } from 'next/navigation';
import { startTransition, useEffect } from 'react';
import { setDraft } from './store';

export type GengaPreviewProps = {
  /** The id of the document in preview: `page.doc.id`. */
  documentId: string;
  /** The origin of the Genga admin: `source.adminOrigin`. */
  adminOrigin: string;
  /** The path of the preview entry route. Default: `/api/genga/preview`. */
  endpoint?: string;
};

/**
 * Connects the page to the Genga editor. Render it only in a preview.
 *
 * - Client blocks and `usePreviewData` get each change of the editor at once.
 * - After each autosave, the page asks the server again (`router.refresh()`), so Server
 *   Component blocks show the saved draft.
 * - The fresh preview tokens of the editor go to the entry route, which renews the cookie.
 */
export function GengaPreview({ documentId, adminOrigin, endpoint = '/api/genga/preview' }: GengaPreviewProps) {
  const router = useRouter();
  useEffect(
    () =>
      connectBridge({
        documentId,
        adminOrigin,
        onDraft: (data) => setDraft(documentId, data),
        onSaved: () => startTransition(() => router.refresh()),
        onToken: (token) => {
          void fetch(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId, token }),
          }).catch((error: unknown) => console.error('[genga] The preview token was not renewed.', error));
        },
      }),
    [documentId, adminOrigin, endpoint, router],
  );
  return null;
}
