import { LoginPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/login';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.loginLoader(request);
}

export async function action({ request, params }: Route.ActionArgs) {
  return (await requireAdmin(params)).admin.loginAction(request);
}

export default LoginPage;
