# Genga example: React Router v8

A minimal site with two collections (`pages` at `/:slug`, `posts` at `/blog/:slug`) and four
blocks (hero, text, image, quote). It has no Tailwind: the admin is the prebuilt app of the
`genga` package, served by `genga.handle`.

```sh
pnpm --filter genga build
DATABASE_URL=postgres://genga:genga@localhost:54329/genga pnpm --filter genga-example-react-router dev
```

At the first start, the server logs a one-time URL `/admin/setup?token=…` that creates the
first admin. Without `DATABASE_URL`, the site runs with the CMS off. `.env.example` lists the
variables; export them in your shell, because the server does not read `.env` files.

| File                               | Role                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `app/genga.config.ts`              | collections and blocks                                      |
| `app/blocks/*`                     | the React components that editors place on pages            |
| `app/.server/genga.ts`             | one Genga instance per process, and a loader helper         |
| `app/routes.ts`, `routes/genga.ts` | one route per Genga path: admin, media, MCP, OAuth metadata |
| `app/routes/page.tsx`, `post.tsx`  | public routes with live preview                             |
| `e2e/`                             | Playwright tests of the admin (`pnpm test:e2e:admin`)       |
