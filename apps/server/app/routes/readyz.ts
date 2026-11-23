import { getServer } from '../.server/genga';

const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

/** Readiness: the config loaded, the migrations ran and the database answers. */
export async function loader() {
  const { genga } = await getServer();
  try {
    await genga.ready();
    await genga.sql`SELECT 1`;
    return new Response(JSON.stringify({ status: 'ready' }), { headers });
  } catch {
    return new Response(JSON.stringify({ status: 'not_ready' }), { status: 503, headers });
  }
}
