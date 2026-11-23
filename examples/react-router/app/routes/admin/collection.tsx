import { CollectionPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/collection';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireGenga()).admin.collection(request, params.collection);
}

export default CollectionPage;
