# Changelog

All notable changes to the `genga` and `@genga-cms/next` packages, which share one version.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The admin API serves the data of every admin screen and the sign-in forms, for the prebuilt
  admin (GNG-27): `GET <adminPath>/api/views/<screen>`, `GET|POST <adminPath>/api/session`,
  `GET|POST <adminPath>/api/setup` and `GET|POST <adminPath>/api/consent`. They keep the session,
  origin, login limit and role checks of the route modules. See
  `docs/configuration.md#the-admin-api-of-the-admin-pages`.
- A Content Security Policy on the admin pages, without `'unsafe-inline'`:
  `default-src 'self'; script-src 'self'; style-src 'self'; …; frame-ancestors 'none'`. See
  `docs/security.md#admin-responses`.
- `adminApp: false` option: `genga.handle` leaves the admin pages to the route modules of 0.3.
- `adminAssetsDir` option: another directory for the admin app.
- `StorageAdapter.deliveryOrigins`: the origins of the signed media URLs, for the admin CSP.
  `s3StorageAdapter` sets it with `delivery: 'signed'`.
- End-to-end tests of the admin with Playwright, in CI: setup, login, editor and live preview,
  publish, versions, media, invitation, token, OAuth consent, a custom admin path, and no CSP
  violation (`pnpm test:e2e:admin`).
- `genga.getUser(request)`: the signed-in admin user of a request, for the site in embedded
  mode. See `docs/configuration.md#embedded-mode`.
- A lint rule: `genga`, `genga/server`, `genga/remote` and `genga/preview` cannot import
  `react-router`.

### Deprecated

- `genga.admin.*`, the route components of `genga/admin` and `genga/admin.css`: route
  `<adminPath>/*` to `genga.handle(request)` instead. They still work and log one warning per
  process; they leave at 1.0. See `docs/migrate-to-admin-app.md`.

### Changed

- The admin is a prebuilt single-page app (GNG-27). `genga.handle` serves its HTML shell on
  every path under `adminPath`, and its hashed assets under `<adminPath>/_app/` with a cache of
  one year. The shell has no inline script, and reads the admin path from a meta tag, so
  `adminPath` stays a runtime option. A site mounts one route per Genga path that calls
  `genga.handle`: no admin route modules, no `genga/admin.css` link, no `data-genga-admin` in
  `root.tsx`. Login, setup and invitation links, and the OAuth consent page are pages of the
  app. See `docs/configuration.md#the-admin-app`.
  **Migration:** a site that calls `genga.handle` for every request (in a middleware) and keeps
  the admin route modules of 0.3 now gets the admin app on its admin pages. Set
  `adminApp: false` to keep the route modules. A site that routes only `<adminPath>/api/*` to
  `genga.handle` sees no change.
- The admin pages send `frame-ancestors 'none'` (was `'self'`): no page can frame the admin.
- `react-router` is an optional peer dependency of `genga`: only the deprecated `genga/admin`
  needs it.
- The example app and the server image use the admin app. The server image ships
  `dist/admin-app` and has no admin route module.
- The editor turns off the style element of TipTap (`injectCSS: false`): `genga/admin.css`
  holds its rules.
- `genga.admin.*` no longer imports `react-router`: its loaders and actions throw a plain
  `Response`, which React Router reads as a redirect or an error response, as before.

## [0.3.0] - 2026-11-28

### Added

- New package `@genga-cms/next`, for the Next.js 16.4+ App Router in remote mode (GNG-4).
  `createRemoteSource` caches published reads in the Data Cache with the Genga cache tags (one
  hour at most). `loadPage` gives the published page, a redirect or not found, and the draft in
  Draft Mode, and keeps public pages static. `webhookRoute` checks the signed webhooks and
  revalidates their tags. `previewRoute` is the preview entry route: it checks the preview
  token with the server, turns Draft Mode on and keeps the token in an `HttpOnly` cookie,
  `Partitioned` in production so that the preview works in an admin on another site (Safari).
  `GengaPreviewBridge` in the root layout connects the preview pages to the editor. `Blocks`
  and `defineBlockComponents` render the blocks: Client Component blocks follow each keystroke
  in the preview, Server Component blocks refresh after each autosave. `usePreviewData` and
  `RichText`. See `packages/next/README.md` and `examples/next`.
- `s3StorageAdapter()`: media files in an S3-compatible bucket (AWS S3, Scaleway, MinIO), with
  `proxy`, `public` or `signed` delivery. The server image reads `GENGA_S3_*`. With S3, several
  server replicas share the files. `StorageAdapter` gains the optional `publicBaseUrl` and
  `signedUrl`, and `put` an optional `contentDisposition`.
