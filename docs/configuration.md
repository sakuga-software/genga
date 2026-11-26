# Configuration

## Install

```sh
pnpm add genga react react-dom react-router
```

Genga needs Node 22.12 or later, React 19, React Router 7 or 8 and Postgres 14 or later.
React Router 8 itself needs Node 22.22 or later.
The admin stylesheet is compiled: the app needs no Tailwind config for the admin.

## The config

```ts
// app/genga.config.ts
import { blocks, defineConfig, slug, text, textarea } from 'genga';
import { heroBlock } from './blocks/hero';

export const gengaConfig = defineConfig({
  collections: {
    pages: {
      label: 'Pages',
      labelSingular: 'Page',
      titleField: 'title',
      path: (value) => `/${value}`,
      fields: {
        title: text({ label: 'Title', required: true }),
        slug: slug({ label: 'Slug', from: 'title', required: true }),
        description: textarea({ label: 'Description' }),
        body: blocks({ label: 'Content' }),
      },
    },
  },
  blocks: [heroBlock],
  media: { maxUploadBytes: 20_000_000 },
});
```

`defineConfig` checks the config at start:

- Each collection has exactly one `slug` field, and its name is `slug`.
- `titleField` names a field of the collection.
- Each block type is unique.

The slugs `admin`, `media` and `api` are reserved.

### A preview on another origin

```ts
posts: {
  path: (value) => `/blog/${value}`,
  previewUrl: ({ slug }) => `https://www.example.com/blog/${slug}`,
  // …
}
```

```ts
createGenga(gengaConfig, {
  // …
  previewOrigins: ['https://www.example.com'],
  previewSecret: process.env.GENGA_SECRET,
  mediaResourcePolicy: 'cross-origin',
});
```

See [preview bridge](./preview-bridge.md#a-site-on-another-origin).

### Collection options

| Option          | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `label`         | Plural name in the admin.                                                   |
| `labelSingular` | Singular name, for example in "New: page".                                  |
| `titleField`    | The field that names a document in lists.                                   |
| `path(slug)`    | Public URL of a document. Used for previews, redirects and the sitemap.     |
| `previewUrl`    | The preview page, on the site origin or another one. `false` hides it.      |
| `sortField`     | Field that sorts the public lists, newest first. Default: publication date. |
| `access`        | Overrides of the access matrix (see below).                                 |
| `fields`        | The fields.                                                                 |

### Fields

All fields take `label`, `description` and `required`.

| Builder    | Value                                                 | More options                                                      |
| ---------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `text`     | `string`                                              | `maxLength`, `placeholder`, `defaultValue`                        |
| `textarea` | `string`                                              | `maxLength`, `rows`, `defaultValue`                               |
| `slug`     | `string`                                              | `from` (field to slugify)                                         |
| `number`   | `number \| null`                                      | `min`, `max`, `integer`, `defaultValue`                           |
| `boolean`  | `boolean`                                             | `defaultValue`                                                    |
| `select`   | `string`                                              | `options: { label, value }[]`, `defaultValue`                     |
| `date`     | `string` (`YYYY-MM-DD`)                               |                                                                   |
| `url`      | `string`                                              | `placeholder`. Allows http, https, mailto, tel and relative URLs. |
| `tags`     | `string[]`                                            | `maxItems`                                                        |
| `media`    | `MediaObject \| null` (after populate)                | `accept: 'image' \| 'any'`                                        |
| `richText` | `RichTextDoc \| null`                                 |                                                                   |
| `relation` | `RelatedDocument \| null`, or a list (after populate) | `to` (collection), `multiple`, `maxItems`                         |
| `array`    | `Array<{ _id } & values>`                             | `fields`, `itemLabel`, `minItems`, `maxItems`                     |
| `blocks`   | `BlockData[]`                                         | `allowed` (block types)                                           |
| `group`    | `values`                                              | `fields`                                                          |

`FieldValues<typeof fields>` gives the TypeScript type of the values.

### Relations

`relation({ to: 'authors' })` links a document to a document of `authors`.
`relation({ to: 'posts', multiple: true, maxItems: 3 })` links to a list. The draft stores the
document ids. The editor has a combobox that searches the target collection: it lists the
documents that you can read, and every published document.

On the site, `populate` gives the **published** version of each target, with its media, as a
`RelatedDocument`: `{ id, collection, slug, path, title, publishedAt, data }`. A target that is not
published is `null`, or left out of a list. The relations of a target stay `{ id, collection }`:
one level only, so a cycle cannot loop. A preview shows the draft of the previewed document with
the published version of its targets.

- **Publish.** The publish refuses a target that is deleted or not in the collection `to`
  (`missing_relation`). A target that exists but is not published does not stop the publish.
- **Cache.** A publish, unpublish or delete of a target clears the cache of the collections that
  point to it, and its event carries their tags (`genga:c:<collection>`). The `ETag` of a document
  includes the data of its targets.
- **Unknown collection.** `defineConfig` throws when `to` names a collection that does not exist.

### Access

Roles: `admin`, `editor`, `author`. Default matrix:

| Action         | Roles                 |
| -------------- | --------------------- |
| `read`         | admin, editor, author |
| `create`       | admin, editor, author |
| `update`       | admin, editor, author |
| `publish`      | admin, editor         |
| `delete`       | admin, editor         |
| `media.upload` | admin, editor, author |
| `media.delete` | admin, editor         |
| `users.manage` | admin                 |

An `author` sees and changes only its own documents. A collection can override the document
actions and the roles that see only their own documents:

```ts
access: { publish: ['admin'], ownOnly: ['author', 'editor'] }
```

## The server instance

```ts
// app/.server/genga.ts
import { createGenga } from 'genga/server';
import { gengaConfig } from '../genga.config';

