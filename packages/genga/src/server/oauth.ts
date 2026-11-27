import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_SCOPES, can, type ApiScope } from '../access';
import type { OAuthGrantItem, PublicUser } from '../types';
import { isUuid } from '../uuid';
import { bearerToken, isApiScope, type GengaApiTokens, type TokenAuth } from './api-tokens';
import { audit, clientAddress, hashToken, toPublicUser } from './auth';
import { readBody } from './body';
import type { Sql, TransactionSql } from 'postgres';
import type { GengaContext } from './context';
import { GengaError, notFound } from './errors';
import { originOf } from './origin';
import { RateLimiter } from './rate-limit';
import { fetchRemoteFile, type RemoteFetchOptions, type RemoteFile } from './remote-fetch';

export const OAUTH_ACCESS_PREFIX = 'ggo_';
export const OAUTH_REFRESH_PREFIX = 'ggr_';
/** The scopes that a client gets when its authorization request has no `scope`. */
export const DEFAULT_OAUTH_SCOPES: ApiScope[] = ['read', 'write'];

const ACCESS_PATTERN = /^ggo_[A-Za-z0-9_-]{43}$/;
const REFRESH_PATTERN = /^ggr_[A-Za-z0-9_-]{43}$/;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const CLIENT_METADATA_TTL_MS = 60 * 60_000;
/** A registered client without any authorization request after this delay goes out. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60_000;
const LAST_USED_PRECISION_MS = 60_000;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_CLIENT_METADATA_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const REGISTRATIONS_PER_ADDRESS = 30;
const REGISTRATION_WINDOW_MS = 60 * 60_000;
const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;
/** Schemes that a private-use redirect URI (RFC 8252) cannot use: they run code or read files. */
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ftp', 'ws', 'wss']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

type AuthMethod = (typeof AUTH_METHODS)[number];

export type OAuthOptions = {
  /** For tests: the download of a client metadata document. Default: `fetchRemoteFile`. */
  fetchClientMetadata?: (url: string) => Promise<RemoteFile>;
  /** For tests: the DNS lookup and the address check of the default download. */
  remoteFetch?: Pick<RemoteFetchOptions, 'lookup' | 'isAllowedAddress' | 'timeoutMs'>;
};

type ClientRow = {
  id: string;
  kind: 'registered' | 'metadata';
  name: string;
  client_uri: string | null;
  redirect_uris: string[];
  auth_method: AuthMethod;
  secret_hash: string | null;
  fresh_until: Date | null;
};

/** The client of an authorization request, as the consent screen shows it. */
export type OAuthClient = {
  id: string;
  kind: 'registered' | 'metadata';
  name: string;
  clientUri: string | null;
  redirectUris: string[];
};

export type AuthorizeRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: ApiScope[];
  resource: string;
};

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /**
   * The request is not valid. `returnUrl` carries the error to the client when the client and its
   * redirect URI are valid. Genga shows it as a link, never as an automatic redirect: anybody can
   * register a client, so a redirect URI is not a trusted destination.
   */
  | { ok: false; page: string; returnUrl: string | null };

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

function newSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function sameSecret(value: string, hash: string): boolean {
  const left = Buffer.from(hashToken(value), 'hex');
  const right = Buffer.from(hash, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** A client that refreshes twice at the same time gets an error, but keeps its grant, in this delay. */
const REFRESH_REUSE_GRACE_MS = 30_000;

/** A redirect URI that a client can register: https, http on a loopback host, or a private-use scheme. */
export function checkRedirectUri(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URI_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash || value.includes('#') || url.username || url.password) return null;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https') return value;
  if (scheme === 'http') return isLoopbackHttp(url) ? value : null;
  return BLOCKED_SCHEMES.has(scheme) ? null : value;
}

/**
 * Exact match, except the port of a loopback http URI: a native app opens a free port at each
 * start (RFC 8252, section 7.3).
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const left = new URL(registered);
    const right = new URL(requested);
    if (!isLoopbackHttp(left) || !isLoopbackHttp(right)) return false;
    left.port = '';
    right.port = '';
    return left.href === right.href;
  } catch {
    return false;
  }
}

/** True for a redirect URI that goes to an app on the computer of the user: loopback or private-use scheme. */
export function isNativeRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol !== 'https:';
  } catch {
    return true;
  }
}

/** A client id that is the URL of a client metadata document: https, with a path. */
function isMetadataUrl(value: string): boolean {
  if (!value.startsWith('https://') || value.length > MAX_URI_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.pathname !== '/' && !url.hash && !url.username && !url.password && url.href === value;
  } catch {
    return false;
  }
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url.href;
}

