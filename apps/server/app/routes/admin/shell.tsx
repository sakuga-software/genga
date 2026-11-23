import { AdminErrorPage } from 'genga/admin';
import adminCss from 'genga/admin.css?url';
import { Outlet } from 'react-router';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/shell';

export const links = () => [{ rel: 'stylesheet', href: adminCss }];

export const meta = () => [{ title: 'Genga' }];

export function headers() {
  return {
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "frame-ancestors 'self'",
    'Cache-Control': 'private, no-store',
  };
}

export async function loader({ params }: Route.LoaderArgs) {
  await requireAdmin(params);
  return null;
}

export default function AdminShellRoute() {
  return <Outlet />;
}

export function ErrorBoundary() {
  return <AdminErrorPage />;
}
