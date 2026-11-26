# @genga-cms/next

[Genga](https://github.com/sakuga-software/genga) for the Next.js App Router, in remote mode: the
site reads a Genga server over its public API. Published pages stay static and change at each
publish. Editors see the live preview of the real page in the Genga admin.

| Package           | Next.js      | React   | Node      | Runtime of the routes |
| ----------------- | ------------ | ------- | --------- | --------------------- |
| `@genga-cms/next` | `>=16.4 <17` | `^19.0` | `>=22.12` | Node.js               |

The version of `@genga-cms/next` is the version of `genga`. Embedded mode (Genga inside the Next.js
server) comes in a later release.

## Set up

```tsx
// lib/genga.ts
import 'server-only';
import { createRemoteSource } from '@genga-cms/next';
import config from '@/genga.config.mjs';
export const genga = createRemoteSource({ url: process.env.GENGA_URL!, schema: config });

// app/api/genga/preview/route.ts and app/api/genga/webhook/route.ts
export const { GET, POST, DELETE } = previewRoute(genga);
export const { POST } = webhookRoute(); // reads GENGA_WEBHOOK_SECRET

// app/layout.tsx, in <body>: connects the preview pages to the editor
<GengaPreviewBridge source={genga} />;

// app/blog/[slug]/page.tsx
export const generateStaticParams = async () => [];
export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const page = await loadPage(genga, 'posts', (await params).slug);
  if (page.kind === 'redirect') permanentRedirect(page.location);
  if (page.kind === 'not-found') notFound();
  return <Blocks blocks={page.doc.data.body} registry={blocks} preview={page.preview} />;
}
```

`previewRoute`, `webhookRoute`, `GengaPreviewBridge`, `loadPage` and `Blocks` come from
`@genga-cms/next`; `notFound` and `permanentRedirect` from `next/navigation`. On the Genga
server, set `previewUrl` of each collection to `https://www.example.com/api/genga/preview?path={path}`,
`GENGA_PREVIEW_ORIGINS` to the site origin, and `GENGA_WEBHOOKS` to
`[{"url":"https://www.example.com/api/genga/webhook","secret":"whsec_…"}]`.

## How it works

- **Reads.** `loadPage` reads Draft Mode first, and the cookies only in Draft Mode, so public
  pages stay static. Published reads go to the Data Cache with the Genga cache tags, for one
  hour at most (`maxAge`).
- **Publish.** The webhook route checks the Standard Webhooks signature, then calls
  `revalidateTag(tag, { expire: 0 })` for each tag of the event.
- **Preview.** The editor opens the entry route with a preview token. The route checks the token
  with the Genga server, turns Draft Mode on, and keeps the token in an `HttpOnly` cookie. In
  production both cookies are `SameSite=None; Secure; Partitioned`, so the preview works in the
  admin frame also when the admin is on another site (Chrome, Firefox, Safari). Browsers that
  block every third-party cookie (GNOME Web) need the admin on the same site, for example
  `cms.example.com` for `www.example.com`. The token never goes in the page URL.
- **Blocks.** `defineBlockComponents(config, { hero: Hero })` maps block types to components.
  In a preview, a Client Component block (`'use client'`) follows each keystroke. A Server
  Component block shows the draft after each autosave, when `<GengaPreview>` refreshes the page.
  `usePreviewData` from `@genga-cms/next/client` gives the live draft to your own Client
  Components.
- **Rich text.** `RichText` renders the HTML of the allowlist renderer of Genga.

## Before production

- **CDN.** Published pages send the ISR header of Next.js (`s-maxage`). `revalidateTag` clears
  the cache of Next.js only: purge your CDN on the webhook (`onEvent`), or do not cache the pages
  there. More than one instance of the site needs a shared `cacheHandler`.
- **Rate limit.** All reads of the site come from one client address. Raise `GENGA_RATE_LIMIT`
  on the Genga server for the site, or exempt it.
- **Frame.** If the site sends a CSP, allow the admin origin in `frame-ancestors` for the
  preview. Turn analytics off when `page.preview` is true, and add `robots: { index: false }`.
- A missed webhook expires after `maxAge`: the adapter does not read `/api/v1/events` yet.

See [`examples/next`](https://github.com/sakuga-software/genga/tree/main/examples/next) for a
complete site, and [the adapter specification](https://github.com/sakuga-software/genga/blob/main/docs/adapters.md).
