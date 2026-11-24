# Headless server

`ghcr.io/sakuga-software/genga` runs Genga as a standalone headless CMS, for sites that are
not built with React Router: Next.js, Astro, Nuxt, SvelteKit, plain HTML. One container
gives:

- the Genga admin, with roles, versions, the media library and the editor,
- a read-only [public JSON API](./api.md) for the published content and the media,
- the [live preview bridge](./preview-bridge.md#a-site-on-another-origin) toward your site,
  on its own origin.

The collections, fields and blocks come from a config file that you mount into the
container. The blocks are schemas only: your site renders them.

The source is [`apps/server`](../apps/server): a small React Router app that imports
`genga` like any other app.

## Quick start

```sh
curl -O https://raw.githubusercontent.com/sakuga-software/genga/main/apps/server/docker-compose.example.yml
curl -O https://raw.githubusercontent.com/sakuga-software/genga/main/apps/server/config.example.json
export GENGA_SECRET="$(openssl rand -base64 48)"
docker compose -f docker-compose.example.yml up
```

1. The server logs a one-time link: `http://localhost:3000/admin/setup?token=…`. Open it and
   create the first admin.
2. Write and publish a post in the admin.
3. Read it: `curl http://localhost:3000/api/v1/collections/posts/documents`.

The example config is a blog with `posts` and `pages` and four blocks. Its previews point to
`http://localhost:4321`, the default port of Astro: start your site there to see the live
preview.

## Run the image

```sh
docker run -d --name genga -p 3000:3000 \
  -e DATABASE_URL=postgres://genga:secret@db.internal:5432/genga \
  -e GENGA_PUBLIC_URL=https://cms.example.com \
  -e GENGA_CORS_ORIGINS=https://www.example.com \
  -e GENGA_PREVIEW_ORIGINS=https://www.example.com \
  -e GENGA_SECRET="$(openssl rand -base64 48)" \
  -e GENGA_TRUSTED_PROXIES=1 \
  -v "$PWD/genga.config.json:/config/genga.config.json:ro" \
  -v genga-media:/data \
  ghcr.io/sakuga-software/genga:latest
```

At start, the container runs `genga-migrate`, then the server. A bad setting or config stops
it at once, with the list of the problems:

```
[genga] Genga cannot start:
  - DATABASE_URL is required, for example postgres://genga:secret@postgres:5432/genga.
  - GENGA_SECRET must have at least 32 characters. Try: openssl rand -base64 48
```

### Tags

| Tag                 | Content                                    |
| ------------------- | ------------------------------------------ |
| `X.Y.Z`, `X.Y`      | A release. Pin one of these in production. |
| `latest`            | The last release.                          |
| `edge`, `sha-<sha>` | The `main` branch. Not for production.     |

The images are for `linux/amd64` and `linux/arm64`, with provenance and SBOM attestations.

### The image

- Alpine with the Node 22 binary only: no npm, no shell tools other than BusyBox. About
  180 MB on disk and 65 MB compressed.
- The server runs as the user `genga` (UID 10001), under `tini` for the signals.
- `VOLUME /data`: the media files are in `/data/media`. Give the volume to UID 10001 if you
  mount a host directory.
- `EXPOSE 3000`, and a `HEALTHCHECK` on `/healthz`.

## Environment

| Variable                | Default                                  | Purpose                                                                                                                                  |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | required                                 | Postgres 14 or later.                                                                                                                    |
| `GENGA_CONFIG`          | `/config/genga.config.json`, then `.mjs` | The [config file](#the-config-file).                                                                                                     |
| `GENGA_PUBLIC_URL`      | `http://localhost:$PORT`                 | The origin of this server, as browsers see it. Media URLs and setup links start with it. With `https`, the session cookie is `Secure`.   |
| `GENGA_ADMIN_PATH`      | `/admin`                                 | The admin path, one segment. The admin API is under `<path>/api`.                                                                        |
| `GENGA_MEDIA_DIR`       | `/data/media`                            | The media directory.                                                                                                                     |
| `GENGA_CORS_ORIGINS`    | none                                     | Comma-separated origins that can read the public API from a browser, or `*`.                                                             |
| `GENGA_PREVIEW_ORIGINS` | none                                     | Comma-separated origins of the preview pages. Each `previewUrl` on another origin must be in this list.                                  |
| `GENGA_SECRET`          | none                                     | 32 characters or more. Signs the preview tokens. Required when a preview is on another origin.                                           |
| `GENGA_ALLOWED_ORIGINS` | none                                     | More origins that can send writes to the admin API. The origin of `GENGA_PUBLIC_URL` always can.                                         |
| `GENGA_TRUSTED_PROXIES` | `0`                                      | The number of reverse proxies in front of the server. See below.                                                                         |
| `GENGA_RATE_LIMIT`      | `300`                                    | Requests per minute and per client address on the public API.                                                                            |
| `GENGA_ADMIN_EMAIL`     | none                                     | The email of the first admin, filled in the setup form.                                                                                  |
| `GENGA_SITE_URL`        | none                                     | The public site, for the link "Voir le site" of the admin. Without it, the admin hides the link.                                         |
| `GENGA_MCP`             | `on`                                     | `off` turns the [MCP endpoint](./mcp.md) off.                                                                                            |
| `GENGA_MCP_PATH`        | `/mcp`                                   | The path of the MCP endpoint, one segment.                                                                                               |
| `GENGA_WEBHOOKS`        | none                                     | A JSON array of `{ "url", "secret", "events" }`: the receivers of the [publish webhooks](./events.md). The secret is not `GENGA_SECRET`. |
| `PORT`                  | `3000`                                   | The port in the container.                                                                                                               |

The three origin lists are separate on purpose. A CORS origin can only read published
content. A preview origin can only read drafts with a token. Neither can write.

### Behind a reverse proxy

The server reads the client address from `X-Forwarded-For`. It adds the address of the TCP
peer itself, so with `GENGA_TRUSTED_PROXIES=0` the client is the peer. Behind Traefik, Caddy
or nginx, set `GENGA_TRUSTED_PROXIES=1` (one value per proxy that appends to the header).
A value that is too high lets a client choose its address; a value that is too low puts all
clients in the bucket of the proxy. The login limits and the API rate limit use this address.

Terminate TLS at the proxy and set `GENGA_PUBLIC_URL` to the `https` origin.

## The config file

### JSON

JSON is enough for a schema-only CMS. The server checks the file at start and names each
mistake, for example `collections.posts.fields.title.maxLenght: Unrecognized key`.

```json
{
  "collections": {
    "posts": {
      "label": "Articles",
      "labelSingular": "Article",
      "titleField": "title",
      "sortField": "publishedDate",
      "path": "/blog/{slug}",
      "previewUrl": "https://www.example.com/blog/{slug}",
      "access": { "publish": ["admin", "editor"] },
      "fields": {
        "title": { "type": "text", "label": "Titre", "required": true, "maxLength": 160 },
        "slug": { "type": "slug", "from": "title", "required": true },
        "cover": { "type": "media", "accept": "image" },
        "publishedDate": { "type": "date", "required": true },
        "tags": { "type": "tags" },
        "body": { "type": "blocks", "allowed": ["text", "quote"] }
      }
    }
  },
  "blocks": [
    { "type": "text", "label": "Texte", "fields": { "content": { "type": "richText" } } },
    {
      "type": "quote",
      "label": "Citation",
      "fields": { "quote": { "type": "textarea" }, "author": { "type": "text" } }
    }
  ],
  "access": { "delete": ["admin"] },
  "media": { "maxUploadBytes": 20000000 }
}
```

| Key                      | Meaning                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `collections.<name>`     | Lowercase letters, digits and `-`. The name is in the API paths.                                                                        |
| `label`, `labelSingular` | The names in the admin. `labelSingular` defaults to `label`.                                                                            |
| `titleField`             | The field that names a document. Default `title`.                                                                                       |
| `path`                   | The URL of a document on the site, with `{slug}`. The API gives it, and the redirects use it.                                           |
| `previewUrl`             | The page of the site that shows a draft, with `{slug}`, `{id}`, `{collection}` or `{path}`. Without it, the editor has no preview pane. |
| `sortField`              | The field that sorts the lists, newest first. Default: the publication date.                                                            |
| `access`                 | Role overrides of the collection: `read`, `create`, `update`, `publish`, `delete`, `ownOnly`.                                           |
| `fields`                 | The fields. Exactly one field of type `slug`, named `slug`.                                                                             |
| `blocks`                 | The block types: `type`, `label`, `description`, `fields`.                                                                              |
| `access` (top level)     | The default overrides for the collections without their own `access`.                                                                   |
| `media.maxUploadBytes`   | The upload limit. Default 20 MB.                                                                                                        |

The field types and their options are the ones of the field builders: see
[configuration](./configuration.md#fields). The roles are `admin`, `editor` and `author`.

### JavaScript module

A `.mjs` file allows functions, for example a `previewUrl` that depends on the collection. A
file mounted into the container cannot import `genga`, so the module exports a function that
gets the `genga` helpers:

```js
// genga.config.mjs
export default ({ text, slug, richText, blocks, defineBlock }) => ({
  collections: {
    docs: {
      label: 'Documentation',
      path: (value) => `/docs/${value}`,
      previewUrl: (doc) => `https://docs.example.com${doc.path}?draft=1`,
      fields: { title: text({ required: true }), slug: slug({ from: 'title' }), body: blocks() },
    },
  },
  blocks: [defineBlock({ type: 'text', label: 'Text', fields: { content: richText() } })],
});
```

The server checks the result with the same rules as JSON.

## Operations

- **One replica.** The published cache, the rate limits and the media volume are local to
  the process. Do not scale the service above one container.
- **Backups.** Back up the database (`pg_dump`) and the `/data` volume together.
- **Upgrades.** Pull the new tag and restart. The migrations are expand-only and run at
  start under an advisory lock.
- **Health.** `/healthz` checks the process and the database. `/readyz` also checks that the
  migrations ran. See [the API](./api.md#health).
- **Paths.** The server uses `/api`, `/media`, `/assets`, `/healthz` and `/readyz`. The admin
  path cannot take one of them. `/` redirects to the admin.

## Build the image

```sh
docker build -f apps/server/Dockerfile -t genga .
```

Build from the repository root. The workflow `.github/workflows/docker.yml` builds
`linux/amd64` and `linux/arm64` and pushes to GHCR on `v*` tags (and `edge` from `main`).

## Run the server without Docker

```sh
pnpm install && pnpm build
DATABASE_URL=postgres://genga:genga@localhost:54329/genga \
GENGA_CONFIG=$PWD/apps/server/config.example.json \
GENGA_PREVIEW_ORIGINS=http://localhost:4321 \
GENGA_SECRET="$(openssl rand -base64 48)" \
GENGA_MEDIA_DIR=./data/media \
pnpm --filter genga-server start
```

`pnpm --filter genga-server dev` starts the same app with Vite.
