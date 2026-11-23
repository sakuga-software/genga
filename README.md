# Genga

Genga (原画, the key drawings of an animation) is a content system that lives inside your
React Router app. It adds an admin, roles, versions, a media library and a live editor of
your own React components, on Postgres.

- **Your components are the blocks.** A page is a list of blocks. A block is a React
  component of your site with a field schema.
- **Live preview.** The editor shows the real site route in a frame and updates it at each
  keystroke, without a reload.
- **SSR first.** The site renders published content on the server. Drafts render only for
  signed-in users.
- **Accessible admin.** WCAG 2.2 AA: keyboard first, visible focus, labels, live regions.
  Built on open-source HeroUI v3, React Aria Components and TipTap.
- **Safe by default.** Origin checks on every write, hashed session tokens, login limits,
  sanitized rich text, sniffed and sandboxed media.

> Status: 0.1, early. The admin UI is in French for now.

## Quick start

```sh
pnpm add genga
```

1. Define the collections and the blocks with `defineConfig` and `defineBlock`.
2. Create one server instance with `createGenga(config, { databaseUrl, siteUrl })`.
3. Mount the admin route modules under `/admin`, the API under `/admin/api/*` and the media
   route under `/media/*`.
4. In your page routes, load content with `genga.published.loadForRoute()` and render it
   with `usePreviewData()` and `<RenderBlocks>`.

The [example app](./examples/react-router) does all four in a few files. Read
[configuration](./docs/configuration.md) for the details.

## Run the example

```sh
docker run -d --name genga-postgres -p 54329:5432 \
  -e POSTGRES_USER=genga -e POSTGRES_PASSWORD=genga -e POSTGRES_DB=genga postgres:18
pnpm install
pnpm build
DATABASE_URL=postgres://genga:genga@localhost:54329/genga pnpm dev
```

The server logs a one-time URL `/admin/setup?token=…` that creates the first admin.

## Repository

| Path                                               | Content                                                       |
| -------------------------------------------------- | ------------------------------------------------------------- |
| [`packages/genga`](./packages/genga)               | the `genga` npm package                                       |
| [`examples/react-router`](./examples/react-router) | a minimal React Router v7 site that uses Genga                |
| `apps/`                                            | reserved for the headless server (Docker image), planned      |
| [`docs`](./docs)                                   | architecture, configuration, blocks, preview bridge, security |

## Documentation

- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Blocks](./docs/blocks.md)
- [Preview bridge](./docs/preview-bridge.md)
- [Security model](./docs/security.md)
- [Headless server (planned)](./docs/headless-server.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities as described in
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Sakuga Software
