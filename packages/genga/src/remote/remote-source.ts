import type { GengaConfig } from '../config';
import { tagsFor } from '../events';
import {
  GengaSourceError,
  previewHeaders,
  previewInputOf,
  publishedHeaders,
  type DocumentPage,
  type GengaRouteResult,
  type GengaSource,
  type ListQuery,
  type PreviewInput,
  type PublicDocument,
  type SitemapEntry,
} from '../source';

/** What a read is for. An adapter uses it to add framework cache hints, for example Next `next.tags`. */
export type RemoteFetchHints = { tags: string[]; preview: boolean };

export type RemoteFetch = (url: string, init: RequestInit, hints: RemoteFetchHints) => Promise<Response>;

export type RemoteSourceOptions = {
  /** The origin of the Genga server, for example `https://cms.example.com`. */
  url: string;
  /** The config of the site. It gives the paths of renamed slugs when an older server does not send them. */
  schema?: Pick<GengaConfig, 'collections'>;
  /** Default: the global `fetch`. */
  fetch?: RemoteFetch;
};

const API = '/api/v1';

type ErrorBody = { error?: string; message?: string };
type MovedBody = { slug: string; path?: string };

/**
 * The content source of remote mode. It reads the public API of a Genga server with `fetch`
 * only, so it runs on Node and on edge runtimes. It never holds the preview secret: the
 * server checks each preview token.
 */
export function createRemoteSource(options: RemoteSourceOptions): GengaSource {
  let base: string;
  try {
    base = new URL(options.url).origin;
  } catch {
    throw new Error('Genga: the url of createRemoteSource must be an origin like https://cms.example.com.');
  }
  const send: RemoteFetch = options.fetch ?? ((url, init) => fetch(url, init));

  function path(...segments: string[]) {
    return `${base}${API}/${segments.map(encodeURIComponent).join('/')}`;
  }

  async function request(url: string, hints: RemoteFetchHints): Promise<Response> {
    return send(url, { headers: { Accept: 'application/json' }, redirect: 'manual' }, hints);
  }

  async function fail(response: Response): Promise<never> {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new GengaSourceError(
      response.status,
      body.error ?? 'http_error',
      body.message ?? `The Genga server answered ${response.status}.`,
    );
  }

  async function bySlug<T>(
    collection: string,
    slug: string,
  ): Promise<{ document: PublicDocument<T> } | { moved: { slug: string; path: string } } | null> {
    const response = await request(path('collections', collection, 'documents', slug), {
      tags: tagsFor(collection, slug),
      preview: false,
    });
    if (response.status === 200)
      return { document: ((await response.json()) as { document: PublicDocument<T> }).document };
    if (response.status === 301) {
      const moved = (await response.json()) as MovedBody;
      const pathOf = options.schema?.collections[collection]?.path;
      const location = moved.path ?? pathOf?.(moved.slug);
      if (!location) throw new GengaSourceError(502, 'bad_response', 'The Genga server gave no path for the new slug.');
      return { moved: { slug: moved.slug, path: location } };
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return fail(response);
  }

  async function draft<T>(documentId: string, token: string): Promise<PublicDocument<T> | null> {
    const url = `${path('preview', documentId)}?token=${encodeURIComponent(token)}`;
    const response = await request(url, { tags: [], preview: true });
    if (response.status === 200) return ((await response.json()) as { document: PublicDocument<T> }).document;
    if (response.status === 401 || response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return fail(response);
  }

  return {
    mode: 'remote',

    async getDocument<T>(collection: string, slug: string) {
      const found = await bySlug<T>(collection, slug);
      return found && 'document' in found ? found.document : null;
    },

    async listDocuments<T>(collection: string, query: ListQuery = {}): Promise<DocumentPage<T>> {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.tag !== undefined && query.tag !== null) params.set('tag', query.tag);
      if (query.sort) params.set('sort', query.sort);
      const search = params.toString() ? `?${params}` : '';
      const response = await request(`${path('collections', collection, 'documents')}${search}`, {
        tags: tagsFor(collection),
        preview: false,
      });
      if (response.status !== 200) return fail(response);
      return (await response.json()) as DocumentPage<T>;
    },

    async resolveRoute<T>(
      input: Request | PreviewInput,
      collection: string,
      slug: string,
    ): Promise<GengaRouteResult<T>> {
      const preview = previewInputOf(input);
      if (preview) {
        const doc = preview.token ? await draft<T>(preview.documentId, preview.token) : null;
        if (!doc || doc.collection !== collection || doc.slug !== slug) {
          return { kind: 'not-found', cache: 'no-store', headers: previewHeaders() };
        }
        return { kind: 'document', doc, preview: true, cache: 'no-store', headers: previewHeaders() };
      }
      const tags = tagsFor(collection, slug);
      const found = await bySlug<T>(collection, slug);
      if (found && 'document' in found) {
        const etag = found.document.versionId ? `"${found.document.versionId}"` : undefined;
        return {
          kind: 'document',
          doc: found.document,
          preview: false,
          cache: { tags, etag },
          headers: publishedHeaders(etag),
        };
      }
      if (found) {
        return {
          kind: 'redirect',
          location: found.moved.path,
          status: 301,
          cache: { tags: [...tagsFor(collection, found.moved.slug), `genga:d:${collection}:${slug}`] },
          headers: publishedHeaders(),
        };
      }
      return { kind: 'not-found', cache: { tags }, headers: publishedHeaders() };
    },

    getDraft: draft,

    async sitemap(): Promise<SitemapEntry[]> {
      const response = await request(path('sitemap'), { tags: ['genga'], preview: false });
      if (response.status !== 200) return fail(response);
      return ((await response.json()) as { entries: SitemapEntry[] }).entries;
    },

    tagsFor,
  };
}
