import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation } from 'react-router';
import type { Route } from './+types/root';

function isAdminPath(pathname: string) {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export function Layout({ children }: { children: React.ReactNode }) {
  const isAdmin = isAdminPath(useLocation().pathname);
  return (
    // The admin stylesheet applies its theme under `html[data-genga-admin]`.
    <html
      lang="en"
      className={isAdmin ? 'dark' : undefined}
      data-theme={isAdmin ? 'dark' : undefined}
      data-genga-admin={isAdmin ? '' : undefined}
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
      <h1>{status === 404 ? 'Page not found' : 'Something went wrong'}</h1>
      <p>
        <a href="/">Back to the home page</a>
      </p>
    </main>
  );
}
