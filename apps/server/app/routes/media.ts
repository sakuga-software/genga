import { getServer } from '../.server/genga';
import type { Route } from './+types/media';

export async function loader({ params }: Route.LoaderArgs) {
  return (await getServer()).genga.media.serve(params['*'] ?? '');
}
