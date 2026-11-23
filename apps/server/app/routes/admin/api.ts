import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/api';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).api(request, params['*'] ?? '');
}

export async function action({ request, params }: Route.ActionArgs) {
  return (await requireAdmin(params)).api(request, params['*'] ?? '');
}
