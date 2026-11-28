# Move to the prebuilt admin

The release after Genga 0.3 ships the admin as a prebuilt single-page app: `genga.handle` serves it under
`adminPath`. The admin route modules of 0.3 still work, so you can move when you want. This guide
is for a React Router app that mounts those route modules.

## What still works

Nothing breaks when you update `genga`:

- The route components of `genga/admin` and the `genga.admin.*` loaders and actions still work. At
  the first call, Genga logs one warning per process: `genga.admin is deprecated and leaves at 1.0`.
- The route module of `<adminPath>/api/*` that calls `genga.handle` stays as it is.
- If your app calls `genga.handle` for every request (in a middleware), set `adminApp: false` in
  `createGenga` until you move: `genga.handle` then leaves the admin pages to your route modules.
- `genga/admin.css` is still in the package, for the route modules.
- The same-origin preview with the admin session does not change.

A test of the package runs the old route modules in React Router next to the admin API, on one
database (`packages/genga/test/legacy-routes.test.ts`).

## Steps

1. **Replace the admin routes with one route.** Remove the admin route modules: `shell.tsx`,
   `login.tsx`, `setup.tsx`, `app.tsx`, `dashboard.tsx`, `collection.tsx`, `document.tsx`,
   `media.tsx`, `users.tsx`, `tokens.tsx`, `oauth-authorize.tsx` and `api.ts`. Add one route for
   every path under the admin path:

   ```ts
   // app/routes.ts
   route('/admin/*', 'routes/genga.ts', { id: 'genga-admin' }),
   route('/media/*', 'routes/genga.ts', { id: 'genga-media' }),
   ```

   ```ts
   // app/routes/genga.ts
   import { genga } from '../.server/genga';
   import type { Route } from './+types/genga';

   export const loader = async ({ request }: Route.LoaderArgs) =>
     (await genga.handle(request)) ?? new Response('Not found', { status: 404 });
   export const action = loader;
   ```

   With a custom `adminPath`, for example `/cms`, use `route('/cms/*', …)`. With the `mcp` option,
   route `/mcp` and `/.well-known/*` to the same module.

2. **Remove the admin code of the root layout.** The admin page is no longer a page of your app:
   remove `data-genga-admin`, `className="dark"` and `data-theme` from `<html>` for the admin
   paths, and the link to `genga/admin.css`.

3. **Check your CSP.** `genga.handle` sets a Content Security Policy on the admin pages. If your
   app adds its own CSP to every response, exclude the admin path from it. The admin pages need no
   inline script and no inline style.

4. **Remove the theme overrides of `genga/admin.css`.** The admin app ships its own stylesheet.
   An override of the `--genga-*` variables in your app no longer reaches the admin.

5. **Remove `react-router` imports for Genga.** `genga/server` no longer imports `react-router`.
   If your app used the `data()` errors of `genga.admin.*` in its own code, read the plain
   `Response` that Genga now throws: a 302 with `Location`, or a JSON body `{ message }` with a status.

The OAuth consent page (`<adminPath>/oauth/authorize`) and the setup and invitation links are
pages of the admin app: no route of their own.

## What changes for the people who use the admin

Nothing: the pages, the URLs and the session cookie (`__Host-genga`, `SameSite=Lax`, `Path=/`)
stay the same. A person who is signed in stays signed in after the update.

## At 1.0

`genga/admin`, `genga/admin.css`, `genga.admin.*` and the `react-router` peer dependency of
`genga` leave. `react-router` is already an optional peer: only `genga/admin` needs it.
