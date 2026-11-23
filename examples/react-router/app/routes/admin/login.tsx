import { LoginPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/login';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.loginLoader(request);
}

export async function action({ request }: Route.ActionArgs) {
  return (await requireGenga()).admin.loginAction(request);
}

export default LoginPage;
