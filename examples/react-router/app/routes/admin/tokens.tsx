import { TokensPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/tokens';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.tokens(request);
}

export default TokensPage;
