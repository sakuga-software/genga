import { CollectionPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/collection';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.collection(request, params.collection);
}

export default CollectionPage;
