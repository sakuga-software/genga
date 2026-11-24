import type { Genga } from 'genga/server';
import type { Settings } from './settings';

/**
 * Answers a request to the MCP path, or returns null for any other path, so that the
 * router handles it. The root middleware calls it before any route.
 */
export async function handleMcpRequest(
  request: Request,
  server: { genga: Genga; settings: Pick<Settings, 'mcp'> },
): Promise<Response | null> {
  const { mcp } = server.settings;
  if (!mcp.enabled) return null;
  const { pathname } = new URL(request.url);
  if (pathname.replace(/\/+$/, '').toLowerCase() !== mcp.path.toLowerCase()) return null;
  try {
    await server.genga.ready();
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'The CMS cannot reach its database.' },
        id: null,
      }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }
  return server.genga.mcp(request);
}
