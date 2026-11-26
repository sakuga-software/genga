# Genga example: Next.js 16 (remote mode)

A site on the App Router that reads a Genga server: two collections (`pages` at `/:slug`,
`posts` at `/blog/:slug`) and four blocks. `hero` and `quote` are Client Components, so they
follow each keystroke in the preview; `rich-text` and `image` are Server Components, refreshed
after each autosave.

```sh
pnpm build
# The Genga server (apps/server), with the config of this site:
GENGA_CONFIG=$PWD/examples/next/genga.config.mjs GENGA_SITE_URL=http://localhost:3100 \
GENGA_PREVIEW_ORIGINS=http://localhost:3100 GENGA_SECRET="$(openssl rand -base64 48)" \
GENGA_WEBHOOKS='[{"url":"http://localhost:3100/api/genga/webhook","secret":"whsec_…"}]' \
GENGA_MEDIA_DIR=/tmp/genga-media DATABASE_URL=postgres://genga:genga@localhost:54329/genga \
  node apps/server/server.mjs
# The site, with the same webhook secret:
GENGA_URL=http://localhost:3000 GENGA_WEBHOOK_SECRET=whsec_… pnpm --filter genga-example-next start
```

| File                       | Role                                                      |
| -------------------------- | --------------------------------------------------------- |
| `genga.config.mjs`         | collections and blocks, for the site and the server       |
| `lib/genga.ts`             | the remote source, with the cache of Next.js              |
| `blocks/*`                 | the components of the blocks                              |
| `app/blog/[slug]/page.tsx` | a post, static, with the preview                          |
| `app/api/genga/*`          | the preview entry route and the webhook receiver          |
| `e2e/*`                    | Playwright tests against a Genga server (`pnpm test:e2e`) |
