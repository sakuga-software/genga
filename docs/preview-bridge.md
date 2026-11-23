# Preview bridge

The editor shows the real site route in an `<iframe>` with `?genga-preview=<documentId>`.
The route renders the draft, and the editor sends each change to the frame without a reload.

## In a site route

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

## Messages

All messages go through `postMessage` with the site origin as target. Each side checks
`event.origin` and `event.source`, and ignores messages for another document id.

| Message        | From   | Purpose                                                     |
| -------------- | ------ | ----------------------------------------------------------- |
| `genga:ready`  | frame  | The bridge is connected. The editor answers with the draft. |
| `genga:hello`  | editor | Asks a connected frame to send `genga:ready` again.         |
| `genga:draft`  | editor | The populated draft, at most once per animation frame.      |
| `genga:focus`  | editor | Highlights and scrolls to the selected block.               |
| `genga:select` | frame  | A click on a block selects it in the form.                  |

`usePreviewData` reads the drafts from an external store (`useSyncExternalStore`), so React
renders again with the new data. `meta` and `<title>` do not update live.

## With another React framework

`genga/client` has no dependency on React Router. A site in another framework can call
`usePreviewData` and `RenderBlocks` the same way. It needs the draft data from the Genga API
for the first render (see [headless server](./headless-server.md)).
