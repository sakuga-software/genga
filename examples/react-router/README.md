# Genga example: React Router v8

A minimal site with two collections (`pages` at `/:slug`, `posts` at `/blog/:slug`) and four
blocks (hero, text, image, quote). It has no Tailwind: the admin uses the compiled
`genga/admin.css`.

```sh
pnpm --filter genga build
DATABASE_URL=postgres://genga:genga@localhost:54329/genga pnpm --filter genga-example-react-router dev
```

At the first start, the server logs a one-time URL `/admin/setup?token=…` that creates the
first admin. Without `DATABASE_URL`, the site runs with the CMS off. `.env.example` lists the
variables; export them in your shell, because the server does not read `.env` files.

| File                              | Role                                                |
| --------------------------------- | --------------------------------------------------- |
| `app/genga.config.ts`             | collections and blocks                              |
| `app/blocks/*`                    | the React components that editors place on pages    |
| `app/.server/genga.ts`            | one Genga instance per process, and a loader helper |
| `app/routes/admin/*`              | the admin route modules                             |
| `app/routes/page.tsx`, `post.tsx` | public routes with live preview                     |
| `app/root.tsx`                    | sets `data-genga-admin` on `<html>` for admin paths |
