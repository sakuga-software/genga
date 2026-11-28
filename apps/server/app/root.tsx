import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { getServer } from './.server/genga';
import type { Route } from './+types/root';

/**
 * `genga.handle` answers before the routes: the admin app and its API, the media files, the
 * public API and the MCP endpoint, whose path is a setting (GENGA_MCP_PATH).
 */
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request }, next) => (await (await getServer()).genga.handle(request)) ?? next(),
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <main style={{ padding: '4rem 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>{status === 404 ? 'Introuvable' : 'Erreur'}</h1>
    </main>
  );
}
