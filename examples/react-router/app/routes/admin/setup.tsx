import { SetupPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/setup';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.setupLoader(request);
}

export async function action({ request }: Route.ActionArgs) {
  return (await requireGenga()).admin.setupAction(request);
}

export default SetupPage;