- `relation` field: a link to one document (`relation({ to })`) or a list (`multiple`,
  `maxItems`). The editor searches the target collection in an accessible combobox. `populate`,
  the public API, `genga/remote` and the preview give the published version of each target, with
  its media; its own relations stay `{ id, collection }`. Publish refuses a deleted target. A
  change to a target clears the cache and carries the tags of the collections that point to it.
  The MCP tools describe the value format. The `ETag` of a published document now includes a hash
  of its data.
- Scheduled publish and unpublish: « Programmer » in the editor, `PUT <adminPath>/api/documents/:id/schedule`,
  the `scheduler` option and `genga.runSchedules()`. One process runs the due actions at a
  time, with the normal events, webhooks and audit entries. Migration `0005_schedules`. See
  `docs/configuration.md#scheduled-publish`.
- OAuth 2.1 sign-in for the MCP endpoint, as the MCP authorization specification 2026-07-28
  describes it: protected resource metadata, authorization server metadata, client ID metadata
  documents, dynamic client registration, PKCE (S256), refresh token rotation and a consent
  page in the admin (`OAuthConsentPage`). A client signs in from its own window, with no token
  to copy. The rights stay the scopes and the role of the user, both. The tokens page lists the
  connected clients and disconnects them. On with the `mcp` option; `mcp.oauth: false` and
  `GENGA_MCP_OAUTH=off` turn it off. Personal tokens (`gga_`) keep working. Migration
  `0006_oauth`. See `docs/mcp-oauth.md`.
- `genga.handle(request, context?)`: one Fetch handler for the admin API, the media files, the
  public API and the MCP endpoint. It returns `null` for other paths, waits for `ready()`, and
  answers `503` when the database is not reachable. `context.peerAddress` appends the TCP peer
  to `X-Forwarded-For` as one more proxy hop. Genga refuses to start when its paths overlap.
- The public API v1 moves from the server image into `genga/server`. The `publicApi` option
  turns it on in `genga.handle` (off by default). The server image now serves it, the media,
  the admin API and MCP through `genga.handle`.
- `mediaPath` option (default `/media`): media URLs and `genga.handle` follow it.
- The `mcp` option takes `path` and `false`. MCP is off in `genga.handle` unless the option is
  set.
- Public API: the `301` of a renamed slug also gives `path`, the site path of the new slug.
- Publish events: `document.published`, `document.unpublished`, `document.deleted`,
  `document.slug_changed`, `media.updated` and `media.deleted`, with the cache tags to
  invalidate: `genga:c:<collection>` and `genga:d:<collection>:<slug>` for a document, `genga`
  for a media item. `genga.events.on()` runs
  listeners after the commit. `tagsFor()` gives the same tags to reads. See `docs/events.md`.
- Signed webhooks in the Standard Webhooks format (`webhooks` option, `GENGA_WEBHOOKS` on the
  server image), from an outbox table with retries and backoff for 24 hours. Migration
  `0004_events`. `verifyWebhook()` checks them on Node and edge runtimes.
- Public API: `GET /api/v1/events?after=<id>` lists the events of the last 7 days.
- Content source: `GengaSource` with `getDocument`, `listDocuments`, `resolveRoute`,
  `getDraft`, `sitemap` and `tagsFor`, in the public shape. `createGenga()` implements it in
  embedded mode (preview by session). `createRemoteSource()` from the new entry `genga/remote`
  implements it over the public API, with `fetch` only (edge-safe; preview by token, checked by
  the server). See `docs/content-source.md`.
- Public API: `GET /api/v1/sitemap`.
- Preview on another origin: `connectPreview` removes `genga-token` from the address bar and
  keeps it in memory (`connection.token()`, `previewToken(id)`). The editor renews the token
  with the `genga:token` message, and sends `genga:saved` after each autosave (`onSaved` in
  `connectPreview` and `usePreviewData`).
- Editor: blocks move by drag and drop, with a handle on each block. With the keyboard, Enter on
  the handle starts the move, Tab chooses the target block and Enter drops; a screen reader hears
  each step in French. The Monter and Descendre buttons stay (GNG-22).
- `head` option of `usePreviewData`, `connectPreview` and `connectBridge`: the preview frame
  updates `<title>` and the meta tags at each draft, like the content (GNG-23).

### Changed

