import {
  GengaSourceError,
  type GengaRouteResult,
  type GengaSource,
  type PreviewInput,
  type PublicDocument,
} from 'genga/remote';
import { vi } from 'vitest';

export const DOC_ID = '0b9f4b8e-1c1a-4c8e-9d7a-3f1e2a4b5c6d';
export const TOKEN = 'mxyz12.c2lnbmF0dXJl';
/** A token that makes the fake Genga server fail. */
export const FAILING_TOKEN = 'down.c2VydmVy';

export function doc(overrides: Partial<PublicDocument> = {}): PublicDocument {
  return {
    id: DOC_ID,
    collection: 'posts',
    slug: 'hello',
    path: '/blog/hello',
    versionId: 'v1',
    publishedAt: '2026-11-26T10:00:00.000Z',
    data: { title: 'Published' },
    ...overrides,
  };
}

/** A source with one post. The token `TOKEN` opens its draft. */
export function fakeSource() {
  const draft = doc({ versionId: null, data: { title: 'Draft' } });
  const getDraft = vi.fn(async (documentId: string, token: string) => {
    if (token === FAILING_TOKEN) throw new GengaSourceError(503, 'unavailable', 'The server is down.');
    return documentId === DOC_ID && token === TOKEN ? draft : null;
  });
  const resolveRoute = vi.fn(
    async (input: Request | PreviewInput, collection: string, slug: string): Promise<GengaRouteResult> => {
      const preview = 'documentId' in input && input.documentId ? input : null;
      if (preview) {
        const found = preview.token ? await getDraft(preview.documentId, preview.token) : null;
        if (!found || found.collection !== collection || found.slug !== slug) {
          return { kind: 'not-found', cache: 'no-store', headers: new Headers() };
        }
        return { kind: 'document', doc: found, preview: true, cache: 'no-store', headers: new Headers() };
      }
      if (collection === 'posts' && slug === 'hello') {
        return { kind: 'document', doc: doc(), preview: false, cache: { tags: [] }, headers: new Headers() };
      }
      return { kind: 'not-found', cache: { tags: [] }, headers: new Headers() };
    },
  );
  const source = {
    mode: 'remote',
    getDocument: vi.fn(),
    listDocuments: vi.fn(),
    resolveRoute,
    getDraft,
    sitemap: vi.fn(),
    tagsFor: vi.fn(() => []),
  } as unknown as GengaSource;
  return { source, getDraft, resolveRoute };
}
