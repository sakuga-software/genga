import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

// The admin path is read at start (GENGA_ADMIN_PATH), so the admin routes match any
// first segment, and their loaders answer 404 for a segment that is not the admin path.
export default [
  index('routes/home.ts'),
  route('healthz', 'routes/healthz.ts'),
  route('readyz', 'routes/readyz.ts'),
  route('api/v1/*', 'routes/api-v1.ts'),
  route('media/*', 'routes/media.ts'),
  route(':admin/api/*', 'routes/admin/api.ts'),
  route(':admin', 'routes/admin/shell.tsx', [
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
] satisfies RouteConfig;
