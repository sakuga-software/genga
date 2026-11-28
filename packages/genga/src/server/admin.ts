import { can, type ApiScope } from '../access';
import { serializeSchema } from '../config';
import { isUnderPath } from '../paths';
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
import { GengaError, notFound } from './errors';
import type { GengaMedia } from './media';
import type { AuthorizeRequest, GengaOAuth } from './oauth';
import { isNativeRedirect } from './oauth';
import { isAllowedOrigin } from './origin';
import type { GengaUsers } from './users';

export type AdminServices = {
  ctx: GengaContext;
  auth: GengaAuth;
  documents: GengaDocuments;
  media: GengaMedia;
  users: GengaUsers;
  tokens: GengaApiTokens;
  oauth: GengaOAuth | null;
};

const STATUSES = new Set(['all', 'draft', 'published', 'changed']);

/** The answer of the consent screen: the client URL to open, or the page again with an error. */
export type ConsentDecision = { location: string } | { page: OAuthConsentPageData };

/** A form of the sign-in pages that succeeded: the session cookie and the admin path to open. */
export type SignedIn = { cookie: string; location: string };

/** Keeps `next` only when it is a path of the admin. Any other value gives the admin home. */
export function safeNext(value: string | null, base: string): string {
  if (!value || value.includes('\\')) return base;
  return isUnderPath(value.split(/[?#]/)[0], base) ? value : base;
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

/**
 * The data of each admin screen and the sign-in forms, without HTTP. The admin API serves it as JSON,
 * and the deprecated route modules read it through `createAdmin`.
 */
export function createAdminViews({ ctx, auth, documents, media, users, tokens, oauth }: AdminServices) {
  function navFor(user: PublicUser): CollectionNav[] {
    return Object.entries(ctx.config.collections)
      .filter(([, collection]) => can(user, 'read', collection.access))
      .map(([name, collection]) => ({
        name,
        label: collection.label,
        labelSingular: collection.labelSingular,
        canCreate: can(user, 'create', collection.access),
      }));
  }

  function canPublishSomewhere(user: PublicUser): boolean {
    return Object.values(ctx.config.collections).some((collection) => can(user, 'publish', collection.access));
  }

  function requireOAuth(): GengaOAuth {
    if (!oauth) throw notFound('Introuvable.');
    return oauth;
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

  /** Checks the authorization request in `query`. An error gives the page that explains it. */
  async function checkAuthorization(
    query: string,
  ): Promise<{ ok: true; value: AuthorizeRequest } | { ok: false; page: OAuthConsentPageData }> {
    const check = await requireOAuth().checkAuthorize(new URLSearchParams(query));
    if (check.ok) return { ok: true, value: check.request };
    return {
      ok: false,
      page: { adminPath: ctx.adminPath, valid: false, message: check.page, returnUrl: check.returnUrl },
    };
  }

  return {
    hasOAuth: oauth !== null,

    layout(user: SessionUser): AppLayoutData {
      return {
        adminPath: ctx.adminPath,
        siteLink: ctx.siteLink,
        user,
        collections: navFor(user),
        canManageUsers: can(user, 'users.manage'),
        canDeleteMedia: can(user, 'media.delete'),
      };
    },

    async dashboard(user: PublicUser): Promise<DashboardData> {
      const recent = (
        await Promise.all(navFor(user).map((collection) => documents.list(user, collection.name, { limit: 6 })))
      )
        .flat()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8);
      const [{ count }] = await ctx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_media`;
      return { counts: await documents.counts(user), recent, mediaCount: count };
    },

    async collection(user: PublicUser, name: string, params: URLSearchParams): Promise<CollectionPageData> {
      const collection = navFor(user).find((item) => item.name === name);
      if (!collection) throw notFound('Collection inconnue.');
      const search = params.get('q') ?? '';
      const statusParam = params.get('status') ?? 'all';
      const status = (STATUSES.has(statusParam) ? statusParam : 'all') as DocumentStatus | 'all';
      return { collection, documents: await documents.list(user, name, { search, status }), search, status };
    },

    async document(user: PublicUser, id: string): Promise<DocumentPageData> {
      const document = await documents.get(user, id);
      return { document, versions: await documents.versions(user, id), schema: serializeSchema(ctx.config) };
    },

    async media(user: PublicUser): Promise<MediaPageData> {
      return {
        media: await media.list(user),
        canDelete: can(user, 'media.delete'),
        canUpload: can(user, 'media.upload'),
      };
    },

    async users(user: PublicUser): Promise<UsersPageData> {
      return { users: await users.list(user), currentUserId: user.id };
    },

    async tokens(user: PublicUser): Promise<TokensPageData> {
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

    /**
     * The consent screen of an MCP client. The caller checks the session first: without it, Genga
     * reads no client and downloads no metadata document.
     */
    async consent(user: PublicUser, query: string): Promise<OAuthConsentPageData> {
      const checked = await checkAuthorization(query);
      if (!checked.ok) return checked.page;
      return consentData(user, checked.value, query, null);
    },

    /** Checks the request again, then gives the client URL with a code or `access_denied`. */
    async decide(
      user: PublicUser,
      query: string,
      answer: { decision: unknown; scopes: unknown[] },
    ): Promise<ConsentDecision> {
      const checked = await checkAuthorization(query);
      if (!checked.ok) return { page: checked.page };
      const { decision } = answer;
      if (decision !== 'allow' && decision !== 'deny') {
        return { page: consentData(user, checked.value, query, 'Choisissez « Autoriser » ou « Refuser ».') };
      }
      const scopes: ApiScope[] = answer.scopes.filter(isApiScope);
      try {
        return { location: await requireOAuth().decide(user, checked.value, { allow: decision === 'allow', scopes }) };
      } catch (error) {
        if (error instanceof GengaError) return { page: consentData(user, checked.value, query, error.message) };
        throw error;
      }
    },

    /** The login page. `signedIn` is true when the request already has a session: the page then opens `next`. */
    async login(request: Request, nextParam: string | null): Promise<LoginPageData & { signedIn: boolean }> {
      const next = safeNext(nextParam, ctx.adminPath);
      if (await auth.getUser(request)) return { signedIn: true, needsSetup: false, next, adminPath: ctx.adminPath };
      return { signedIn: false, needsSetup: (await auth.userCount()) === 0, next, adminPath: ctx.adminPath };
    },

    /** Checks the password. Throws a `GengaError` with the message for the form. */
    async signIn(request: Request, input: { email: unknown; password: unknown; next: unknown }): Promise<SignedIn> {
      const { cookie } = await auth.login(request, input.email, input.password);
      return { cookie, location: safeNext(typeof input.next === 'string' ? input.next : null, ctx.adminPath) };
    },

    async setup(token: string): Promise<SetupPageData> {
      const described = token ? await auth.describeToken(token) : null;
      const { adminPath } = ctx;
      if (!described) return { valid: false, adminPath };
      return { valid: true, kind: described.kind, email: described.email, name: described.name, token, adminPath };
    },

    /** Accepts a setup or invitation link. Throws a `GengaError` with the message for the form. */
    async acceptSetup(
      request: Request,
      input: { token: unknown; name: unknown; email: unknown; password: unknown; confirm: unknown },
    ): Promise<SignedIn> {
      if (input.password !== input.confirm) throw new GengaError(400, 'invalid', 'Les deux mots de passe diffèrent.');
      const { cookie } = await auth.acceptToken(request, typeof input.token === 'string' ? input.token : '', {
        name: input.name,
        email: input.email,
        password: input.password,
      });
      return { cookie, location: ctx.adminPath };
    },
  };
}

export type GengaAdminViews = ReturnType<typeof createAdminViews>;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function redirectTo(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...ADMIN_HEADERS, ...headers } });
}

/**
 * Loaders and actions of the deprecated admin route modules. They throw a `Response`, which React
 * Router reads as a redirect (3xx with `Location`) or as an error response with JSON data.
 */
export function createAdmin(services: AdminServices) {
  const { ctx, auth } = services;
  const views = createAdminViews(services);

  async function requireUser(request: Request): Promise<SessionUser> {
    const user = await auth.getUser(request);
    if (user) return user;
    const url = new URL(request.url);
    throw redirectTo(`${ctx.adminPath}/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  async function asLoader<T>(run: () => Promise<T> | T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GengaError) throw jsonError(error.message, error.status);
      throw error;
    }
  }

  function checkOrigin(request: Request) {
    if (!isAllowedOrigin(request, ctx.allowedOrigins)) throw jsonError('Origine refusée.', 403);
  }

  function requireOAuth() {
    if (!views.hasOAuth) throw jsonError('Introuvable.', 404);
  }

  async function formResult(run: () => Promise<SignedIn>): Promise<FormResult> {
    let signedIn: SignedIn;
    try {
      signedIn = await run();
    } catch (error) {
      if (error instanceof GengaError) return { error: error.message };
      throw error;
    }
    throw redirectTo(signedIn.location, { 'Set-Cookie': signedIn.cookie });
  }

  return {
    requireUser,

    async layout(request: Request): Promise<AppLayoutData> {
      return views.layout(await requireUser(request));
    },

    async dashboard(request: Request): Promise<DashboardData> {
      return views.dashboard(await requireUser(request));
    },

    async collection(request: Request, name: string): Promise<CollectionPageData> {
      const user = await requireUser(request);
      return asLoader(() => views.collection(user, name, new URL(request.url).searchParams));
    },

    async document(request: Request, id: string): Promise<DocumentPageData> {
      const user = await requireUser(request);
      return asLoader(() => views.document(user, id));
    },

    async media(request: Request): Promise<MediaPageData> {
      return views.media(await requireUser(request));
    },

    async users(request: Request): Promise<UsersPageData> {
      const user = await requireUser(request);
      return asLoader(() => views.users(user));
    },

    async tokens(request: Request): Promise<TokensPageData> {
      return views.tokens(await requireUser(request));
    },

    /** The consent screen of an MCP client (OAuth authorization endpoint). It needs a session. */
    async oauthAuthorizeLoader(request: Request): Promise<OAuthConsentPageData> {
      requireOAuth();
      const user = await requireUser(request);
      return views.consent(user, new URL(request.url).search.slice(1));
    },

    /** The answer of the consent screen: a redirect to the client, with a code or `access_denied`. */
    async oauthAuthorizeAction(request: Request): Promise<OAuthConsentPageData> {
      requireOAuth();
      checkOrigin(request);
      const user = await requireUser(request);
      const query = new URL(request.url).search.slice(1);
      const form = await asLoader(() => readForm(request, AUTH_FORM_BYTES));
      const result = await views.decide(user, query, { decision: form.get('decision'), scopes: form.getAll('scope') });
      if ('page' in result) return result.page;
      throw redirectTo(result.location);
    },

    async loginLoader(request: Request): Promise<LoginPageData> {
      const { signedIn, ...page } = await views.login(request, new URL(request.url).searchParams.get('next'));
      if (signedIn) throw redirectTo(page.next);
      return page;
    },

    async loginAction(request: Request): Promise<FormResult> {
      checkOrigin(request);
      return formResult(async () => {
        const form = await readForm(request, AUTH_FORM_BYTES);
        return views.signIn(request, {
          email: form.get('email'),
          password: form.get('password'),
          next: form.get('next'),
        });
      });
    },

    async setupLoader(request: Request): Promise<SetupPageData> {
      return views.setup(new URL(request.url).searchParams.get('token') ?? '');
    },

    async setupAction(request: Request): Promise<FormResult> {
      checkOrigin(request);
      return formResult(async () => {
        const form = await readForm(request, AUTH_FORM_BYTES);
        return views.acceptSetup(request, {
          token: form.get('token'),
          name: form.get('name'),
          email: form.get('email'),
          password: form.get('password'),
          confirm: form.get('confirm'),
        });
      });
    },
  };
}

export type GengaAdmin = ReturnType<typeof createAdmin>;
