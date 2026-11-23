import { MediaPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/media';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).admin.media(request);
}

export default MediaPage;
