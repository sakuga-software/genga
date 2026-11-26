import { GengaPreview } from './client';
import { readPreviewCookie } from './preview-cookie';
import type { GengaNextSource } from './source';

export type GengaPreviewBridgeProps = {
  source: Pick<GengaNextSource, 'adminOrigin'>;
  /** The path of the preview entry route. Default: `/api/genga/preview`. */
  endpoint?: string;
};

/**
 * Connects the pages of a preview to the Genga editor. Put it in the root layout. It renders
 * nothing outside Draft Mode, and keeps public pages static. It stays connected after a token
 * expires, so the next fresh token of the editor gives the draft again.
 */
export async function GengaPreviewBridge({ source, endpoint }: GengaPreviewBridgeProps) {
  const preview = await readPreviewCookie();
  if (!preview) return null;
  return <GengaPreview documentId={preview.documentId} adminOrigin={source.adminOrigin} endpoint={endpoint} />;
}
