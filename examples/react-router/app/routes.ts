import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

// Use the same path as the `adminPath` of Genga (GENGA_ADMIN_PATH at build time and at start).
const adminPath = process.env.GENGA_ADMIN_PATH || '/admin';

export default [
  // One resource route for each Genga path. `genga.handle` serves the admin app, its API, the media and MCP.
  route(`${adminPath}/*`, 'routes/genga.ts', { id: 'genga-admin' }),
  route('/media/*', 'routes/genga.ts', { id: 'genga-media' }),
  route('/mcp', 'routes/genga.ts', { id: 'genga-mcp' }),
  route('/.well-known/*', 'routes/genga.ts', { id: 'genga-well-known' }),

  layout('routes/site-layout.tsx', [
    index('routes/home.tsx'),
    route('/blog/:slug', 'routes/post.tsx'),
    route('/:slug', 'routes/page.tsx'),
  ]),
] satisfies RouteConfig;
