# Architecture

Genga (原画, the key drawings of an animation) is a content system that lives inside a
React Router v7 app. It gives the app an admin, access control, versions, a media library
and a live editor of the app's own React components.

## Goals

- **Accessible.** The admin follows WCAG 2.2 AA: keyboard first, real form controls,
  visible focus, labels, and live regions for the save and publish status.
- **Access control.** Roles with permissions per collection and per action.
- **Designed.** The admin has its own dark look on HeroUI v3 tokens, not a generic
  dashboard kit. It uses only open-source components.
- **Live edit of components.** Pages are lists of blocks. A block is a React component of
  the site with a field schema. The editor shows the real site in a frame and updates it at
  each keystroke.
- **SSR.** The site renders published content on the server. Drafts render in preview mode
  for signed-in users only.
- **Versions and publication.** A document has one draft and at most one published version.
  Publish, unpublish and restore a version.
- **Files.** A media library with upload, alt text, image sizes and a storage adapter.

## Non-goals for v1

Localization, scheduled publication, GraphQL, plugins, multi-tenant, real-time co-editing,
relation fields, nested blocks, video, an S3 adapter (the interface exists).

## Package layout

```
packages/genga
  src/
    index.ts           entry "genga": field builders, defineConfig, defineBlock, access, schemas
    config.ts          defineConfig, defineBlock, serializeSchema
    fields/            field builders -> zod schema, default values, tolerant reads
    access.ts          roles, can(user, action, collection, doc?)
    rich-text.ts       TipTap JSON schema, sanitizer, URL rule
    populate.ts        resolves media ids to media objects
    server/            entry "genga/server": createGenga()
      auth.ts          scrypt password hash, sessions, setup and invite tokens
      documents.ts     create, saveDraft, publish, unpublish, restore, list, delete
      published.ts     findPublished, list, sitemap, loadForRoute (preview aware)
      media.ts         upload, sizes with sharp, serve, delete
      storage/         StorageAdapter interface, local adapter
      admin.ts         loaders and actions of the admin routes
      api.ts           JSON API under /admin/api/*
    admin/             entry "genga/admin": route components of the admin
      shell/           app shell (sidebar, top bar, command palette)
      ui/              own components: split pane, segmented control, KPI, empty state
      editor/          document editor, field inputs, rich text editor, preview pane
      admin.css        compiled to dist/admin.css with Tailwind v4 at build time
    render/            entry "genga/render": RenderBlocks, RichText, usePreviewData
    client/            entry "genga/client": the same renderers, the preview bridge, apiRequest
    preview/           entry "genga/preview": connectPreview and the bridge, no React
    rich-text-html.ts  TipTap JSON to an HTML string, the same markup as <RichText>
    public-data.ts     the public API shape: absolute media URLs, rich text HTML
  migrations/          plain .mjs migrations and their runner (shipped as is)
  bin/genga-migrate.mjs
```

The app owns the config: its collections, its blocks (React components of the site) and
its access overrides. The app mounts the admin route modules under `/admin/*` (or the
`adminPath` option), the API under `/admin/api/*` and the media route under `/media/*`. See
[examples/react-router](../examples/react-router) for a complete app.

## Data model (Postgres)

Content is JSONB, validated by the config at write time. A new field needs no SQL migration.
Reads tolerate old JSONB: unknown keys are ignored, missing keys take their defaults.

- `genga_users(id, email, name, password_hash, role, created_at, disabled_at)`
- `genga_sessions(id, user_id, token_hash, expires_at, refreshed_at, created_at, user_agent)`
- `genga_documents(id, collection, slug, draft, draft_rev, published_version_id, published_at, created_by, deleted_at, …)`,
  unique `(collection, slug)` among the rows that are not deleted
- `genga_versions(id, document_id, data, created_at, created_by, kind, note)`
- `genga_media(id, key, filename, mime, size, width, height, alt, sizes, created_at, created_by)`
- `genga_tokens`: one-time setup, invite and password links (hashed)
- `genga_redirects(collection, from_slug, to_slug)`
- `genga_audit(id, at, user_id, action, collection, document_id, detail)`

`findPublished(collection, slug)` reads the version that `published_version_id` points to.
The site never reads `draft` outside preview mode.

