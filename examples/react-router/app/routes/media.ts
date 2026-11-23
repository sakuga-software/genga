import { getGenga } from '../.server/genga';
import type { Route } from './+types/media';

export async function loader({ params }: Route.LoaderArgs) {
  const genga = getGenga();
  if (!genga) return new Response('Not found', { status: 404 });
  return genga.media.serve(params['*'] ?? '');
}
