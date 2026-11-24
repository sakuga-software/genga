import { data, redirect } from 'react-router';
import { can } from '../access';
import { serializeSchema } from '../config';
import type {
  AppLayoutData,
  CollectionNav,
  CollectionPageData,
  DashboardData,
  DocumentPageData,
  DocumentStatus,
  FormResult,
  LoginPageData,
  MediaPageData,
  SetupPageData,
  TokensPageData,
  UsersPageData,
} from '../types';
import type { GengaApiTokens } from './api-tokens';
import { ADMIN_HEADERS } from './api';
import type { GengaAuth, SessionUser } from './auth';
import { AUTH_FORM_BYTES, readForm } from './body';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { GengaError } from './errors';
import type { GengaMedia } from './media';
import { isUnderPath } from '../paths';
import { isAllowedOrigin } from './origin';
import type { GengaUsers } from './users';

type Services = {
  ctx: GengaContext;
  auth: GengaAuth;
  documents: GengaDocuments;
  media: GengaMedia;
  users: GengaUsers;
  tokens: GengaApiTokens;
};

const STATUSES = new Set(['all', 'draft', 'published', 'changed']);

function safeNext(value: string | null, base: string): string {
  if (!value || value.includes('\\')) return base;
  return isUnderPath(value.split(/[?#]/)[0], base) ? value : base;
}

/** Turns a service error into the response React Router expects from a loader. */
function rethrow(error: unknown): never {
  if (error instanceof GengaError) {
    throw data({ message: error.message }, { status: error.status, headers: ADMIN_HEADERS });
  }
  throw error;
}

/** Loaders and actions of the admin routes. The app calls them from its route modules. */
export function createAdmin({ ctx, auth, documents, media, users, tokens }: Services) {
  async function requireUser(request: Request): Promise<SessionUser> {
    const user = await auth.getUser(request);
    if (user) return user;
    const url = new URL(request.url);
    throw redirect(`${ctx.adminPath}/login?next=${encodeURIComponent(url.pathname + url.search)}`, {
      headers: ADMIN_HEADERS,
    });
  }

  function navFor(user: SessionUser): CollectionNav[] {
    return Object.entries(ctx.config.collections)
      .filter(([, collection]) => can(user, 'read', collection.access))
      .map(([name, collection]) => ({
        name,
        label: collection.label,
        labelSingular: collection.labelSingular,
        canCreate: can(user, 'create', collection.access),
      }));
  }

  function checkOrigin(request: Request) {
    if (!isAllowedOrigin(request, ctx.allowedOrigins)) {
      throw data({ message: 'Origine refusée.' }, { status: 403, headers: ADMIN_HEADERS });
    }
  }

  return {
    requireUser,

    async layout(request: Request): Promise<AppLayoutData> {
      const user = await requireUser(request);
      return {
        adminPath: ctx.adminPath,
        siteLink: ctx.siteLink,
        user,
        collections: navFor(user),
        canManageUsers: can(user, 'users.manage'),
        canDeleteMedia: can(user, 'media.delete'),
      };
    },

    async dashboard(request: Request): Promise<DashboardData> {
      const user = await requireUser(request);
      const recent = (
        await Promise.all(navFor(user).map((collection) => documents.list(user, collection.name, { limit: 6 })))
      )
        .flat()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8);
      const [{ count }] = await ctx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_media`;
      return { counts: await documents.counts(user), recent, mediaCount: count };
    },

    async collection(request: Request, name: string): Promise<CollectionPageData> {
      const user = await requireUser(request);
      const collection = navFor(user).find((item) => item.name === name);
      if (!collection) throw data({ message: 'Collection inconnue.' }, { status: 404, headers: ADMIN_HEADERS });
      const url = new URL(request.url);
      const search = url.searchParams.get('q') ?? '';
      const statusParam = url.searchParams.get('status') ?? 'all';
      const status = (STATUSES.has(statusParam) ? statusParam : 'all') as DocumentStatus | 'all';
      try {
        return { collection, documents: await documents.list(user, name, { search, status }), search, status };
      } catch (error) {
        rethrow(error);
      }
    },

    async document(request: Request, id: string): Promise<DocumentPageData> {
      const user = await requireUser(request);
      try {
        const document = await documents.get(user, id);
        return { document, versions: await documents.versions(user, id), schema: serializeSchema(ctx.config) };
      } catch (error) {
        rethrow(error);
      }
    },

    async media(request: Request): Promise<MediaPageData> {
      const user = await requireUser(request);
      return {
        media: await media.list(user),
        canDelete: can(user, 'media.delete'),
        canUpload: can(user, 'media.upload'),
      };
    },

    async users(request: Request): Promise<UsersPageData> {
      const user = await requireUser(request);
      try {
        return { users: await users.list(user), currentUserId: user.id };
      } catch (error) {
        rethrow(error);
      }
    },

    async tokens(request: Request): Promise<TokensPageData> {
      const user = await requireUser(request);
      const isManager = can(user, 'users.manage');
      return {
        tokens: await tokens.list(user),
        allTokens: isManager ? await tokens.list(user, { all: true }) : null,
        currentUserId: user.id,
        canPublish: Object.values(ctx.config.collections).some((collection) => can(user, 'publish', collection.access)),
      };
    },

    async loginLoader(request: Request): Promise<LoginPageData> {
      const url = new URL(request.url);
      const next = safeNext(url.searchParams.get('next'), ctx.adminPath);
      if (await auth.getUser(request)) throw redirect(next, { headers: ADMIN_HEADERS });
      return { needsSetup: (await auth.userCount()) === 0, next, adminPath: ctx.adminPath };
    },

    async loginAction(request: Request): Promise<FormResult> {
      checkOrigin(request);
      try {
        const form = await readForm(request, AUTH_FORM_BYTES);
        const { cookie } = await auth.login(request, form.get('email'), form.get('password'));
        throw redirect(safeNext(String(form.get('next') ?? ''), ctx.adminPath), {
          headers: { 'Set-Cookie': cookie, ...ADMIN_HEADERS },
        });
      } catch (error) {
        if (error instanceof GengaError) return { error: error.message };
        throw error;
      }
    },

    async setupLoader(request: Request): Promise<SetupPageData> {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      const described = token ? await auth.describeToken(token) : null;
      const { adminPath } = ctx;
      if (!described) return { valid: false, adminPath };
      return { valid: true, kind: described.kind, email: described.email, name: described.name, token, adminPath };
    },

    async setupAction(request: Request): Promise<FormResult> {
      checkOrigin(request);
      try {
        const form = await readForm(request, AUTH_FORM_BYTES);
        if (form.get('password') !== form.get('confirm')) return { error: 'Les deux mots de passe diffèrent.' };
        const { cookie } = await auth.acceptToken(request, String(form.get('token') ?? ''), {
          name: form.get('name'),
          email: form.get('email'),
          password: form.get('password'),
        });
        throw redirect(ctx.adminPath, { headers: { 'Set-Cookie': cookie, ...ADMIN_HEADERS } });
      } catch (error) {
        if (error instanceof GengaError) return { error: error.message };
        throw error;
      }
    },
  };
}

export type GengaAdmin = ReturnType<typeof createAdmin>;
