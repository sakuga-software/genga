import { handleOrNotFound } from '../.server/genga';
import type { Route } from './+types/media';

export const loader = ({ request }: Route.LoaderArgs) => handleOrNotFound(request);
