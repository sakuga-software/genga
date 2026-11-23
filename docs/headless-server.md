# Headless server (phase 2)

Phase 2 adds `apps/server`: Genga as a standalone headless CMS, published as a Docker image.
A site in any stack reads the published content over HTTP, and editors use the same admin.

This page lists what exists today and what the server needs.

## What the server can reuse

- `createGenga(config, options)` from `genga/server` gives the database, auth, documents,
  media, the published reads, the admin loaders and the JSON API.
- `genga.api(request, path)` answers the admin API (`/admin/api/*`) with a Fetch `Response`.
- `genga.admin.*` are React Router loaders and actions. The server can be a small React
  Router app, like `examples/react-router`, with the admin routes and no site routes.
- `genga.media.serve(key)` answers `/media/*`.
- `genga.published.find`, `list` and `sitemap` read the published content. A public read API
  can wrap them.
- `genga-migrate` and `genga.ready()` apply the migrations at boot.

## What the server needs

- **Config without React components.** `defineBlock` takes a `component` today. A headless
  server has only the field schema. The server needs a way to load a schema file (JSON or a
  module of field definitions) without components. `serializeSchema` already strips the
  components for the admin.
- **A public read API.** For example `GET /api/v1/:collection` and
  `GET /api/v1/:collection/:slug`, with the same cache headers as `loadForRoute`, and API keys
  or CORS rules for other origins.
- **Preview across origins.** The preview frame and the editor are same-origin today
  (`postMessage` targets `window.location.origin`). A site on another origin needs an allowed
  list of preview origins on both sides, and a preview token instead of the session cookie.
- **Configurable paths.** `/admin` and `/admin/api` are fixed in the admin client
  (`src/client/api.ts`) and in the server redirects.
- **Storage.** The local adapter needs a volume. An S3-compatible adapter behind
  `StorageAdapter` allows more than one replica, with a shared cache and rate limit.
- **Image.** A multi-stage Dockerfile, `CMD` that runs `genga-migrate` and then the server, a
  volume for `GENGA_MEDIA_DIR`, and a health check.

Keep the library free of server-only code paths: the Docker app imports `genga` like any
consumer does.