export const genga = createGenga(gengaConfig, {
  databaseUrl: process.env.DATABASE_URL!,
  siteUrl: process.env.SITE_URL!,
  allowedOrigins: ['https://www.example.com'],
  mediaDir: process.env.GENGA_MEDIA_DIR ?? './data/media',
  adminEmail: process.env.GENGA_ADMIN_EMAIL ?? null,
});
```

Keep one instance per process. In development, store it on `globalThis`, because Vite
reloads modules. See `examples/react-router/app/.server/genga.ts`.

| Option                | Default                           | Purpose                                                                                               |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `databaseUrl`         | required                          | Postgres URL.                                                                                         |
| `adminPath`           | `GENGA_ADMIN_PATH`, else `/admin` | Base path of the admin. The admin API is under `<adminPath>/api`.                                     |
| `siteUrl`             | required                          | Public origin. Setup links, sitemap. Its origin can always write.                                     |
| `allowedOrigins`      | `[]`                              | More origins that can send writes.                                                                    |
| `mediaDir`            | `./data/media`                    | Directory of the local storage adapter.                                                               |
| `storage`             | local adapter                     | A `StorageAdapter`: `localStorageAdapter(dir)` or `s3StorageAdapter(options)`, see below.             |
| `adminEmail`          | `null`                            | Email of the first admin, shown in the setup form.                                                    |
| `secureCookies`       | `NODE_ENV === 'production'`       | `__Host-genga` cookie with `Secure`.                                                                  |
| `trustedProxies`      | `GENGA_TRUSTED_PROXIES`, else 1   | Proxies in front of the app that append to `X-Forwarded-For`.                                         |
| `siteLink`            | `/`                               | The link "Voir le site" of the admin. `null` hides it.                                                |
| `previewOrigins`      | `GENGA_PREVIEW_ORIGINS`           | Origins of preview pages on another origin. Read-only access.                                         |
| `previewSecret`       | `GENGA_SECRET`                    | Signs the preview tokens. 32 characters or more.                                                      |
| `mediaPath`           | `/media`                          | Base path of the media files. Media URLs start with it.                                               |
| `mediaResourcePolicy` | `same-origin`                     | `Cross-Origin-Resource-Policy` of the media files. Use `cross-origin` when other origins show them.   |
| `publicApi`           | `false`                           | The [public API](./api.md) under `/api/v1` in `genga.handle`. `true` or `{ corsOrigins, rateLimit }`. |
| `maxConnections`      | 10                                | Size of the Postgres pool.                                                                            |
| `logger`              | `console`                         | `{ info, warn, error }`.                                                                              |
| `mcp`                 | off in `genga.handle`             | `{ path, allowedOrigins }` turns the [MCP endpoint](./mcp.md) on. `path` defaults to `/mcp`.          |
| `mcp.allowedOrigins`  | the allowed origins               | Browser origins that can call the MCP endpoint. A request without `Origin` passes.                    |
| `mcp.oauth`           | on with `mcp`                     | OAuth sign-in for MCP clients ([MCP OAuth](./mcp.md#connect-with-oauth)). `false` keeps tokens only.  |
| `webhooks`            | `GENGA_WEBHOOKS`                  | `[{ url, secret, events? }]`: receivers of the signed [publish webhooks](./events.md).                |
| `webhookDelivery`     | `{}`                              | `{ fetch, pollMs, timeoutMs }` of the webhook sender.                                                 |
| `scheduler`           | `{ intervalMs: 30000 }`           | The runner of [scheduled publish](#scheduled-publish). `false` turns its timer off.                   |

## Scheduled publish

In the editor, « Programmer » sets a date to publish a document and a date to unpublish it.
`PUT <adminPath>/api/documents/:id/schedule` takes `{ publishAt, unpublishAt }` (ISO dates, `null`
clears one, an absent key stays as it is). It needs the right to publish.

- At the date, Genga publishes the draft of that moment, as the user who saved the schedule. The
  action is a normal publish or unpublish: the same [events](./events.md), webhooks, cache
  invalidation and audit entry, with `detail.scheduled: true`.
- A manual publish clears the scheduled publish. A manual unpublish clears the scheduled
  unpublish. A delete clears both.
- If the action is refused (the user lost the right or the account, a field is invalid, the slug
  is taken), the schedule stops, the editor shows the reason, and the audit log gets
  `document.schedule_failed`. Save a new date to try again.
- Each process runs the due actions every `scheduler.intervalMs` (30 seconds), so an action runs
  up to that long after its date. With several replicas, one runs them at a time, under a Postgres
  advisory lock, and each action runs once.
- On a platform without a long-lived process, set `scheduler: false` and call
  `genga.runSchedules()` from a cron job.

## S3 storage

```ts
import { createGenga, s3StorageAdapter } from 'genga/server';

