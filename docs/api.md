# Public API (v1)

The [headless server](./headless-server.md) serves a read-only JSON API under `/api/v1`. A
site in any stack reads the published content with it. Any app that mounts
[`genga.handle`](./configuration.md#one-handler-gengahandle) can serve the same API with the
`publicApi` option. It is off by default there. The machine-readable description is
[`openapi.yaml`](./openapi.yaml) (OpenAPI 3.1).

- Only published content. A draft leaves the server only through the
  [preview endpoint](#get-apiv1previewid), with a preview token.
- JSON in UTF-8. The version is in the path: a breaking change gets `/api/v2`.
- `GET`, `HEAD` and `OPTIONS` only. Other methods answer `405`.
- No authentication. Everything that the API gives is public.

## Conventions

### Cache

Content responses send `Cache-Control: public, max-age=0, must-revalidate` and an `ETag`. The
ETag comes from the response body, so it changes when a version is published, and also when a
media item of the document changes. Send it back in `If-None-Match` to get a `304` without a
body:

```sh
curl -i https://cms.example.com/api/v1/collections/posts/documents/hello \
  -H 'If-None-Match: "eVlHfcjs9FeP929SReIdo_kwVgkeM4jt"'
# HTTP/1.1 304 Not Modified
```

The server keeps the published documents in an in-process cache. A publish clears it.

### CORS

A browser on another origin can read the API only if its origin is in `GENGA_CORS_ORIGINS`.
The server then sends `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`.
`GENGA_CORS_ORIGINS=*` allows every origin. Server-side requests (SSR, static builds) need
no CORS. The preview endpoint uses `GENGA_PREVIEW_ORIGINS` instead.

### Rate limit

Each client address has a token bucket of `GENGA_RATE_LIMIT` requests (default 300) that
refills in one minute. Over the limit, the API answers `429` with `Retry-After` in seconds.
The client address comes from `X-Forwarded-For` and `GENGA_TRUSTED_PROXIES`: see
[headless server](./headless-server.md#behind-a-reverse-proxy). A site that builds many pages
at once from one address can need a higher limit.

### Errors

Errors have one shape:

```json
{ "error": "not_found", "message": "No published document has this slug." }
```

| Status | `error`              | When                                                 |
| ------ | -------------------- | ---------------------------------------------------- |
| 400    | `bad_request`        | A query parameter is not valid.                      |
| 401    | `invalid_token`      | The preview token is missing, wrong or expired.      |
| 404    | `not_found`          | No collection, no published document, no media.      |
| 405    | `method_not_allowed` | A method other than `GET`, `HEAD` and `OPTIONS`.     |
| 429    | `rate_limited`       | Too many requests. Wait `Retry-After` seconds.       |
| 500    | `internal`           | An error on the server. The server logs the details. |

## The document shape

```json
{
  "id": "3caa7401-1331-4b9b-9af7-876bcd84e4cb",
  "collection": "posts",
  "slug": "hello",
  "path": "/blog/hello",
  "versionId": "a3c5e0e2-8d6f-4f9b-9b8e-2f0c8c1d7e55",
  "publishedAt": "2026-11-23T16:12:03.512Z",
  "data": {
    "title": "Hello",
    "slug": "hello",
    "excerpt": "A first post.",
    "cover": {
      "id": "0f6b7a8e-1d2c-4b3a-9e8f-7a6b5c4d3e2f",
      "url": "https://cms.example.com/media/4f1c…e9.png",
      "filename": "cover.png",
      "mime": "image/png",
      "alt": "A red square",
      "width": 3090,
      "height": 1758,
      "sizes": [
        { "width": 480, "url": "https://cms.example.com/media/4f1c…e9-w480.webp" },
        { "width": 960, "url": "https://cms.example.com/media/4f1c…e9-w960.webp" },
        { "width": 1600, "url": "https://cms.example.com/media/4f1c…e9-w1600.webp" }
      ]
    },
    "publishedDate": "2026-11-23",
    "tags": ["news"],
    "body": [
      {
        "_id": "8d2f…",
        "_type": "rich-text",
        "content": {
          "type": "doc",
          "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Hi." }] }],
          "html": "<p>Hi.</p>"
        }
      },
      { "_id": "1b7c…", "_type": "image", "image": { "id": "0f6b…", "url": "…" }, "caption": "A caption" }
    ]
  }
}
```

- `path` is the URL of the document on your site, from the `path` of the collection.
- `versionId` is the published version. It is `null` in a preview.
- `data` has every field of the collection. A missing value takes its default (`""`, `null`,
  `[]`, `false`).
- A `media` field is a media object or `null`. Its `url` and `sizes[].url` are absolute, from
  `GENGA_PUBLIC_URL`. `sizes` holds WebP copies 480, 960 and 1600 pixels wide, when the
  original is wider.
- A `richText` field is the TipTap JSON plus `html`: the same markup as `<RichText>` of
  `genga/client`, rendered on the server from an allowlist. The HTML is safe to insert with
  `innerHTML`. Links to other sites get `target="_blank" rel="noopener noreferrer"`.
- A `blocks` field is a list of `{ _id, _type, ...fields }`. The block fields follow the same
  rules.

## Endpoints

### `GET /api/v1/collections`

The collections and the blocks, with their field schemas.

```sh
curl https://cms.example.com/api/v1/collections
```

```json
{
  "collections": [
    {
      "name": "posts",
      "label": "Articles",
      "labelSingular": "Article",
      "titleField": "title",
      "path": "/blog/{slug}",
      "fields": { "title": { "type": "text", "label": "Titre", "required": true }, "…": {} }
    }
  ],
  "blocks": [{ "type": "quote", "label": "Citation", "fields": { "…": {} } }]
}
```

### `GET /api/v1/collections/{collection}`

One collection: `{ "collection": { … } }`, with the same shape as above.

### `GET /api/v1/collections/{collection}/documents`

The published documents of a collection, newest first (by the `sortField` of the collection,
else by the publication date).

| Parameter | Default | Meaning                                                                                               |
| --------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `limit`   | 20      | Documents per page, 1 to 100.                                                                         |
| `cursor`  |         | The `nextCursor` of the previous page.                                                                |
| `tag`     |         | Only the documents that have this tag in a `tags` field.                                              |
| `sort`    |         | `publishedAt` or a field of type text, textarea, slug, date, number, select or boolean. `-` reverses. |

```sh
curl 'https://cms.example.com/api/v1/collections/posts/documents?limit=2&tag=news&sort=-publishedDate'
```

```json
{
  "documents": [{ "id": "…", "slug": "hello", "data": { "…": "…" } }],
  "total": 7,
  "nextCursor": "eyJvIjoyfQ"
}
```

`nextCursor` is `null` on the last page. Treat the cursor as opaque.

### `GET /api/v1/collections/{collection}/documents/{slug}`

One published document by slug: `{ "document": { … } }`.

If the slug changed after a publish, the old slug answers `301` with `Location` set to the
new API URL, and the body `{ "error": "moved", "slug": "<new slug>", "path": "<site path>" }`.
`path` is the path of the new slug on the site, for example `/blog/new-slug`. `fetch` follows the
redirect: check `response.redirected` to send a `301` from your own page too.

```js
const response = await fetch(`${CMS}/api/v1/collections/posts/documents/${slug}`);
if (response.redirected) return redirectTo(`/blog/${(await response.json()).document.slug}`);
```

### `GET /api/v1/documents/{id}`

One published document by id: `{ "document": { … } }`.

### `GET /api/v1/media/{id}`

The metadata of a media item: the media object plus `size` (bytes) and `createdAt`.

```json
{
  "media": {
    "id": "…",
    "url": "https://cms.example.com/media/…",
    "alt": "…",
    "width": 1200,
    "height": 600,
    "sizes": [],
    "size": 48213,
    "createdAt": "…"
  }
}
```

The files themselves are under `/media/<key>`, with `Cache-Control: immutable`. Each file is
public to whoever knows its URL, also when only a draft uses it.

### `GET /api/v1/preview/{id}`

The current draft of a document, for the live preview. See
[preview bridge](./preview-bridge.md#a-site-on-another-origin).

| Parameter | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `token`   | The preview token from the `genga-token` parameter of the preview URL. Valid 10 minutes. |

```sh
curl "https://cms.example.com/api/v1/preview/3caa7401-…?token=mi3k2x9.Xq…"
```

- The answer is `{ "document": { … } }` with `versionId: null`, `Cache-Control: no-store` and
  no `ETag`.
- CORS allows only `GENGA_PREVIEW_ORIGINS`. The request needs no cookie.
- A token gives access to one document only. A wrong, changed or expired token gives `401`.
  The editor puts a new token in the preview URL at each load, and the reload button gets a
  new one.
- Without `GENGA_SECRET`, this endpoint answers `404`.

## Health

These endpoints are outside `/api/v1` and have no rate limit.

| Endpoint       | `200` when                                         | Else  |
| -------------- | -------------------------------------------------- | ----- |
| `GET /healthz` | The process answers and the database answers.      | `503` |
| `GET /readyz`  | Also: the migrations ran and the config is loaded. | `503` |

## Examples

### A static site (Astro, Eleventy, a build script)

```js
const CMS = 'https://cms.example.com/api/v1';

export async function allPosts() {
  const posts = [];
  let cursor = null;
  do {
    const url = new URL(`${CMS}/collections/posts/documents`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await (await fetch(url)).json();
    posts.push(...page.documents);
    cursor = page.nextCursor;
  } while (cursor);
  return posts;
}
```

### Next.js (App Router)

```tsx
import { notFound } from 'next/navigation';

export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const response = await fetch(`${process.env.CMS_URL}/api/v1/collections/posts/documents/${slug}`, {
    next: { revalidate: 60 },
  });
  if (response.status === 404) notFound();
  const { document } = await response.json();
  return (
    <article>
      <h1>{document.data.title}</h1>
      {document.data.body.map((block) =>
        block._type === 'rich-text' ? (
          <div key={block._id} dangerouslySetInnerHTML={{ __html: block.content.html }} />
        ) : null,
      )}
    </article>
  );
}
```
