import { MediaPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/media';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.media(request);
}

export default MediaPage;
