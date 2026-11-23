# Configuration

## Install

```sh
pnpm add genga react react-dom react-router
```

Genga needs Node 22.12 or later, React 19, React Router 7 and Postgres 14 or later.
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

| Builder    | Value                                  | More options                                                      |
| ---------- | -------------------------------------- | ----------------------------------------------------------------- |
| `text`     | `string`                               | `maxLength`, `placeholder`, `defaultValue`                        |
| `textarea` | `string`                               | `maxLength`, `rows`, `defaultValue`                               |
| `slug`     | `string`                               | `from` (field to slugify)                                         |
| `number`   | `number \| null`                       | `min`, `max`, `integer`, `defaultValue`                           |
| `boolean`  | `boolean`                              | `defaultValue`                                                    |
| `select`   | `string`                               | `options: { label, value }[]`, `defaultValue`                     |
| `date`     | `string` (`YYYY-MM-DD`)                |                                                                   |
| `url`      | `string`                               | `placeholder`. Allows http, https, mailto, tel and relative URLs. |
| `tags`     | `string[]`                             | `maxItems`                                                        |
| `media`    | `MediaObject \| null` (after populate) | `accept: 'image' \| 'any'`                                        |
| `richText` | `RichTextDoc \| null`                  |                                                                   |
| `array`    | `Array<{ _id } & values>`              | `fields`, `itemLabel`, `minItems`, `maxItems`                     |
| `blocks`   | `BlockData[]`                          | `allowed` (block types)                                           |
| `group`    | `values`                               | `fields`                                                          |

`FieldValues<typeof fields>` gives the TypeScript type of the values.

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

| Option                | Default                           | Purpose                                                                                             |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `databaseUrl`         | required                          | Postgres URL.                                                                                       |
| `adminPath`           | `GENGA_ADMIN_PATH`, else `/admin` | Base path of the admin. The admin API is under `<adminPath>/api`.                                   |
| `siteUrl`             | required                          | Public origin. Setup links, sitemap. Its origin can always write.                                   |
| `allowedOrigins`      | `[]`                              | More origins that can send writes.                                                                  |
| `mediaDir`            | `./data/media`                    | Directory of the local storage adapter.                                                             |
| `storage`             | local adapter                     | A `StorageAdapter`.                                                                                 |
| `adminEmail`          | `null`                            | Email of the first admin, shown in the setup form.                                                  |
| `secureCookies`       | `NODE_ENV === 'production'`       | `__Host-genga` cookie with `Secure`.                                                                |
| `trustedProxies`      | `GENGA_TRUSTED_PROXIES`, else 1   | Proxies in front of the app that append to `X-Forwarded-For`.                                       |
| `previewOrigins`      | `GENGA_PREVIEW_ORIGINS`           | Origins of preview pages on another origin. Read-only access.                                       |
| `previewSecret`       | `GENGA_SECRET`                    | Signs the preview tokens. 32 characters or more.                                                    |
| `mediaResourcePolicy` | `same-origin`                     | `Cross-Origin-Resource-Policy` of `/media/*`. Use `cross-origin` when other origins show the media. |
| `maxConnections`      | 10                                | Size of the Postgres pool.                                                                          |
| `logger`              | `console`                         | `{ info, warn, error }`.                                                                            |

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
route('/admin/api/*', 'routes/admin/api.ts'),
route('/admin', 'routes/admin/shell.tsx', [
  route('login', 'routes/admin/login.tsx'),
  route('setup', 'routes/admin/setup.tsx'),
  layout('routes/admin/app.tsx', [
    index('routes/admin/dashboard.tsx'),
    route('collections/:collection', 'routes/admin/collection.tsx'),
    route('collections/:collection/:id', 'routes/admin/document.tsx'),
    route('media', 'routes/admin/media.tsx'),
    route('users', 'routes/admin/users.tsx'),
  ]),
]),
route('/media/*', 'routes/media.ts'),
```

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
