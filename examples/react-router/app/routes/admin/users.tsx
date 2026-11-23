import { UsersPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/users';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.users(request);
}

export default UsersPage;
