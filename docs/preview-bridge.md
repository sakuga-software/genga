# Preview bridge

The editor shows the real site route in an `<iframe>` with `?genga-preview=<documentId>`.
The route renders the draft, and the editor sends each change to the frame without a reload.

There are two setups:

- **Same origin.** The site and the admin share an origin, for example a React Router app
  with Genga inside. The frame reads the draft with the session cookie.
- **Another origin.** The site is somewhere else, for example a Next.js or Astro site that
  reads the [headless server](./headless-server.md). The frame reads the draft with a signed
  preview token.

## Same origin: in a site route

```tsx
import { RenderBlocks, usePreviewData } from 'genga/client';

export async function loader({ request, params }: Route.LoaderArgs) {
  const result = await genga.published.loadForRoute<PageData>(request, 'pages', params.slug);
  // result.kind: 'document' | 'redirect' | 'not-found'. Always forward result.headers.
}

export default function Page({ loaderData }: Route.ComponentProps) {
  const { data } = usePreviewData(loaderData.doc, loaderData.preview);
  return <RenderBlocks blocks={data.body} registry={gengaConfig.blocks} preview={loaderData.preview} />;
}
```

`loadForRoute` reads the published version. With `?genga-preview=<id>`, it reads the draft
only if:

- the request has a session,
- the user can read the collection,
- the id belongs to the collection and to the slug of the route.

In preview mode, and also on failure, the headers are `Cache-Control: private, no-store` and
`Vary: Cookie`. Forward them with a `headers` export. Turn analytics off when the URL has
`genga-preview`.

## A site on another origin

### 1. Configure the server

Give the collection a `previewUrl` on the site, and allow the site origin:

```json
"posts": {
  "path": "/blog/{slug}",
  "previewUrl": "https://www.example.com/blog/{slug}",
  "…": "…"
}
```

```sh
GENGA_PREVIEW_ORIGINS=https://www.example.com
GENGA_SECRET="$(openssl rand -base64 48)"
```

With the library, the same options are `previewUrl` on the collection, and `previewOrigins`
and `previewSecret` in `createGenga`. Genga refuses to start if a `previewUrl` has an origin
that is not in the list, or if the secret is missing.

The editor then loads:

```
https://www.example.com/blog/hello?genga-preview=<id>&genga-token=<token>
```

The token is an HMAC of the document id and an expiry, signed with the secret. It is valid
10 minutes and for this document only. The editor puts a new token in the URL at each load,
and the reload button of the preview pane gets a new one.

The secret stays on the Genga server. Never give it to the site: a site that held it could
sign a token for any draft. The site checks a token with `GET /api/v1/preview/:id`, or with
`resolveRoute` of the [remote source](./content-source.md), which calls that endpoint.

**Token hygiene.**

- Preview responses send `Cache-Control: private, no-store`, `Vary: Cookie`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. `resolveRoute` gives these
  headers: forward them. The `Referrer-Policy` keeps the token out of the `Referer` of the
  requests of the page.
- `connectPreview` removes `genga-token` from the address bar with `history.replaceState` and
  keeps it in memory. `connection.token()` and `previewToken(id)` give the current token.
  A full reload of the frame starts from the address bar, which no longer has the token, so
  the server answers not found. Refresh without a full reload (fetch the page with the token
  and swap its content, or a framework refresh that sends the token), or put the token back in
  the URL before you reload.
- The editor sends a fresh token with `genga:token` 2 minutes before the current one expires,
  as long as the frame is open.

### 2. Allow the frame on the site

The admin must be able to frame the preview page. If the site sends
`Content-Security-Policy: frame-ancestors` or `X-Frame-Options`, allow the admin origin on the
preview requests:

```
Content-Security-Policy: frame-ancestors 'self' https://cms.example.com
```

Send `Cache-Control: no-store` on a page with `genga-preview` in the URL, and do not index it.

### 3. Connect the page

`connectPreview` works in any framework and with none. It loads the draft with the token,
then calls `onDraft` at each change in the editor:

```js
import { connectPreview } from 'genga/preview';

const preview = connectPreview({
  adminOrigin: 'https://cms.example.com',
  onDraft: (data) => render(data),
  onError: (error) => console.warn(error),
});

if (!preview.documentId) {
  // Not a preview: render the published document from the API.
}
```

- `genga/preview` has no dependency and weighs about 6 KB minified. `genga/client` exports
  the same functions.
- `data` has the shape of the [public API](./api.md#the-document-shape): absolute media URLs,
  rich text with `html`.
- Outside a frame, `connectPreview` still loads the draft with the token, so the "open in a
  new tab" button of the preview pane works too.
- `options.apiUrl` changes the API base URL. Default: `<adminOrigin>/api/v1`.

For a click on a block to select it in the editor, put these attributes on the block wrapper:

```html
<section data-genga-block="0" data-genga-block-id="8d2f…" data-genga-block-type="text">…</section>
```

`data-genga-block` is the index of the block, `data-genga-block-id` its `_id`.

### React sites (Next.js, Remix, Vite)

`usePreviewData` takes the admin origin as a third argument. Load the first draft with the
token on the server or in the browser, then let the hook apply the changes:

```tsx
'use client';
import { RenderBlocks, usePreviewData } from 'genga/client';

export function PostPreview({ doc }: { doc: PublishedDocument<PostData> }) {
  const { data } = usePreviewData(doc, true, { adminOrigin: 'https://cms.example.com' });
  return <RenderBlocks blocks={data.body} registry={blocks} preview />;
}
```

`RenderBlocks` needs the React components of your blocks: the server config has the
schemas only, and your site has the components.

## Messages

All messages go through `postMessage`. The target is the exact origin of the other side:
the site origin for the editor, `adminOrigin` for the frame. Each side checks `event.origin`
and `event.source`, and ignores messages for another document id. Neither side ever uses
`*`.

| Message        | From   | Purpose                                                     |
| -------------- | ------ | ----------------------------------------------------------- |
| `genga:ready`  | frame  | The bridge is connected. The editor answers with the draft. |
| `genga:hello`  | editor | Asks a connected frame to send `genga:ready` again.         |
| `genga:draft`  | editor | The populated draft, at most once per animation frame.      |
| `genga:focus`  | editor | Highlights and scrolls to the selected block.               |
| `genga:select` | frame  | A click on a block selects it in the form.                  |
| `genga:saved`  | editor | The autosave stored the draft (`draftRev`).                 |
| `genga:token`  | editor | A fresh preview token, before the current one expires.      |

Pages whose blocks render only on the server (React Server Components, `.astro`) use
`genga:saved`: `connectPreview({ onSaved })` or `usePreviewData(doc, preview, { onSaved })`
calls back after each autosave, and the page refreshes with the token in memory.

`usePreviewData` reads the drafts from an external store (`useSyncExternalStore`), so React
renders again with the new data. `meta` and `<title>` do not update live.
