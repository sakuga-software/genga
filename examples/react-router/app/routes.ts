import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
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

  layout('routes/site-layout.tsx', [
    index('routes/home.tsx'),
    route('/blog/:slug', 'routes/post.tsx'),
    route('/:slug', 'routes/page.tsx'),
  ]),
] satisfies RouteConfig;
