import { TokensPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/tokens';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.tokens(request);
}

export default TokensPage;
