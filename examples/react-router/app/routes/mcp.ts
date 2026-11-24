import { requireGenga } from '../.server/genga';
import type { Route } from './+types/mcp';

export async function loader({ request }: Route.LoaderArgs) {
  return (await requireGenga()).mcp(request);
}

export async function action({ request }: Route.ActionArgs) {
  return (await requireGenga()).mcp(request);
}
