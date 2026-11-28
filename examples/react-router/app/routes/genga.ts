import { getGenga } from '../.server/genga';
import type { Route } from './+types/genga';

const CMS_OFF = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

/** Every Genga path: the admin app, the admin API, the media files, MCP and its OAuth metadata. */
async function handle({ request }: Route.LoaderArgs | Route.ActionArgs) {
  const genga = getGenga();
  if (!genga) return new Response('The CMS is off: DATABASE_URL is not set.', { status: 503, headers: CMS_OFF });
  return (await genga.handle(request)) ?? new Response('Not found', { status: 404 });
}

export const loader = handle;
export const action = handle;
