import { tolerantRead } from '../fields/schema';
import { populate } from '../populate';
import type { PublicUser } from '../types';
import type { GengaApiTokens } from './api-tokens';
import type { GengaAuth, SessionUser } from './auth';
import type { GengaAdminViews } from './admin';
import { AUTH_FORM_BYTES, readForm, readJson, UPLOAD_OVERHEAD_BYTES } from './body';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { badRequest, GengaError, notFound } from './errors';
import { loadMediaMap, type GengaMedia } from './media';
import { isAllowedOrigin } from './origin';
import type { GengaOAuth } from './oauth';
import { loadRelationResolver, relationOptions } from './relations';
import type { GengaUsers } from './users';

export const ADMIN_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Cache-Control': 'private, no-store',
} as const;

export function json(body: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) result.set(name, value);
  result.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: result });
}

export function errorResponse(error: unknown, log: GengaContext['log']) {
  if (error instanceof GengaError) {
    return json({ error: error.code, message: error.message, details: error.details ?? null }, error.status);
  }
  log.error('[genga] Unexpected error:', error);
  return json({ error: 'internal', message: 'Erreur interne. Réessayez.' }, 500);
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest('draftRev manquant.');
  return value;
}

type Services = {
  ctx: GengaContext;
  auth: GengaAuth;
  documents: GengaDocuments;
  media: GengaMedia;
  users: GengaUsers;
  tokens: GengaApiTokens;
  oauth: GengaOAuth | null;
  views: GengaAdminViews;
};

/**
 * Handles `<adminPath>/api/*`. Every write passes the origin check. Every route needs a session,
 * except the sign-in routes `session` and `setup`.
 */
