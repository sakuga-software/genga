export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/** Browsers refuse a `keepalive` request with a body over 64 KiB. */
export const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Sends the draft without a wait for the answer. `keepalive` lets the request
 * finish after the page closes. Returns false when the request fails.
 */
export async function flushDraft(
  documentId: string,
  data: Record<string, unknown>,
  draftRev: number,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const body = JSON.stringify({ data, draftRev });
  try {
    const response = await fetcher(`/admin/api/documents/${documentId}/draft`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BYTES,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** What to do when the user leaves the editor with changes that are not saved. */
export function blockedNavigation(state: SaveState): 'save' | 'ask' {
  return state === 'error' || state === 'conflict' ? 'ask' : 'save';
}
