import { SetupPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/setup';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.setupLoader(request);
}

export async function action({ request, params }: Route.ActionArgs) {
  return (await requireAdmin(params)).admin.setupAction(request);
}

export default SetupPage;
