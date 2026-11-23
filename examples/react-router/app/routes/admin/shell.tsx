import { AdminErrorPage } from 'genga/admin';
import adminCss from 'genga/admin.css?url';
import { Outlet } from 'react-router';
import { requireGenga } from '../../.server/genga';

export const links = () => [{ rel: 'stylesheet', href: adminCss }];

export const meta = () => [{ title: 'Genga' }, { name: 'robots', content: 'noindex, nofollow' }];

export function headers() {
  return {
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "frame-ancestors 'self'",
    'Cache-Control': 'private, no-store',
  };
}

export async function loader() {
  await requireGenga();
  return null;
}

export default function AdminShellRoute() {
  return <Outlet />;
}

export function ErrorBoundary() {
  return <AdminErrorPage />;
}
