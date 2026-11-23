import { DashboardPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/dashboard';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.dashboard(request);
}

export default DashboardPage;
