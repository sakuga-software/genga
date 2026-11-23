import { UsersPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/users';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.users(request);
}

export default UsersPage;
