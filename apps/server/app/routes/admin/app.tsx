import { AdminAppLayout } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/app';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.layout(request);
}

export default AdminAppLayout;
