import { type RouteConfig, index, route } from '@react-router/dev/routes';

// `genga.handle` answers in the root middleware: the admin app, its API, the media, the public
// API, MCP and its OAuth metadata. The admin path is a setting (GENGA_ADMIN_PATH), so the last
// route matches any other path and gives React Router a match.
export default [
  index('routes/home.ts'),
  route('healthz', 'routes/healthz.ts'),
  route('readyz', 'routes/readyz.ts'),
  route('api/v1/*', 'routes/api-v1.ts'),
  route('media/*', 'routes/media.ts'),
  route('.well-known/*', 'routes/well-known.ts'),
  route('*', 'routes/genga.ts'),
] satisfies RouteConfig;
