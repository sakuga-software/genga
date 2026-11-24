import { randomBytes } from 'node:crypto';
import { API_SCOPES, can, type ApiScope } from '../access';
import type { ApiTokenItem, PublicUser } from '../types';
import { isUuid } from '../uuid';
import { audit, clientIp, hashToken, toPublicUser } from './auth';
import type { GengaContext } from './context';
import { badRequest, GengaError, notFound } from './errors';
import { RateLimiter } from './rate-limit';

/** Secret scanners can find a leaked token by this prefix. */
export const API_TOKEN_PREFIX = 'gga_';

const TOKEN_PATTERN = /^gga_[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_TOKENS = 50;
const MAX_LIFETIME_MS = 5 * 366 * 24 * 60 * 60_000;
const LAST_USED_PRECISION_MS = 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** Bad tokens from one address in 15 minutes before a 429. */
const FAILURES_PER_ADDRESS = 20;

/** The result of a valid bearer token: the user as it is now, and the token. */
export type TokenAuth = {
  user: PublicUser;
  token: { id: string; name: string; scopes: ApiScope[] };
};

type TokenRow = {
  id: string;
  name: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  user_id: string;
  email: string;
  user_name: string;
};

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

function toItem(row: TokenRow): ApiTokenItem {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes.filter(isApiScope),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    expired: row.expires_at !== null && row.expires_at.getTime() <= Date.now(),
    user: { id: row.user_id, email: row.email, name: row.user_name },
  };
}

function checkScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value) || !value.length || !value.every(isApiScope)) {
    throw badRequest('Choisissez au moins une portée : read, write ou publish.');
  }
  return API_SCOPES.filter((scope) => value.includes(scope));
}

function checkExpiry(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw badRequest("Date d'expiration invalide.");
  if (date.getTime() <= Date.now()) throw badRequest("La date d'expiration doit être dans le futur.");
  if (date.getTime() > Date.now() + MAX_LIFETIME_MS) throw badRequest("L'expiration ne peut pas dépasser 5 ans.");
  return date;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1] : '';
}

export function createApiTokens(ctx: GengaContext) {
  const { sql } = ctx;
  const failures = new RateLimiter(FAILURES_PER_ADDRESS, FAILURE_WINDOW_MS);

  const selectRows = () => sql`
    SELECT t.id, t.name, t.scopes, t.created_at, t.last_used_at, t.expires_at, t.user_id,
      u.email, u.name AS user_name
    FROM genga_api_tokens t JOIN genga_users u ON u.id = t.user_id
  `;

  /** Creates a token for the user. The clear token is in the result only: store it now. */
  async function create(
    user: PublicUser,
    input: { name?: unknown; scopes?: unknown; expiresAt?: unknown },
  ): Promise<{ token: string; item: ApiTokenItem }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) throw badRequest('Donnez un nom de 1 à 100 caractères au jeton.');
    const scopes = checkScopes(input.scopes);
    const expiresAt = checkExpiry(input.expiresAt);
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = await sql.begin(async (tx) => {
      // The user row lock serializes two creations, so the count stays true.
      await tx`SELECT id FROM genga_users WHERE id = ${user.id} FOR UPDATE`;
      const [{ count }] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM genga_api_tokens
        WHERE user_id = ${user.id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      `;
      if (count >= MAX_ACTIVE_TOKENS) {
        throw badRequest(`Vous avez déjà ${MAX_ACTIVE_TOKENS} jetons actifs. Révoquez-en un d'abord.`);
      }
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO genga_api_tokens (user_id, name, token_hash, scopes, expires_at)
        VALUES (${user.id}, ${name}, ${hashToken(token)}, ${scopes}, ${expiresAt})
        RETURNING id
      `;
      return row.id;
    });
    await audit(ctx, user.id, 'token.create', { detail: { tokenId: id, name, scopes } });
    const [row] = await sql<TokenRow[]>`${selectRows()} WHERE t.id = ${id}`;
    return { token, item: toItem(row) };
  }

  /** The tokens that are not revoked: of the user, or of every user with `all` for a user manager. */
  async function list(user: PublicUser, options: { all?: boolean } = {}): Promise<ApiTokenItem[]> {
    const all = options.all === true && can(user, 'users.manage');
    const rows = await sql<TokenRow[]>`
      ${selectRows()}
      WHERE t.revoked_at IS NULL ${all ? sql`` : sql`AND t.user_id = ${user.id}`}
      ORDER BY t.created_at DESC
    `;
    return rows.map(toItem);
  }

  /** A user revokes its own tokens. A user manager revokes any token. */
  async function revoke(user: PublicUser, id: string): Promise<void> {
    if (!isUuid(id)) throw notFound('Jeton introuvable.');
    const [row] = await sql<{ user_id: string }[]>`
      UPDATE genga_api_tokens SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL
        ${can(user, 'users.manage') ? sql`` : sql`AND user_id = ${user.id}`}
      RETURNING user_id
    `;
    if (!row) throw notFound('Jeton introuvable.');
    await audit(ctx, user.id, 'token.revoke', { detail: { tokenId: id, ownerId: row.user_id } });
  }

  /**
   * Reads `Authorization: Bearer gga_…`. Returns null when the header is missing or the token
   * is not valid: unknown, revoked, expired, or of a disabled user. Throws a 429 after too many
   * bad tokens from one address.
   */
  async function authenticate(request: Request): Promise<TokenAuth | null> {
    const token = bearerToken(request);
    if (token === null) return null;
    // Without a known address, all clients share one key: a limit on it would lock out every client.
    const ip = clientIp(request, ctx.trustedProxies);
    const limited = ip !== 'unknown';
    if (limited && failures.isLimited(ip)) {
      throw new GengaError(429, 'rate_limited', 'Too many invalid tokens. Wait 15 minutes, then try again.');
    }
    if (!TOKEN_PATTERN.test(token)) {
      if (limited) failures.hit(ip);
      return null;
    }
    const [row] = await sql<(TokenRow & { role: string; user_created_at: Date; disabled_at: Date | null })[]>`
      SELECT t.id, t.name, t.scopes, t.last_used_at, t.user_id,
        u.email, u.name AS user_name, u.role, u.created_at AS user_created_at, u.disabled_at
      FROM genga_api_tokens t JOIN genga_users u ON u.id = t.user_id
      WHERE t.token_hash = ${hashToken(token)} AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL
    `;
    if (!row) {
      if (limited) failures.hit(ip);
      return null;
    }
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > LAST_USED_PRECISION_MS) {
      await sql`UPDATE genga_api_tokens SET last_used_at = now() WHERE id = ${row.id}`;
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
      token: { id: row.id, name: row.name, scopes: row.scopes.filter(isApiScope) },
    };
  }

  function resetRateLimits() {
    failures.clear();
  }

  return { create, list, revoke, authenticate, resetRateLimits };
}

export type GengaApiTokens = ReturnType<typeof createApiTokens>;