const genga = createGenga(config, {
  // …
  storage: s3StorageAdapter({
    bucket: 'my-media',
    region: 'fr-par',
    endpoint: 'https://s3.fr-par.scw.cloud', // leave out for AWS
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    prefix: 'genga',
    delivery: 'proxy', // or 'public' with publicUrl, or 'signed'
  }),
});
```

| Option               | Default                 | Purpose                                                        |
| -------------------- | ----------------------- | -------------------------------------------------------------- |
| `bucket`             | required                | The bucket.                                                    |
| `accessKeyId`        | required                | The access key.                                                |
| `secretAccessKey`    | required                | The secret key.                                                |
| `sessionToken`       | none                    | For temporary credentials.                                     |
| `region`             | `us-east-1`             | The region.                                                    |
| `endpoint`           | AWS                     | The origin of another provider (Scaleway, MinIO).              |
| `forcePathStyle`     | `true` with an endpoint | Path-style URLs.                                               |
| `prefix`             | none                    | A key prefix.                                                  |
| `delivery`           | `proxy`                 | `proxy`, `public` or `signed`.                                 |
| `publicUrl`          | none                    | With `public`: the URL of the files. Media URLs start with it. |
| `signedUrlExpiresIn` | `3600`                  | With `signed`: seconds that a presigned URL stays valid.       |
| `timeoutMs`          | `30000`                 | Time for one request to the bucket. Genga does not retry.      |

The three deliveries, the rights of the key and the move from a local directory are in
[the headless server guide](./headless-server.md#s3-storage). Requests are signed with
AWS Signature Version 4 (`aws4fetch`).

## One handler: `genga.handle`

`genga.handle(request, context?)` is one Fetch handler for every Genga path that is not an
admin page. It returns a `Response`, or `null` for a path that Genga does not own, so the app
answers it.

| Path                      | Content                                    | Default    |
| ------------------------- | ------------------------------------------ | ---------- |
| `<adminPath>/api/**`      | Admin JSON API (session cookie)            | on         |
| `<mediaPath>/**`          | Media files                                | on         |
| `/api/v1/**`              | [Public API](./api.md) and preview drafts  | off        |
| `<mcp.path>`              | [MCP endpoint](./mcp.md) (Streamable HTTP) | off        |
| `/.well-known/oauth-*`    | OAuth metadata of the MCP endpoint         | with `mcp` |
| `<adminPath>/api/oauth/*` | OAuth token, registration, revocation      | with `mcp` |

```ts
// Hono
app.all('*', async (c, next) => (await genga.handle(c.req.raw)) ?? next());

// React Router: a resource route for each Genga path
export const loader = async ({ request }: Route.LoaderArgs) =>
  (await genga.handle(request)) ?? new Response('Not found', { status: 404 });
export const action = loader;
```

- **Readiness.** The handler waits for `genga.ready()`. If the database is not reachable, it
  answers `503` on its paths.
- **Client address.** Pass the TCP peer as `context.peerAddress` when your server gives it.
  The handler appends it to `X-Forwarded-For` and counts it as one more proxy hop, so
  `trustedProxies` still picks the client. Do not pass an address that a proxy computed.
- **Paths.** Genga refuses to start when two of its paths overlap, for example
  `adminPath: '/api'` with the public API on.
- **Admin pages.** The admin pages stay route modules (below) until the admin becomes a
  single-page app. `genga.handle` returns `null` for them.

`genga.api(request, path)`, `genga.mcp(request)` and `genga.media.serve(key)` still work, but
they are deprecated: each logs one warning per process, and they leave at 1.0.

## Environment variables (example app)

| Variable                | Purpose                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`          | Postgres URL. Without it, the example keeps the CMS off.           |
| `SITE_URL`              | Public origin of the site.                                         |
| `GENGA_MEDIA_DIR`       | Media directory. Mount a persistent volume there in production.    |
| `GENGA_ALLOWED_ORIGINS` | Comma-separated origins that can send writes.                      |
| `GENGA_ADMIN_EMAIL`     | Email of the first admin.                                          |
| `GENGA_TRUSTED_PROXIES` | Number of trusted proxies. Default 1. 0 ignores `X-Forwarded-For`. |

## Routes

The app mounts these route modules. Each one is a few lines: the loader calls Genga, the
component comes from `genga/admin`.

```ts
// app/routes.ts
route('/admin/api/*', 'routes/admin/api.ts'), // genga.handle(request)
route('/admin', 'routes/admin/shell.tsx', [
  route('login', 'routes/admin/login.tsx'),
  route('setup', 'routes/admin/setup.tsx'),
  layout('routes/admin/app.tsx', [
    index('routes/admin/dashboard.tsx'),
    route('collections/:collection', 'routes/admin/collection.tsx'),
    route('collections/:collection/:id', 'routes/admin/document.tsx'),
    route('media', 'routes/admin/media.tsx'),
    route('users', 'routes/admin/users.tsx'),
    route('tokens', 'routes/admin/tokens.tsx'),
  ]),
]),
route('/media/*', 'routes/media.ts'), // genga.handle(request)
route('/mcp', 'routes/mcp.ts'), // optional: genga.handle(request) with the mcp option, see docs/mcp.md
// With the mcp option, OAuth needs these two routes too:
route('/.well-known/*', 'routes/well-known.ts'), // genga.handle(request)
route('/admin/oauth/authorize', 'routes/admin/oauth-authorize.tsx'), // the consent page, outside the app layout
```

The consent page (`OAuthConsentPage`) has the loader `genga.admin.oauthAuthorizeLoader(request)`
and the action `genga.admin.oauthAuthorizeAction(request)`. Put it in the `shell.tsx` route, next
to `login`. The OAuth endpoints under `<adminPath>/api/oauth/*` go through the admin API route,
so that route must call `genga.handle`, not the deprecated `genga.api`.

The `tokens` page (`TokensPage`, loader `genga.admin.tokens(request)`) lets each user create
and revoke the personal access tokens of the [MCP endpoint](./mcp.md), and disconnect the MCP
clients that signed in with OAuth.

To mount the admin elsewhere, set `adminPath` (or `GENGA_ADMIN_PATH`), for example `/cms`,
and use the same path in `routes.ts`: `route('/cms/api/*', …)` and `route('/cms', …)`. The
admin pages read the path from their loader data.

The admin route `shell.tsx` loads the stylesheet:

```ts
import adminCss from 'genga/admin.css?url';
export const links = () => [{ rel: 'stylesheet', href: adminCss }];
```

The root layout must set these attributes on `<html>` for admin paths, because the theme
applies under `html[data-genga-admin]`:

```tsx
<html className="dark" data-theme="dark" data-genga-admin="">
```

## Migrations

`genga-migrate` applies the pending migrations and exits. Run it before the server starts:

```sh
DATABASE_URL=postgres://… npx genga-migrate && npm start
```

`genga.ready()` also applies them, then logs a one-time setup URL if no user exists.

## The first admin

At the first start with an empty database, the server logs:

```
[genga] No user yet. Create the first admin within 24 hours: https://…/admin/setup?token=…
```

Open the link and create the account. A restart without users logs a new link. Then invite
other users from `/admin/users`.

## Entries

| Entry             | Content                                                                      | Runs on |
| ----------------- | ---------------------------------------------------------------------------- | ------- |
| `genga`           | field builders, `defineConfig`, `defineBlock`, access, schemas               | both    |
| `genga/server`    | `createGenga()`: database, auth, documents, media, API, admin loaders        | server  |
| `genga/admin`     | admin route components                                                       | both    |
| `genga/admin.css` | compiled admin stylesheet                                                    | browser |
| `genga/render`    | `RenderBlocks`, `RichText`, `usePreviewData`                                 | both    |
| `genga/client`    | `RenderBlocks`, `RichText`, `usePreviewData`, `connectPreview`, `apiRequest` | both    |
| `genga/preview`   | `connectPreview`, `richTextToHtml`: no React, no dependency                  | browser |