- MCP `upload_media` with a `url` downloads only from ports 80 and 443, for the URL and each
  redirect. The `uploadPorts` option of `mcp` (`GENGA_MCP_UPLOAD_PORTS` on the server image)
  changes the list.
- Preview responses (`PREVIEW_HEADERS`, `loadForRoute`) also send `Referrer-Policy: no-referrer`
  and `X-Robots-Tag: noindex`.

### Deprecated

- `genga.api`, `genga.mcp` and `genga.media.serve`: use `genga.handle`. Each logs one warning
  per process. They leave at 1.0.

### Fixed

- The admin showed « Inconnu » or « — » as the author when the account had no name. It now
  shows the email of the account, also when the account is disabled (GNG-9).
- In the Versions drawer, the « Enregistrer une version » button went past the edge of the
  drawer and was cut, at all widths. The button is now below the note field (GNG-8).
- For a preview on another origin, « Ouvrir l’aperçu dans un nouvel onglet » gets a new preview
  token at the click. Before, the tab could open with an expired token and answer 401 (GNG-20).
- Server image: a POST to the MCP path with an `Origin` header of another origin got the `400`
  of React Router before the origin check of MCP. The server now sends the MCP path to
  `genga.handle` first: an origin of `GENGA_ALLOWED_ORIGINS` passes, another one gets `403`.

## [0.2.0] - 2026-11-24

### Added

- MCP server: `genga.mcp(request)`, a fetch-style handler for the Model Context Protocol over
  Streamable HTTP (stateless). 13 tools (collections, documents, drafts with `draftRev`,
  publish, versions, media with an SSRF-safe URL upload, preview URLs), the resources
  `genga://collections/{name}/schema` and `genga://documents/{id}`, and the prompt
  `write_article`. Writes go through the admin services and the audit log, with
  `via: "mcp"` and the token id. See `docs/mcp.md`.
- Personal access tokens (`gga_…`, stored as SHA-256) with the scopes `read`, `write` and
  `publish`, an expiry, and a « Jetons d’accès » page in the admin for every role. The rights
  of a token are its scopes and the role of its user, both. Disabling a user revokes its
  tokens. Migration `0003_api_tokens`. The page needs a new admin route, `tokens`
  (`TokensPage`, `genga.admin.tokens`).
- Headless server: `/mcp`, with `GENGA_MCP` (`on` or `off`) and `GENGA_MCP_PATH`.
- Headless server: the Docker image `ghcr.io/sakuga-software/genga` (`apps/server`) runs the
  admin, a public read API under `/api/v1` and the media, with a JSON or `.mjs` config file.
- Public API v1: collections and their schemas, documents by list, slug and id, media
  metadata, and drafts with a preview token. Published content only, ETag and `304`, CORS
  from an allow list, a rate limit per client address. See `docs/api.md` and
  `docs/openapi.yaml`.
- Blocks without a component (`defineBlock` with a schema only).
- Previews on another origin: `previewUrl` on a collection, `previewOrigins` and
  `previewSecret` (`GENGA_PREVIEW_ORIGINS`, `GENGA_SECRET`), signed preview tokens valid
  10 minutes for one document.
- `genga/preview` with `connectPreview` for any framework, also in `genga/client`.
  `usePreviewData` takes an `adminOrigin` option.
- `richTextToHtml` and `toPublicData` in `genga`.
- `adminPath` option and `GENGA_ADMIN_PATH`: the admin can live under another path.
- `mediaResourcePolicy` option for the `Cross-Origin-Resource-Policy` of `/media/*`.
- `siteLink` option (`GENGA_SITE_URL` on the server) for the link "Voir le site" of the admin.

### Changed

- The peer range of `react-router` accepts React Router 8 (`^7.18.4 || ^8.5.2`). React Router 8
  needs Node 22.22 or later. The headless server and the example use React Router 8 and Vite 8.
- The admin loaders return `adminPath`. A document of the admin has `preview` (its preview
  URL and origin, or `null`).

## [0.1.0]

First public release.

- Collections, fields and blocks defined in code with `defineConfig` and `defineBlock`.
- Postgres storage with expand-only migrations and the `genga-migrate` command.
- Admin for React Router v7: dashboard, collections, document editor with live preview,
  versions, media library, users and invitations.
- Roles `admin`, `editor` and `author`, with overrides per collection.
- Published reads with an in-process cache, slug redirects and a sitemap helper.
- `genga/client`: `RenderBlocks`, `RichText` and `usePreviewData` for any React site.
- Compiled admin stylesheet (`genga/admin.css`): no Tailwind setup in the app.
