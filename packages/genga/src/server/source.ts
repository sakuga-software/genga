import { can } from '../access';
import { tagsFor } from '../events';
import {
  previewHeaders,
  previewInputOf,
  publishedHeaders,
  type GengaRouteResult,
  type GengaSource,
  type PreviewInput,
  type PublicDocument,
  documentEtag,
} from '../source';
import { isUuid } from '../uuid';
import type { GengaAuth } from './auth';
import type { GengaContext } from './context';
import { verifyPreviewToken } from './preview';
import type { GengaPublicReads } from './public-api';
import type { GengaPublished } from './published';

type Services = { ctx: GengaContext; auth: GengaAuth; published: GengaPublished; reads: GengaPublicReads };

/**
 * The content source of embedded mode: reads in process, in the public shape. A preview
 * needs the admin session of the request (same origin), as `published.loadForRoute` does.
 */
export function createEmbeddedSource({ ctx, auth, published, reads }: Services): GengaSource {
  function hasCollection(name: string) {
    return Object.hasOwn(ctx.config.collections, name);
  }

  async function previewDraft<T>(input: PreviewInput, collection: string, slug: string) {
    if (!input.cookie || !isUuid(input.documentId)) return null;
    const user = await auth.getUser(new Request(ctx.siteUrl, { headers: { cookie: input.cookie } }));
    if (!user) return null;
    const [row] = await ctx.sql<{ collection: string; slug: string; created_by: string | null }[]>`
      SELECT collection, slug, created_by FROM genga_documents WHERE id = ${input.documentId} AND deleted_at IS NULL
    `;
    if (!row || row.collection !== collection || row.slug !== slug) return null;
    if (!can(user, 'read', ctx.config.collections[collection].access, { createdBy: row.created_by })) return null;
    const doc = await published.draft(input.documentId);
    return doc ? reads.toPublicDocument<T>(doc) : null;
  }

  return {
    mode: 'embedded',

    async getDocument<T>(collection: string, slug: string): Promise<PublicDocument<T> | null> {
      if (!hasCollection(collection)) return null;
      const found = await reads.bySlug<T>(collection, slug);
      return found && 'document' in found ? found.document : null;
    },

    listDocuments: (collection, query) => reads.list(collection, query),

    async resolveRoute<T>(
      request: Request | PreviewInput,
      collection: string,
      slug: string,
    ): Promise<GengaRouteResult<T>> {
      const preview = previewInputOf(request);
      if (preview) {
        const doc = hasCollection(collection) ? await previewDraft<T>(preview, collection, slug) : null;
        if (!doc) return { kind: 'not-found', cache: 'no-store', headers: previewHeaders() };
        return { kind: 'document', doc, preview: true, cache: 'no-store', headers: previewHeaders() };
      }
      const tags = tagsFor(collection, slug);
      if (!hasCollection(collection)) return { kind: 'not-found', cache: { tags }, headers: publishedHeaders() };
      const found = await reads.bySlug<T>(collection, slug);
      if (found && 'document' in found) {
        const etag = documentEtag(found.document);
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

    async getDraft<T>(documentId: string, token: string): Promise<PublicDocument<T> | null> {
      if (!ctx.previewSecret || !verifyPreviewToken(ctx.previewSecret, token, documentId)) return null;
      const doc = await published.draft(documentId);
      return doc ? reads.toPublicDocument<T>(doc) : null;
    },

    sitemap: () => published.sitemap(),

    tagsFor,
  };
}
