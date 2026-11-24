# Content source

A site reads Genga content through one interface, `GengaSource`, in both modes:

- **Embedded.** The instance of `createGenga()` is the source. It reads in process, from the
  published cache and Postgres.
- **Remote.** `createRemoteSource()` from `genga/remote` reads the
  [public API](./api.md) of a Genga server with `fetch`. It has no Node built-in, no `pg` and
  no `sharp` in its import graph, so it runs on edge runtimes too.

Both return the public shape of the [public API](./api.md#the-document-shape): absolute media
URLs and rich text with `html`. A block component works in both modes without a change.

```ts
import { createRemoteSource } from 'genga/remote';

export const source = process.env.GENGA_URL
  ? createRemoteSource({ url: process.env.GENGA_URL, schema: gengaConfig })
  : genga; // createGenga(gengaConfig, { … })
```

## The interface

```ts
interface GengaSource {
  readonly mode: 'embedded' | 'remote';
  getDocument<T>(collection: string, slug: string): Promise<PublicDocument<T> | null>;
  listDocuments<T>(collection: string, query?: ListQuery): Promise<DocumentPage<T>>;
  resolveRoute<T>(request: Request | PreviewInput, collection: string, slug: string): Promise<GengaRouteResult<T>>;
  getDraft<T>(documentId: string, token: string): Promise<PublicDocument<T> | null>;
  sitemap(): Promise<{ path: string; lastModified: string | null }[]>;
  tagsFor(collection: string, slug?: string): string[];
}
```

- `getDocument` gives the published document of a slug, or `null`. A renamed slug gives
  `null`: use `resolveRoute` to get its redirect.
- `listDocuments` takes the query of the public API: `limit` (1 to 100), `cursor`, `tag` and
  `sort`. A bad query or an unknown collection throws a `GengaSourceError` with `status` and
  `code`, the same in both modes.
- `tagsFor` gives the cache tags of a read. The [publish events](./events.md) carry the same
  tags.

## `resolveRoute`

It answers a page route: the published document, a `301` to the new slug, not found, or the
draft for a valid preview.

```ts
const result = await source.resolveRoute(request, 'posts', params.slug);
if (result.kind === 'redirect') return redirect(result.location, 301);
if (result.kind === 'not-found') return notFound();
// result.doc, result.preview, result.cache: { tags, etag } or 'no-store'
```

Forward `result.headers` with the page. A published answer has
`Cache-Control: public, max-age=0, must-revalidate` and an `ETag` from the version. A preview
answer, also on failure, has `Cache-Control: private, no-store`, `Vary: Cookie`,
`Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.

A preview needs the URL parameter `genga-preview=<id>`, and the draft must belong to the
collection and the slug of the route. Then:

| Mode     | Credential                                                                     |
| -------- | ------------------------------------------------------------------------------ |
| Embedded | The admin session in the `Cookie` header. The user must be able to read it.    |
| Remote   | `genga-token` in the URL. The source checks it with `GET /api/v1/preview/:id`. |

Frameworks that give no `Request` to a page pass a `PreviewInput` instead:
`{ documentId, token }` in remote mode, or `{ documentId, cookie }` in embedded mode.

**The preview secret stays on the Genga server.** A remote site never holds `GENGA_SECRET`: a
site that held it could sign a token for any draft. The remote source has no way to make a
token; it asks the server to check each one.

## Remote options

| Option   | Purpose                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `url`    | The origin of the Genga server, for example `https://cms.example.com`.                                        |
| `schema` | Your config. It gives the path of a renamed slug when the server does not send it (Genga 0.2).                |
| `fetch`  | `(url, init, { tags, preview }) => Promise<Response>`. Add framework cache hints here, for example Next tags. |

```ts
createRemoteSource({
  url: process.env.GENGA_URL!,
  fetch: (url, init, { tags, preview }) =>
    fetch(url, preview ? { ...init, cache: 'no-store' } : { ...init, next: { tags } }),
});
```
