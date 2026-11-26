import { handleOrNotFound } from '../.server/genga';
import type { Route } from './+types/well-known';

export const loader = ({ request }: Route.LoaderArgs) => handleOrNotFound(request);
