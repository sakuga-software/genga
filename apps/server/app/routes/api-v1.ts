import { getServer } from '../.server/genga';
import type { Route } from './+types/api-v1';

export async function loader({ request }: Route.LoaderArgs) {
  return (await getServer()).publicApi(request);
}

export async function action({ request }: Route.ActionArgs) {
  return (await getServer()).publicApi(request);
}
