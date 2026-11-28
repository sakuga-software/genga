import { handleOrNotFound } from '../.server/genga';
import type { Route } from './+types/genga';

export const loader = ({ request }: Route.LoaderArgs) => handleOrNotFound(request);
export const action = ({ request }: Route.ActionArgs) => handleOrNotFound(request);
