import { isUnderPath } from '../paths';
import { json } from './api';
import { markPeerHop } from './auth';
import type { GengaContext } from './context';
import { PUBLIC_API_PATH } from './public-api';

export type HandleContext = {
  /**
   * The TCP peer, when the framework gives it. The core appends it to `X-Forwarded-For`
   * and counts it as one more proxy hop, so `trustedProxies` still picks the client.
   */
  peerAddress?: string;
};

export type GengaHandler = (request: Request, context?: HandleContext) => Promise<Response | null>;

type Routes = {
  ctx: GengaContext;
  ready: () => Promise<void>;
  adminApi: (request: Request, path: string) => Promise<Response>;
  media: (key: string) => Promise<Response>;
  publicApi: ((request: Request) => Promise<Response>) | null;
  mcp: { path: string; handle: (request: Request) => Promise<Response> } | null;
};

type Route = 'admin-api' | 'media' | 'public-api' | 'mcp';

/** Throws at start when two Genga paths overlap, because one of them would never answer. */
export function checkPathCollisions(paths: Record<string, string | null>) {
  const entries = Object.entries(paths).filter((entry): entry is [string, string] => entry[1] !== null);
  for (const [index, [name, path]] of entries.entries()) {
    for (const [otherName, other] of entries.slice(index + 1)) {
      const lower = path.toLowerCase();
      const otherLower = other.toLowerCase();
      if (isUnderPath(lower, otherLower) || isUnderPath(otherLower, lower)) {
        throw new Error(`Genga: the ${name} ${path} and the ${otherName} ${other} overlap. Change one of them.`);
      }
    }
  }
}

function withPeer(request: Request, peerAddress: string): Request {
  const headers = new Headers(request.headers);
  const forwarded = headers.get('x-forwarded-for');
  headers.set('x-forwarded-for', forwarded ? `${forwarded}, ${peerAddress}` : peerAddress);
  return markPeerHop(new Request(request, { headers }));
}

function unavailable(route: Route): Response {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
  if (route === 'admin-api') {
    return json({ error: 'unavailable', message: 'Le CMS ne joint pas sa base de données.' }, 503);
  }
  if (route === 'mcp') {
    const body = { jsonrpc: '2.0', error: { code: -32000, message: 'The CMS cannot reach its database.' }, id: null };
    return new Response(JSON.stringify(body), { status: 503, headers });
  }
  if (route === 'public-api') {
    const body = { error: 'unavailable', message: 'The CMS cannot reach its database.' };
    return new Response(JSON.stringify(body), { status: 503, headers });
  }
  return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The one Fetch handler of Genga. It answers the admin API, the media files, the public API
 * and the MCP endpoint, and returns null for every other path. The admin pages stay with the
 * route modules of the app until the admin is a single-page app.
 */
export function createHandler(routes: Routes): GengaHandler {
  const { ctx } = routes;
  const adminApiPath = `${ctx.adminPath}/api`;

  function match(pathname: string): Route | null {
    if (isUnderPath(pathname, adminApiPath)) return 'admin-api';
    if (pathname.startsWith(`${ctx.mediaPath}/`)) return 'media';
    if (routes.publicApi && isUnderPath(pathname, PUBLIC_API_PATH)) return 'public-api';
    if (routes.mcp && pathname.replace(/\/+$/, '').toLowerCase() === routes.mcp.path.toLowerCase()) return 'mcp';
    return null;
  }

  return async function handle(request, context = {}) {
    const { pathname } = new URL(request.url);
    const route = match(pathname);
    if (!route) return null;
    const forwarded = context.peerAddress ? withPeer(request, context.peerAddress) : request;
    try {
      await routes.ready();
    } catch {
      return unavailable(route);
    }
    switch (route) {
      case 'admin-api':
        return routes.adminApi(forwarded, pathname.slice(adminApiPath.length));
      case 'media': {
        if (forwarded.method !== 'GET' && forwarded.method !== 'HEAD') {
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        let key: string;
        try {
          key = decodeURIComponent(pathname.slice(ctx.mediaPath.length + 1));
        } catch {
          return new Response('Not found', { status: 404 });
        }
        const response = await routes.media(key);
        if (forwarded.method !== 'HEAD') return response;
        await response.body?.cancel();
        return new Response(null, response);
      }
      case 'public-api':
        return (routes.publicApi as NonNullable<Routes['publicApi']>)(forwarded);
      case 'mcp':
        return (routes.mcp as NonNullable<Routes['mcp']>).handle(forwarded);
    }
  };
}
