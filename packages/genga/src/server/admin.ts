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
  OAuthConsentPageData,
  PublicUser,
  SetupPageData,
  TokensPageData,
  UsersPageData,
} from '../types';
import { isApiScope, type GengaApiTokens } from './api-tokens';
import { ADMIN_HEADERS } from './api';
import type { GengaAuth, SessionUser } from './auth';
import { AUTH_FORM_BYTES, readForm } from './body';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { GengaError } from './errors';
import type { GengaMedia } from './media';
import { isUnderPath } from '../paths';
import type { AuthorizeRequest, GengaOAuth } from './oauth';
import { isNativeRedirect } from './oauth';
import { isAllowedOrigin } from './origin';
import type { GengaUsers } from './users';

type Services = {
  ctx: GengaContext;
  auth: GengaAuth;
  documents: GengaDocuments;
  media: GengaMedia;
  users: GengaUsers;
  tokens: GengaApiTokens;
  oauth: GengaOAuth | null;
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
export function createAdmin({ ctx, auth, documents, media, users, tokens, oauth }: Services) {
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

  function canPublishSomewhere(user: PublicUser): boolean {
    return Object.values(ctx.config.collections).some((collection) => can(user, 'publish', collection.access));
  }

  function requireOAuth(): GengaOAuth {
    if (!oauth) throw data({ message: 'Introuvable.' }, { status: 404, headers: ADMIN_HEADERS });
    return oauth;
  }

  function hostOf(value: string | null): string | null {
    if (!value) return null;
    try {
      return new URL(value).host || null;
    } catch {
      return null;
    }
  }

  function redirectTarget(uri: string): string {
    const url = new URL(uri);
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  }

  function consentData(
    user: PublicUser,
    request: AuthorizeRequest,
    query: string,
    error: string | null,
  ): OAuthConsentPageData {
    return {
      adminPath: ctx.adminPath,
      valid: true,
      client: {
        name: request.client.name,
        metadataUrl: request.client.kind === 'metadata' ? request.client.id : null,
        siteHost: hostOf(request.client.clientUri),
      },
      redirectTarget: redirectTarget(request.redirectUri),
      nativeRedirect: isNativeRedirect(request.redirectUri),
      scopes: request.scopes,
      canPublish: canPublishSomewhere(user),
      user: { name: user.name, email: user.email },
      query,
      error,
    };
  }

  /** Checks the authorization request in the URL. An error gives the page that explains it. */
  async function checkAuthorization(
    request: Request,
  ): Promise<{ ok: true; value: AuthorizeRequest; query: string } | { ok: false; page: OAuthConsentPageData }> {
    const url = new URL(request.url);
    const check = await requireOAuth().checkAuthorize(url.searchParams);
    if (check.ok) return { ok: true, value: check.request, query: url.search.slice(1) };
    return {
      ok: false,
      page: { adminPath: ctx.adminPath, valid: false, message: check.page, returnUrl: check.returnUrl },
    };
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
        grants: oauth ? await oauth.listGrants(user) : [],
        allGrants: oauth && isManager ? await oauth.listGrants(user, { all: true }) : null,
        mcpUrl: oauth?.resource ?? null,
        currentUserId: user.id,
        canPublish: canPublishSomewhere(user),
      };
    },

    /** The consent screen of an MCP client (OAuth authorization endpoint). It needs a session. */
    async oauthAuthorizeLoader(request: Request): Promise<OAuthConsentPageData> {
      requireOAuth();
      // The session comes first: without it, the page reads no client and downloads no metadata document.
      const user = await requireUser(request);
      const checked = await checkAuthorization(request);
      if (!checked.ok) return checked.page;
      return consentData(user, checked.value, checked.query, null);
    },

    /** The answer of the consent screen: a redirect to the client, with a code or `access_denied`. */
    async oauthAuthorizeAction(request: Request): Promise<OAuthConsentPageData> {
      requireOAuth();
      checkOrigin(request);
      const user = await requireUser(request);
      const checked = await checkAuthorization(request);
      if (!checked.ok) return checked.page;
      const form = await readForm(request, AUTH_FORM_BYTES);
      const decision = form.get('decision');
      if (decision !== 'allow' && decision !== 'deny') {
        return consentData(user, checked.value, checked.query, 'Choisissez « Autoriser » ou « Refuser ».');
      }
      const allow = decision === 'allow';
      const scopes = form.getAll('scope').filter(isApiScope);
      let location: string;
      try {
        location = await requireOAuth().decide(user, checked.value, { allow, scopes });
      } catch (error) {
        if (error instanceof GengaError) return consentData(user, checked.value, checked.query, error.message);
        throw error;
      }
      throw redirect(location, { headers: ADMIN_HEADERS });
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
