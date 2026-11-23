import { DashboardPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/dashboard';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.dashboard(request);
}

export default DashboardPage;