Migrations are expand-only (add tables, columns and indexes; never drop or rename in place).
They run in one transaction under a Postgres advisory lock, from `genga-migrate` or from
`genga.ready()`. Two processes that start together apply each migration once.

## Access control

Roles: `admin`, `editor`, `author`. Actions: `read`, `create`, `update`, `publish`, `delete`,
`media.upload`, `media.delete`, `users.manage`. A collection can override the matrix.
An `author` updates only the documents it created (checked in SQL) and cannot publish.

Every admin loader and action calls `requireUser`, then `can`. See [security](./security.md).

## Fields

`text`, `textarea`, `slug` (from another field), `number`, `boolean`, `select`, `date`,
`url`, `tags`, `media`, `richText`, `array`, `blocks`, `group`. See
[configuration](./configuration.md).

## Versions and slugs

- Autosave writes `genga_documents.draft` only, with a `draft_rev` compare-and-set. A
  conflict answers 409, and the editor offers to reload or to keep its version.
- Version rows are written on publish, on restore and on an explicit "save a version".
  `publish` takes a `draft_rev`.
- The slug lives on the row. It is editable until the first publish. After that, a slug
  change takes effect at publish and writes a `genga_redirects` row; the site answers 301.
- Delete unpublishes first. The slug becomes free again.

## Blocks and the live editor

See [blocks](./blocks.md) and [preview bridge](./preview-bridge.md).

## Media

- Upload with `multipart/form-data`. The server sniffs the magic bytes (`file-type`).
  Allowed: JPEG, PNG, WebP, AVIF, GIF, PDF. No SVG.
- Images get `width`, `height` and WebP sizes (480, 960, 1600) with sharp, which uses
  `limitInputPixels` and drops metadata.
- Keys are content hashes, so uploads dedupe. `/media/<key>` serves the file with long cache
  headers, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, and
  `Content-Disposition: attachment` for PDF. A key resolves only through its database row.
- A media item cannot be deleted while a draft or a published version references it.

## Cache

An in-process cache keeps the published documents per `(collection, slug)` and per list.
Publish and unpublish invalidate it. It serves stale data if the database fails. The browser
gets `Cache-Control: public, max-age=0, must-revalidate` with an `ETag` from the version id.

## Operations

- One replica only: the published cache, the login rate limit and the local media volume
  are local to the process. This also holds for the headless server.
- Back up the database (`pg_dump`) and the media directory together. A media row without its
  file answers 404; a file without its row is never served.
- Without `DATABASE_URL`, the app can keep the CMS off: content routes use a fallback and
  `/admin` answers 503 (see the example's `.server/genga.ts`).

## The admin UI

The admin uses HeroUI v3 (open source), React Aria Components and TipTap. Genga's own
components fill the gaps:

| Need                 | Component                                                                         |
| -------------------- | --------------------------------------------------------------------------------- |
| App shell            | `admin/shell/app-shell.tsx`: sidebar (collapsible, ⌘B), top bar, drawer on mobile |
| Command palette (⌘K) | `admin/shell/command-palette.tsx`: HeroUI `Modal` + RAC `Autocomplete` + `Menu`   |
| Key figures          | `admin/ui/kpi.tsx`: a description list in one surface                             |
| Empty state          | `admin/ui/empty-state.tsx`                                                        |
| Drop zone            | `admin/components/media-upload.tsx`: RAC `DropZone` + `FileTrigger`               |
| Resizable split      | `admin/ui/split-pane.tsx`: window splitter, pointer and keyboard                  |
| Segmented control    | `admin/ui/segmented-control.tsx`: HeroUI `ToggleButtonGroup`                      |
| Rich text editor     | `admin/editor/rich-text-input.tsx`: TipTap + HeroUI `Toolbar`/`ToggleButton`      |

## The headless server

`apps/server` runs Genga as a standalone headless CMS, published as the Docker image
`ghcr.io/sakuga-software/genga`. It is a small React Router app that imports `genga` like any
consumer. It mounts the admin, a public read API (`/api/v1`), `/media/*` and health checks.
The config is a JSON or `.mjs` file, with blocks as schemas only. See
[headless server](./headless-server.md) and [public API](./api.md).
