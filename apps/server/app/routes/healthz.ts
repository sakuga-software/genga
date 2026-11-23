import { getServer } from '../.server/genga';

const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

/** Liveness: the process answers and the database answers a ping. */
export async function loader() {
  const { genga } = await getServer();
  try {
    await genga.sql`SELECT 1`;
    return new Response(JSON.stringify({ status: 'ok' }), { headers });
  } catch {
    return new Response(JSON.stringify({ status: 'error', database: 'unreachable' }), { status: 503, headers });
  }
}
