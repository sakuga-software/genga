# genga

A content system that lives inside your React Router app: admin, roles, versions, media
library and a live editor of your own React blocks, on Postgres.

```sh
npm install genga react react-dom react-router
```

| Entry             | Content                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `genga`           | field builders, `defineConfig`, `defineBlock`, access, schemas        |
| `genga/server`    | `createGenga()`: database, auth, documents, media, API, admin loaders |
| `genga/admin`     | admin route components                                                |
| `genga/admin.css` | compiled admin stylesheet (no Tailwind setup needed)                  |
| `genga/render`    | `RenderBlocks`, `RichText`, `usePreviewData`                          |
| `genga/client`    | the renderers and the preview bridge, plus `apiRequest`               |

`genga-migrate` applies the database migrations (`DATABASE_URL` must be set).

Documentation, example app and changelog: <https://github.com/sakuga-software/genga>.

License: MIT © Sakuga Software
