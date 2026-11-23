import { AdminAppLayout } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/app';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.layout(request);
}

export default AdminAppLayout;