export function createApi({ ctx, auth, documents, media, users, tokens, oauth, views }: Services) {
  /** The routes of the login and setup forms, before the session check. Null for any other route. */
  async function signInRoute(request: Request, segments: string[]): Promise<Response | null> {
    const method = request.method.toUpperCase();
    const [resource, sub] = segments;
    if (sub !== undefined) return null;
    const url = new URL(request.url);
    if (resource === 'session' && method === 'GET') {
      return json(await views.login(request, url.searchParams.get('next')));
    }
    if (resource === 'session' && method === 'POST') {
      const body = await readJson(request, AUTH_FORM_BYTES);
      const { cookie, location } = await views.signIn(request, body as Parameters<typeof views.signIn>[1]);
      return json({ location }, 200, { 'Set-Cookie': cookie });
    }
    if (resource === 'setup' && method === 'GET') return json(await views.setup(url.searchParams.get('token') ?? ''));
    if (resource === 'setup' && method === 'POST') {
      const body = await readJson(request, AUTH_FORM_BYTES);
      const { cookie, location } = await views.acceptSetup(request, body as Parameters<typeof views.acceptSetup>[1]);
      return json({ location }, 200, { 'Set-Cookie': cookie });
    }
    return null;
  }

  /** The data of one admin screen, in the shape of its `*PageData` type. */
  async function viewRoute(request: Request, user: SessionUser, name: string, id: string | undefined) {
    const params = new URL(request.url).searchParams;
    if (name === 'layout' && !id) return json(views.layout(user));
    if (name === 'dashboard' && !id) return json(await views.dashboard(user));
    if (name === 'collection' && id) return json(await views.collection(user, id, params));
    if (name === 'document' && id) return json(await views.document(user, id));
    if (name === 'media' && !id) return json(await views.media(user));
    if (name === 'users' && !id) return json(await views.users(user));
    if (name === 'tokens' && !id) return json(await views.tokens(user));
    throw notFound('Route API inconnue.');
  }

  /**
   * The consent screen of an MCP client, for the admin app. It is not under `api/oauth`: that path
   * answers without the session and the origin check. The query string is the authorization request.
   */
  async function consentRoute(request: Request, user: PublicUser): Promise<Response> {
    if (!views.hasOAuth) throw notFound('Introuvable.');
    const query = new URL(request.url).search.slice(1);
    const method = request.method.toUpperCase();
    if (method === 'GET') return json(await views.consent(user, query));
    if (method === 'POST') {
      const body = await readJson(request, AUTH_FORM_BYTES);
      const scopes = Array.isArray(body.scopes) ? body.scopes : [];
      return json(await views.decide(user, query, { decision: body.decision, scopes }));
    }
    throw notFound('Route API inconnue.');
  }

  async function route(request: Request, user: SessionUser, segments: string[]): Promise<Response> {
    const method = request.method.toUpperCase();
    const [resource, id, sub] = segments;

    if (resource === 'views' && method === 'GET' && segments.length <= 3)
      return viewRoute(request, user, id ?? '', sub);
    if (resource === 'consent' && !id) return consentRoute(request, user);

    if (resource === 'documents') {
      if (!id && method === 'GET') {
        const url = new URL(request.url);
        const collection = url.searchParams.get('collection') ?? '';
        return json({ documents: await documents.list(user, collection, { search: url.searchParams.get('q') ?? '' }) });
      }
      if (!id && method === 'POST') {
        const body = await readJson(request);
        return json(
          await documents.create(user, String(body.collection ?? ''), (body.data as Record<string, unknown>) ?? {}),
          201,
        );
      }
      if (id && !sub && method === 'GET') return json({ document: await documents.get(user, id) });
      if (id && !sub && method === 'DELETE') {
        await documents.remove(user, id);
        return json({ ok: true });
      }
      if (id && sub === 'draft' && method === 'PUT') {
        const body = await readJson(request);
        return json(await documents.saveDraft(user, id, body.data, revision(body.draftRev)));
      }
      if (id && sub === 'publish' && method === 'POST') {
        const body = await readJson(request);
        return json(await documents.publish(user, id, revision(body.draftRev)));
      }
      if (id && sub === 'unpublish' && method === 'POST') return json(await documents.unpublish(user, id));
      if (id && sub === 'schedule' && method === 'PUT') {
        const body = await readJson(request);
        return json(await documents.schedule(user, id, { publishAt: body.publishAt, unpublishAt: body.unpublishAt }));
      }
      if (id && sub === 'preview' && method === 'GET') {
        const doc = await documents.get(user, id);
        return json({ preview: doc.preview });
      }
      if (id && sub === 'versions' && method === 'GET') return json({ versions: await documents.versions(user, id) });
      if (id && sub === 'versions' && method === 'POST') {
        const body = await readJson(request);
        return json(await documents.saveVersion(user, id, body.note), 201);
      }
      if (id && sub === 'restore' && method === 'POST') {
        const body = await readJson(request);
        const restored = await documents.restore(user, id, String(body.versionId ?? ''), revision(body.draftRev));
        const doc = await documents.get(user, id);
        return json({ ...restored, media: doc.media, related: doc.related });
      }
    }

    if (resource === 'preview' && method === 'POST') {
      const body = await readJson(request);
      const collection = documents.collectionOf(String(body.collection ?? ''));
      const data = tolerantRead(collection.fields, body.data, ctx.blocks);
      const [mediaMap, resolve] = await Promise.all([
        loadMediaMap(ctx, collection.fields, data),
        loadRelationResolver(ctx, collection.fields, data),
      ]);
      return json({ data: populate(collection.fields, data, ctx.blocks, mediaMap, resolve) });
    }

    if (resource === 'relations' && !id && method === 'GET') {
      const url = new URL(request.url);
      const ids = url.searchParams.get('ids');
      return json({
        options: await relationOptions(ctx, user, url.searchParams.get('collection') ?? '', {
          search: url.searchParams.get('q') ?? '',
          ids: ids === null ? undefined : ids.split(',').slice(0, 200),
        }),
      });
    }

    if (resource === 'media') {
      if (!id && method === 'GET') {
        const url = new URL(request.url);
        return json({ media: await media.list(user, { search: url.searchParams.get('q') ?? '' }) });
      }
      if (!id && method === 'POST') {
        const form = await readForm(request, ctx.maxUploadBytes + UPLOAD_OVERHEAD_BYTES);
        const file = form.get('file');
        if (!(file instanceof File)) throw badRequest('Aucun fichier reçu.');
        const result = await media.upload(user, file, String(form.get('alt') ?? ''));
        return json(result, result.deduplicated ? 200 : 201);
      }
      if (id && method === 'PATCH') {
        const body = await readJson(request);
        return json({ media: await media.updateAlt(user, id, body.alt) });
      }
      if (id && method === 'DELETE') {
        await media.remove(user, id);
        return json({ ok: true });
      }
    }

    if (resource === 'users') {
      if (!id && method === 'GET') return json({ users: await users.list(user) });
      if (!id && method === 'POST') return json(await users.invite(user, await readJson(request)), 201);
      if (id && !sub && method === 'PATCH')
        return json({ user: await users.update(user, id, await readJson(request)) });
      if (id && sub === 'reset' && method === 'POST') return json(await users.resetLink(user, id));
    }

    // Only a session reaches this API: a bearer token cannot create or revoke tokens.
    if (resource === 'tokens') {
      if (!id && method === 'GET') {
        const all = new URL(request.url).searchParams.get('all') === '1';
        return json({ tokens: await tokens.list(user, { all }) });
      }
      if (!id && method === 'POST') return json(await tokens.create(user, await readJson(request)), 201);
      if (id && method === 'DELETE') {
        await tokens.revoke(user, id);
        return json({ ok: true });
      }
    }

    if (resource === 'grants' && oauth) {
      if (!id && method === 'GET') {
        const all = new URL(request.url).searchParams.get('all') === '1';
        return json({ grants: await oauth.listGrants(user, { all }) });
      }
      if (id && method === 'DELETE') {
        await oauth.revokeGrant(user, id);
        return json({ ok: true });
      }
    }

    throw notFound('Route API inconnue.');
  }

  return async function handle(request: Request, path: string): Promise<Response> {
    try {
      if (!isAllowedOrigin(request, ctx.allowedOrigins)) {
        return json({ error: 'bad_origin', message: 'Origine refusée.' }, 403);
      }
      const segments = path.split('/').filter(Boolean);
      if (segments[0] === 'logout' && request.method === 'POST') {
        const cookie = await auth.logout(request);
        return new Response(null, {
          status: 303,
          headers: { Location: `${ctx.adminPath}/login`, 'Set-Cookie': cookie, ...ADMIN_HEADERS },
        });
      }
      const signIn = await signInRoute(request, segments);
      if (signIn) return signIn;
      const user = await auth.getUser(request);
      if (!user) return json({ error: 'unauthorized', message: 'Session expirée. Reconnectez-vous.' }, 401);
      return await route(request, user, segments);
    } catch (error) {
      return errorResponse(error, ctx.log);
    }
  };
}
