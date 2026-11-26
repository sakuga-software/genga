# Changelog

All notable changes to the `genga` package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