function toClient(row: ClientRow): OAuthClient {
  return { id: row.id, kind: row.kind, name: row.name, clientUri: row.client_uri, redirectUris: row.redirect_uris };
}

function parseScopes(value: string | null): ApiScope[] | null {
  if (value === null || !value.trim()) return null;
  const words = value.trim().split(/\s+/);
  return API_SCOPES.filter((scope) => words.includes(scope));
}

function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function oauthErrorResponse(error: OAuthError): Response {
  const headers: Record<string, string> = error.status === 401 ? { 'WWW-Authenticate': 'Basic realm="genga"' } : {};
  return oauthJson({ error: error.error, error_description: error.message }, error.status, headers);
}

function preflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** Decodes a `client_secret_basic` header. The id and the secret are form-encoded (RFC 6749, 2.3.1). */
function basicCredentials(request: Request): { id: string; secret: string } | null {
  const match = /^Basic[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  try {
    const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, ' '));
    return { id: decode(decoded.slice(0, colon)), secret: decode(decoded.slice(colon + 1)) };
  } catch {
    return null;
  }
}

type GrantRow = {
  id: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  client_id: string;
  client_name: string;
  client_kind: 'registered' | 'metadata';
  user_id: string;
  email: string;
  user_name: string;
};

function toGrantItem(row: GrantRow): OAuthGrantItem {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientHost: row.client_kind === 'metadata' ? new URL(row.client_id).host : null,
    scopes: row.scopes.filter(isApiScope),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    user: { id: row.user_id, email: row.email, name: row.user_name },
  };
}

/**
 * The OAuth 2.1 authorization server of the MCP endpoint, and its protected resource metadata.
 * The consent screen of the admin approves the requests; the access tokens work on the MCP
 * endpoint only. See docs/mcp-oauth.md.
 */
