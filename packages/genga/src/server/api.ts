import { tolerantRead } from '../fields/schema';
import { populate } from '../populate';
import type { PublicUser } from '../types';
import type { GengaApiTokens } from './api-tokens';
import type { GengaAuth } from './auth';
import { readForm, readJson, UPLOAD_OVERHEAD_BYTES } from './body';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { badRequest, GengaError, notFound } from './errors';
import { loadMediaMap, type GengaMedia } from './media';
import { isAllowedOrigin } from './origin';
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
};

/** Handles `<adminPath>/api/*`. Every request needs a session; every write passes the origin check. */
export function createApi({ ctx, auth, documents, media, users, tokens }: Services) {
  async function route(request: Request, user: PublicUser, segments: string[]): Promise<Response> {
    const method = request.method.toUpperCase();
    const [resource, id, sub] = segments;

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
      const user = await auth.getUser(request);
      if (!user) return json({ error: 'unauthorized', message: 'Session expirée. Reconnectez-vous.' }, 401);
      return await route(request, user, segments);
    } catch (error) {
      return errorResponse(error, ctx.log);
    }
  };
}