export function createOAuth(
  { ctx, tokens }: { ctx: GengaContext; tokens: GengaApiTokens },
  mcpPath: string,
  options: OAuthOptions = {},
) {
  const { sql } = ctx;
  const issuer = originOf(ctx.siteUrl) ?? ctx.siteUrl;
  const resource = `${issuer}${mcpPath}`;
  const endpointBase = `${issuer}${ctx.adminPath}/api/oauth`;
  const metadata = {
    protectedResource: `${issuer}/.well-known/oauth-protected-resource${mcpPath}`,
    authorizationServer: `${issuer}/.well-known/oauth-authorization-server`,
  };
  const registrations = new RateLimiter(REGISTRATIONS_PER_ADDRESS, REGISTRATION_WINDOW_MS);
  const fetchMetadata =
    options.fetchClientMetadata ??
    ((url: string) =>
      fetchRemoteFile(url, {
        ...options.remoteFetch,
        maxBytes: MAX_CLIENT_METADATA_BYTES,
        maxRedirects: 0,
        timeoutMs: options.remoteFetch?.timeoutMs ?? 5_000,
      }));

  function protectedResourceMetadata() {
    return {
      resource,
      authorization_servers: [issuer],
      // The MCP specification asks for the minimal scopes here. The consent page offers `publish` too.
      scopes_supported: [...DEFAULT_OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Genga',
    };
  }

  function authorizationServerMetadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}${ctx.adminPath}/oauth/authorize`,
      token_endpoint: `${endpointBase}/token`,
      registration_endpoint: `${endpointBase}/register`,
      revocation_endpoint: `${endpointBase}/revoke`,
      scopes_supported: [...API_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** The `WWW-Authenticate` value of a 401 from the MCP endpoint. */
  function challenge(error?: 'invalid_token'): string {
    const parts = [
      'Bearer realm="genga"',
      ...(error ? [`error="${error}"`] : []),
      `resource_metadata="${metadata.protectedResource}"`,
      `scope="${DEFAULT_OAUTH_SCOPES.join(' ')}"`,
    ];
    return parts.join(', ');
  }

  /** Answers the well-known metadata paths. Null for any other path. */
  function wellKnown(request: Request, pathname: string): Response | null {
    const path = pathname.replace(/\/+$/, '').toLowerCase();
    let body: unknown;
    if (path === `/.well-known/oauth-protected-resource${mcpPath}`.toLowerCase()) {
      body = protectedResourceMetadata();
    } else if (path === '/.well-known/oauth-authorization-server') {
      body = authorizationServerMetadata();
    } else {
      return null;
    }
    if (request.method === 'OPTIONS') return preflight('GET, HEAD, OPTIONS');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  /** True for the paths that `wellKnown` answers. */
  function isWellKnownPath(pathname: string): boolean {
    const path = pathname.replace(/\/+$/, '').toLowerCase();
    return (
      path === `/.well-known/oauth-protected-resource${mcpPath}`.toLowerCase() ||
      path === '/.well-known/oauth-authorization-server'
    );
  }

  async function loadMetadataClient(clientId: string): Promise<ClientRow | null> {
    const [cached] = await sql<ClientRow[]>`
      SELECT id, kind, name, client_uri, redirect_uris, auth_method, secret_hash, fresh_until
      FROM genga_oauth_clients WHERE id = ${clientId} AND kind = 'metadata'
    `;
    if (cached?.fresh_until && cached.fresh_until.getTime() > Date.now()) return cached;
    let document: Record<string, unknown>;
    try {
      const file = await fetchMetadata(clientId);
      const parsed: unknown = JSON.parse(file.body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      document = parsed as Record<string, unknown>;
    } catch (error) {
      ctx.log.warn(`[genga] OAuth: the client metadata document ${clientId} cannot be read.`, error);
      return null;
    }
    if (document.client_id !== clientId) return null;
    const name = typeof document.client_name === 'string' ? document.client_name.trim().slice(0, 100) : '';
    const redirectUris = Array.isArray(document.redirect_uris) ? document.redirect_uris : [];
    if (!name || !redirectUris.length || redirectUris.length > MAX_REDIRECT_URIS) return null;
    if (!redirectUris.every((uri) => checkRedirectUri(uri) !== null)) return null;
    const method = document.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') return null;
    const clientUri =
      typeof document.client_uri === 'string' && checkRedirectUri(document.client_uri)?.startsWith('https://')
        ? document.client_uri
        : null;
    await sql`
      DELETE FROM genga_oauth_clients c
      WHERE c.kind = 'metadata' AND c.fresh_until < ${new Date(Date.now() - UNUSED_CLIENT_TTL_MS)}
        AND NOT EXISTS (SELECT 1 FROM genga_oauth_grants g WHERE g.client_id = c.id AND g.revoked_at IS NULL)
    `;
    const [row] = await sql<ClientRow[]>`
      INSERT INTO genga_oauth_clients (id, kind, name, client_uri, redirect_uris, auth_method, fresh_until)
      VALUES (${clientId}, 'metadata', ${name}, ${clientUri}, ${redirectUris as string[]}, 'none',
        ${new Date(Date.now() + CLIENT_METADATA_TTL_MS)})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, client_uri = EXCLUDED.client_uri,
        redirect_uris = EXCLUDED.redirect_uris, fresh_until = EXCLUDED.fresh_until
      WHERE genga_oauth_clients.kind = 'metadata'
      RETURNING id, kind, name, client_uri, redirect_uris, auth_method, secret_hash, fresh_until
    `;
    return row ?? null;
  }

  /** The client of an authorization request. A URL client id loads its metadata document. */
  async function findClient(clientId: string, options: { refresh: boolean }): Promise<ClientRow | null> {
    if (!clientId || clientId.length > MAX_URI_LENGTH) return null;
    if (isMetadataUrl(clientId) && options.refresh) return loadMetadataClient(clientId);
    const [row] = await sql<ClientRow[]>`
      SELECT id, kind, name, client_uri, redirect_uris, auth_method, secret_hash, fresh_until
      FROM genga_oauth_clients WHERE id = ${clientId}
    `;
    return row ?? null;
  }

  /**
   * Checks an authorization request (RFC 6749 4.1.1 with PKCE and RFC 8707). The consent screen
   * calls it on display and again on submit: it never trusts the fields of its own form.
   */
  async function checkAuthorize(params: URLSearchParams): Promise<AuthorizeCheck> {
    const single = (name: string) => (params.getAll(name).length > 1 ? undefined : params.get(name));
    const clientId = single('client_id');
    const page = (message: string): AuthorizeCheck => ({ ok: false, page: message, returnUrl: null });
    if (!clientId) return page('La demande ne nomme pas d’application (client_id).');
    const row = await findClient(clientId, { refresh: true });
    if (!row) {
      return page(
        'Genga ne connaît pas cette application, ou ne peut pas lire sa description. Relancez la connexion depuis l’application.',
      );
    }
    const requestedUri = single('redirect_uri');
    let redirectUri: string;
    if (requestedUri === undefined) return page('La demande contient plusieurs adresses de retour.');
    if (requestedUri === null) {
      if (row.redirect_uris.length !== 1) return page('La demande ne donne pas d’adresse de retour.');
      redirectUri = row.redirect_uris[0];
    } else if (row.redirect_uris.some((uri) => redirectUriMatches(uri, requestedUri))) {
      redirectUri = requestedUri;
    } else {
      return page('L’adresse de retour de la demande n’est pas une adresse de cette application.');
    }
    const state = single('state') ?? null;
    const fail = (error: string, description: string, message: string): AuthorizeCheck => ({
      ok: false,
      page: `L’application a envoyé une demande que Genga refuse : ${message}`,
      returnUrl: withParams(redirectUri, { error, error_description: description, state, iss: issuer }),
    });
    if (single('response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only response_type=code is supported.', 'type de réponse inconnu.');
    }
    const challenge = single('code_challenge');
    if (single('code_challenge_method') !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail(
        'invalid_request',
        'PKCE is required: send a code_challenge with code_challenge_method=S256.',
        'la protection PKCE (S256) manque.',
      );
    }
    const resources = params.getAll('resource');
    if (resources.length > 1 || (resources.length === 1 && !sameResource(resources[0]))) {
      return fail('invalid_target', `The only resource of this server is ${resource}.`, 'elle vise un autre serveur.');
    }
    const requested = parseScopes(params.get('scope'));
    if (requested !== null && !requested.length) {
      return fail(
        'invalid_scope',
        `The scopes of this server are: ${API_SCOPES.join(', ')}.`,
        'elle demande des droits inconnus.',
      );
    }
    return {
      ok: true,
      request: {
        client: toClient(row),
        redirectUri,
        state,
        codeChallenge: challenge,
        scopes: requested ?? DEFAULT_OAUTH_SCOPES,
        resource,
      },
    };
  }

  function sameResource(value: string): boolean {
    try {
      const url = new URL(value);
      return !url.hash && `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}` === resource;
    } catch {
      return false;
    }
  }

  /**
   * The answer of the user on the consent screen. Returns the URL of the client to redirect to,
   * with a code, or with `access_denied`.
   */
  async function decide(
    user: PublicUser,
    request: AuthorizeRequest,
    decision: { allow: boolean; scopes: ApiScope[] },
  ): Promise<string> {
    const base = { state: request.state, iss: issuer };
    if (!decision.allow) {
      return withParams(request.redirectUri, {
        error: 'access_denied',
        error_description: 'The user refused.',
        ...base,
      });
    }
    const scopes = API_SCOPES.filter((scope) => decision.scopes.includes(scope));
    if (!scopes.length) throw new GengaError(400, 'bad_request', 'Choisissez au moins une portée.');
    const code = newSecret();
    await sql`
      INSERT INTO genga_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
      VALUES (${hashToken(code)}, ${request.client.id}, ${user.id}, ${request.redirectUri}, ${request.codeChallenge},
        ${scopes}, ${request.resource}, ${new Date(Date.now() + CODE_TTL_MS)})
    `;
    await sql`UPDATE genga_oauth_clients SET last_used_at = now() WHERE id = ${request.client.id}`;
    return withParams(request.redirectUri, { code, ...base });
  }

  async function readParams(request: Request): Promise<URLSearchParams> {
    const type = request.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      throw new OAuthError(400, 'invalid_request', 'Send the parameters as application/x-www-form-urlencoded.');
    }
    try {
      return new URLSearchParams(new TextDecoder().decode(await readBody(request, MAX_REQUEST_BYTES)));
    } catch {
      throw new OAuthError(400, 'invalid_request', 'The body is too large.');
    }
  }

  /** Client authentication at the token and revocation endpoints. */
  async function authenticateClient(request: Request, params: URLSearchParams): Promise<ClientRow> {
    const basic = basicCredentials(request);
    const clientId = basic?.id ?? params.get('client_id');
    const secret = basic?.secret ?? params.get('client_secret');
    const invalid = () => new OAuthError(401, 'invalid_client', 'Client authentication failed.');
    if (!clientId) throw invalid();
    if (basic && params.has('client_id') && params.get('client_id') !== basic.id) throw invalid();
    const client = await findClient(clientId, { refresh: false });
    if (!client) throw invalid();
    if (client.auth_method === 'none') {
      if (secret) throw invalid();
      return client;
    }
    if (!secret || !client.secret_hash || !sameSecret(secret, client.secret_hash)) throw invalid();
    if (client.auth_method === 'client_secret_basic' && !basic) throw invalid();
    if (client.auth_method === 'client_secret_post' && basic) throw invalid();
    return client;
  }

  /**
   * Stores a new access token and a new refresh token. The access token can have fewer scopes than
   * the grant, after a refresh that asks for fewer. The refresh token keeps the scopes of the grant.
   */
  async function issueTokens(
    db: Sql | TransactionSql,
    grant: { id: string; scopes: ApiScope[] },
    accessScopes: ApiScope[] = grant.scopes,
  ) {
    const access = newSecret(OAUTH_ACCESS_PREFIX);
    const refresh = newSecret(OAUTH_REFRESH_PREFIX);
    await db`
      INSERT INTO genga_oauth_tokens (token_hash, grant_id, kind, scopes, expires_at) VALUES
        (${hashToken(access)}, ${grant.id}, 'access', ${accessScopes}, ${new Date(Date.now() + ACCESS_TTL_S * 1000)}),
        (${hashToken(refresh)}, ${grant.id}, 'refresh', ${grant.scopes}, ${new Date(Date.now() + REFRESH_TTL_MS)})
    `;
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: accessScopes.join(' '),
    };
  }

  async function revokeGrant(grantId: string, reason: string, userId: string | null = null) {
    const [row] = await sql<{ user_id: string; client_id: string }[]>`
      UPDATE genga_oauth_grants SET revoked_at = now() WHERE id = ${grantId} AND revoked_at IS NULL
      RETURNING user_id, client_id
    `;
    if (!row) return;
    await sql`DELETE FROM genga_oauth_tokens WHERE grant_id = ${grantId}`;
    await audit(ctx, userId, 'oauth.revoke', {
      detail: { grantId, clientId: row.client_id, ownerId: row.user_id, reason },
    });
  }

  async function exchangeCode(client: ClientRow, params: URLSearchParams): Promise<Response> {
    const code = params.get('code') ?? '';
    const verifier = params.get('code_verifier') ?? '';
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      throw new OAuthError(400, 'invalid_request', 'Send code and code_verifier.');
    }
    await sql`DELETE FROM genga_oauth_codes WHERE expires_at < now() - interval '1 day'`;
    const hash = hashToken(code);
    // The code is used from here, also when a check below fails: a code never gets a second try.
    const [row] = await sql<
      {
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        scopes: string[];
        resource: string;
        expires_at: Date;
      }[]
    >`
      UPDATE genga_oauth_codes SET used_at = now()
      WHERE code_hash = ${hash} AND used_at IS NULL
      RETURNING client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at
    `;
    const invalidGrant = () => new OAuthError(400, 'invalid_grant', 'The code is not valid, expired or already used.');
    if (!row) {
      // A second use of a code means that someone else has it: the grant of the first use goes out.
      // `replayed_at` also stops a first use that has not created its grant yet.
      const [used] = await sql<{ grant_id: string | null }[]>`
        UPDATE genga_oauth_codes SET replayed_at = now()
        WHERE code_hash = ${hash} AND used_at IS NOT NULL
        RETURNING grant_id
      `;
      if (used?.grant_id) await revokeGrant(used.grant_id, 'code_reuse');
      throw invalidGrant();
    }
    if (row.expires_at.getTime() <= Date.now() || row.client_id !== client.id) throw invalidGrant();
    const redirectUri = params.get('redirect_uri');
    if (redirectUri !== null && redirectUri !== row.redirect_uri) throw invalidGrant();
    if (pkceChallenge(verifier) !== row.code_challenge) throw invalidGrant();
    const requestedResource = params.get('resource');
    if (requestedResource !== null && !sameResource(requestedResource)) {
      throw new OAuthError(400, 'invalid_target', `The only resource of this server is ${resource}.`);
    }
    const scopes = row.scopes.filter(isApiScope);
    const result = await sql.begin(async (tx) => {
      const [locked] = await tx<{ replayed_at: Date | null }[]>`
        SELECT replayed_at FROM genga_oauth_codes WHERE code_hash = ${hash} FOR UPDATE
      `;
      const [user] = await tx`SELECT id FROM genga_users WHERE id = ${row.user_id} AND disabled_at IS NULL`;
      if (!locked || locked.replayed_at || !user) return null;
      // A new consent replaces the earlier grant of the same person for the same client.
      const replaced = await tx<{ id: string }[]>`
        UPDATE genga_oauth_grants SET revoked_at = now()
        WHERE user_id = ${row.user_id} AND client_id = ${client.id} AND revoked_at IS NULL
        RETURNING id
      `;
      if (replaced.length) {
        await tx`DELETE FROM genga_oauth_tokens WHERE grant_id IN ${tx(replaced.map((grant) => grant.id))}`;
      }
      const [grant] = await tx<{ id: string }[]>`
        INSERT INTO genga_oauth_grants (user_id, client_id, scopes, resource)
        VALUES (${row.user_id}, ${client.id}, ${scopes}, ${row.resource})
        RETURNING id
      `;
      await tx`UPDATE genga_oauth_codes SET grant_id = ${grant.id} WHERE code_hash = ${hash}`;
      const body = await issueTokens(tx, { id: grant.id, scopes });
      return { grantId: grant.id, replaced: replaced.map((item) => item.id), body };
    });
    if (!result) throw invalidGrant();
    for (const grantId of result.replaced) {
      await audit(ctx, row.user_id, 'oauth.revoke', {
        detail: { grantId, clientId: client.id, ownerId: row.user_id, reason: 'replaced' },
      });
    }
    await audit(ctx, row.user_id, 'oauth.grant', {
      detail: { grantId: result.grantId, clientId: client.id, clientName: client.name, scopes },
    });
    return oauthJson(result.body);
  }

  async function refresh(client: ClientRow, params: URLSearchParams): Promise<Response> {
    const token = params.get('refresh_token') ?? '';
    const invalidGrant = () => new OAuthError(400, 'invalid_grant', 'The refresh token is not valid.');
    if (!REFRESH_PATTERN.test(token)) throw invalidGrant();
    const hash = hashToken(token);
    const [row] = await sql<{ grant_id: string; scopes: string[]; client_id: string; ok: boolean }[]>`
      UPDATE genga_oauth_tokens t SET used_at = now()
      FROM genga_oauth_grants g JOIN genga_users u ON u.id = g.user_id
      WHERE t.token_hash = ${hash} AND t.kind = 'refresh' AND t.used_at IS NULL AND g.id = t.grant_id
      RETURNING t.grant_id, g.scopes, g.client_id,
        (t.expires_at > now() AND g.revoked_at IS NULL AND u.disabled_at IS NULL) AS ok
    `;
    if (!row) {
      // A refresh token that comes back after its rotation was stolen, or the client lost the new one.
      // Both cases end the grant (OAuth 2.1, 4.3.1). Two refreshes of one client at the same time
      // are the exception: the second one gets an error, and the grant stays.
      const [used] = await sql<{ grant_id: string; used_at: Date; client_id: string }[]>`
        SELECT t.grant_id, t.used_at, g.client_id
        FROM genga_oauth_tokens t JOIN genga_oauth_grants g ON g.id = t.grant_id
        WHERE t.token_hash = ${hash} AND t.kind = 'refresh' AND t.used_at IS NOT NULL
      `;
      const concurrent =
        used && used.client_id === client.id && Date.now() - used.used_at.getTime() < REFRESH_REUSE_GRACE_MS;
      if (used && !concurrent) await revokeGrant(used.grant_id, 'refresh_reuse');
      throw invalidGrant();
    }
    if (!row.ok || row.client_id !== client.id) throw invalidGrant();
    const grantScopes = row.scopes.filter(isApiScope);
    const requested = parseScopes(params.get('scope'));
    if (requested !== null && (!requested.length || requested.some((scope) => !grantScopes.includes(scope)))) {
      throw new OAuthError(400, 'invalid_scope', 'The scope cannot grow on refresh.');
    }
    const requestedResource = params.get('resource');
    if (requestedResource !== null && !sameResource(requestedResource)) {
      throw new OAuthError(400, 'invalid_target', `The only resource of this server is ${resource}.`);
    }
    await sql`DELETE FROM genga_oauth_tokens WHERE grant_id = ${row.grant_id} AND expires_at < now()`;
    return oauthJson(await issueTokens(sql, { id: row.grant_id, scopes: grantScopes }, requested ?? grantScopes));
  }

  async function tokenEndpoint(request: Request): Promise<Response> {
    const params = await readParams(request);
    const client = await authenticateClient(request, params);
    switch (params.get('grant_type')) {
      case 'authorization_code':
        return exchangeCode(client, params);
      case 'refresh_token':
        return refresh(client, params);
      default:
        throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
  }

  /** RFC 7009. Revoking any token of a grant ends the grant. Unknown tokens get a 200 too. */
  async function revocationEndpoint(request: Request): Promise<Response> {
    const params = await readParams(request);
    const client = await authenticateClient(request, params);
    const token = params.get('token') ?? '';
    if (!token) throw new OAuthError(400, 'invalid_request', 'Send the token to revoke.');
    if (ACCESS_PATTERN.test(token) || REFRESH_PATTERN.test(token)) {
      const [row] = await sql<{ grant_id: string }[]>`
        SELECT t.grant_id FROM genga_oauth_tokens t JOIN genga_oauth_grants g ON g.id = t.grant_id
        WHERE t.token_hash = ${hashToken(token)} AND g.client_id = ${client.id}
      `;
      if (row) await revokeGrant(row.grant_id, 'client');
    }
    return new Response(null, {
      status: 200,
      headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }

  /** RFC 7591. Open registration, as MCP clients expect: rate-limited, and unused clients go out after a day. */
  async function registrationEndpoint(request: Request): Promise<Response> {
    const ip = clientAddress(request, ctx.trustedProxies);
    if (ip !== 'unknown') {
      if (registrations.isLimited(ip)) {
        return oauthJson(
          { error: 'too_many_requests', error_description: 'Too many registrations. Wait, then retry.' },
          429,
          {
            'Retry-After': '3600',
          },
        );
      }
      registrations.hit(ip);
    }
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new OAuthError(400, 'invalid_client_metadata', 'Send the client metadata as JSON.');
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await readBody(request, MAX_REQUEST_BYTES)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new OAuthError(400, 'invalid_client_metadata', 'The body is not a JSON object.');
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError(400, 'invalid_redirect_uri', `Send 1 to ${MAX_REDIRECT_URIS} redirect_uris.`);
    }
    const redirectUris = uris.map(checkRedirectUri);
    if (redirectUris.some((uri) => uri === null)) {
      throw new OAuthError(
        400,
        'invalid_redirect_uri',
        'A redirect URI must use https, http on localhost or a loopback address, or a private-use scheme.',
      );
    }
    const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!AUTH_METHODS.includes(method as AuthMethod)) {
      throw new OAuthError(
        400,
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}.`,
      );
    }
    const grantTypes = body.grant_types ?? ['authorization_code'];
    if (
      !Array.isArray(grantTypes) ||
      grantTypes.some((type) => type !== 'authorization_code' && type !== 'refresh_token')
    ) {
      throw new OAuthError(
        400,
        'invalid_client_metadata',
        'grant_types can hold authorization_code and refresh_token only.',
      );
    }
    const responseTypes = body.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.some((type) => type !== 'code')) {
      throw new OAuthError(400, 'invalid_client_metadata', 'response_types can hold code only.');
    }
    const name =
      (typeof body.client_name === 'string' && body.client_name.trim().slice(0, 100)) || 'Client MCP sans nom';
    const clientUri =
      typeof body.client_uri === 'string' && body.client_uri.startsWith('https://') && checkRedirectUri(body.client_uri)
        ? body.client_uri
        : null;
    const clientId = newSecret('ggc_').slice(0, 26);
    const secret = method === 'none' ? null : newSecret('ggs_');
    await sql`
      DELETE FROM genga_oauth_clients
      WHERE kind = 'registered' AND last_used_at IS NULL AND created_at < ${new Date(Date.now() - UNUSED_CLIENT_TTL_MS)}
    `;
    await sql`DELETE FROM genga_oauth_codes WHERE expires_at < now() - interval '1 day'`;
    const [row] = await sql<{ created_at: Date }[]>`
      INSERT INTO genga_oauth_clients (id, kind, name, client_uri, redirect_uris, auth_method, secret_hash)
      VALUES (${clientId}, 'registered', ${name}, ${clientUri}, ${redirectUris as string[]}, ${method as AuthMethod},
        ${secret ? hashToken(secret) : null})
      RETURNING created_at
    `;
    return oauthJson(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(row.created_at.getTime() / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: name,
        ...(clientUri ? { client_uri: clientUri } : {}),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  }

  /** Answers `<adminPath>/api/oauth/{token,register,revoke}`. */
  async function endpoint(request: Request, name: string): Promise<Response> {
    const handlers: Record<string, (request: Request) => Promise<Response>> = {
      token: tokenEndpoint,
      register: registrationEndpoint,
      revoke: revocationEndpoint,
    };
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) return oauthJson({ error: 'not_found', error_description: 'Unknown OAuth endpoint.' }, 404);
    if (request.method === 'OPTIONS') return preflight('POST, OPTIONS');
    if (request.method !== 'POST') {
      return oauthJson({ error: 'invalid_request', error_description: 'Use POST.' }, 405, { Allow: 'POST, OPTIONS' });
    }
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof OAuthError) return oauthErrorResponse(error);
      ctx.log.error('[genga] OAuth endpoint error:', error);
      return oauthJson({ error: 'server_error', error_description: 'Internal error.' }, 500);
    }
  }

  /**
   * Reads an OAuth access token from `Authorization: Bearer ggo_…`. Null when the token is not
   * valid: unknown, expired, of a revoked grant, of a disabled user, or for another resource.
   */
  async function authenticate(request: Request): Promise<TokenAuth | null> {
    const token = bearerToken(request);
    if (!token || !ACCESS_PATTERN.test(token)) return tokens.refuse(request);
    const [row] = await sql<
      {
        grant_id: string;
        scopes: string[];
        resource: string;
        last_used_at: Date | null;
        client_id: string;
        client_name: string;
        user_id: string;
        email: string;
        user_name: string;
        role: string;
        user_created_at: Date;
        disabled_at: Date | null;
      }[]
    >`
      SELECT g.id AS grant_id, t.scopes, g.resource, g.last_used_at, c.id AS client_id, c.name AS client_name,
        u.id AS user_id, u.email, u.name AS user_name, u.role, u.created_at AS user_created_at, u.disabled_at
      FROM genga_oauth_tokens t
        JOIN genga_oauth_grants g ON g.id = t.grant_id
        JOIN genga_oauth_clients c ON c.id = g.client_id
        JOIN genga_users u ON u.id = g.user_id
      WHERE t.token_hash = ${hashToken(token)} AND t.kind = 'access' AND t.expires_at > now()
        AND g.revoked_at IS NULL AND u.disabled_at IS NULL
    `;
    if (!row || row.resource !== resource) return tokens.refuse(request);
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > LAST_USED_PRECISION_MS) {
      await sql`UPDATE genga_oauth_grants SET last_used_at = now() WHERE id = ${row.grant_id}`;
    }
    return {
      user: toPublicUser({
        id: row.user_id,
        email: row.email,
        name: row.user_name,
        role: row.role,
        created_at: row.user_created_at,
        disabled_at: row.disabled_at,
      }),
      token: {
        id: row.grant_id,
        name: row.client_name,
        scopes: row.scopes.filter(isApiScope),
        kind: 'oauth',
        clientId: row.client_id,
      },
    };
  }

  /** The grants that are not revoked: of the user, or of every user with `all` for a user manager. */
  async function listGrants(user: PublicUser, listOptions: { all?: boolean } = {}): Promise<OAuthGrantItem[]> {
    const all = listOptions.all === true && can(user, 'users.manage');
    const rows = await sql<GrantRow[]>`
      SELECT g.id, g.scopes, g.created_at, g.last_used_at, c.id AS client_id, c.name AS client_name,
        c.kind AS client_kind, u.id AS user_id, u.email, u.name AS user_name
      FROM genga_oauth_grants g
        JOIN genga_oauth_clients c ON c.id = g.client_id
        JOIN genga_users u ON u.id = g.user_id
      WHERE g.revoked_at IS NULL ${all ? sql`` : sql`AND g.user_id = ${user.id}`}
      ORDER BY g.created_at DESC
    `;
    return rows.map(toGrantItem);
  }

  /** A user revokes its own grants. A user manager revokes any grant. */
  async function revokeGrantOf(user: PublicUser, id: string): Promise<void> {
    if (!isUuid(id)) throw notFound('Application introuvable.');
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM genga_oauth_grants
      WHERE id = ${id} AND revoked_at IS NULL ${can(user, 'users.manage') ? sql`` : sql`AND user_id = ${user.id}`}
    `;
    if (!row) throw notFound('Application introuvable.');
    await revokeGrant(id, 'user', user.id);
  }

  function resetRateLimits() {
    registrations.clear();
  }

  return {
    issuer,
    resource,
    metadataUrls: metadata,
    challenge,
    wellKnown,
    isWellKnownPath,
    endpoint,
    checkAuthorize,
    decide,
    authenticate,
    listGrants,
    revokeGrant: revokeGrantOf,
    resetRateLimits,
  };
}

export type GengaOAuth = ReturnType<typeof createOAuth>;

/** True when the bearer token of the request has the prefix of an OAuth access token. */
export function hasOAuthBearer(request: Request): boolean {
  return bearerToken(request)?.startsWith(OAUTH_ACCESS_PREFIX) === true;
}
