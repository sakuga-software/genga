import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { isRole, type Role } from '../access';
import type { PublicUser } from '../types';
import type { GengaContext } from './context';
import { badRequest, GengaError } from './errors';
import { RateLimiter } from './rate-limit';

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60_000;
const REFRESH_AFTER_MS = 60 * 60_000;
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD_LENGTH = 12;

const LOGIN_WINDOW_MS = 15 * 60_000;
/** Failures of one email from one address before a 429. */
const PAIR_FAILURES = 5;
/**
 * Failures of one email from all addresses in one hour before a 429. This value is
 * high on purpose: a low value lets an attacker lock the real user out.
 */
const EMAIL_FAILURES_CEILING = 1_000;
const DELAY_AFTER_FAILURES = 5;
const MAX_DELAY_MS = 4_000;

/** After 5 failures of one email, each attempt waits: 250 ms, 500 ms, 1 s, … up to 4 s. */
export function loginDelayMs(failures: number): number {
  if (failures < DELAY_AFTER_FAILURES) return 0;
  return Math.min(250 * 2 ** (failures - DELAY_AFTER_FAILURES), MAX_DELAY_MS);
}

export type SessionUser = PublicUser & { sessionId: string };

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: Date;
  disabled_at: Date | null;
};

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: isRole(row.role) ? row.role : 'author',
    disabled: row.disabled_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

function scryptAsync(password: string, salt: Buffer, keylen: number, options: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: options.N, r: options.r, p: options.p }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, saltText, keyText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const options = { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length };
  const actual = await scryptAsync(
    password.normalize('NFKC'),
    Buffer.from(saltText, 'base64url'),
    expected.length,
    options,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to compare against when the email is unknown, so both paths take the same time. */
let dummyHash: Promise<string> | null = null;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function checkPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  if (password.length > 256) throw badRequest('Le mot de passe est trop long.');
  return password;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try {
      cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      continue;
    }
  }
  return cookies;
}

/**
 * The client address. Each trusted proxy appends one address to `X-Forwarded-For`,
 * so the client is the value at position `trustedProxies` from the right.
 * The values on its left come from the client and can be false.
 */
const PEER_HOPS = new WeakSet<Request>();

/** Marks a request whose last `X-Forwarded-For` hop is the TCP peer that `genga.handle` appended. */
export function markPeerHop(request: Request): Request {
  PEER_HOPS.add(request);
  return request;
}

/** The client address of a request, with the peer hop of `genga.handle` counted as one more proxy. */
export function clientAddress(request: Request, trustedProxies: number): string {
  return clientIp(request, trustedProxies + (PEER_HOPS.has(request) ? 1 : 0));
}

export function clientIp(request: Request, trustedProxies = 1): string {
  if (trustedProxies < 1) return 'unknown';
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!hops.length) return 'unknown';
  return hops[Math.max(0, hops.length - trustedProxies)];
}

function sleep(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function rateLimited() {
  return new GengaError(429, 'rate_limited', 'Trop de tentatives. Réessayez dans quelques minutes.');
}

export function createAuth(ctx: GengaContext) {
  const cookieName = ctx.secureCookies ? '__Host-genga' : 'genga';
  const ipLimiter = new RateLimiter(20, LOGIN_WINDOW_MS);
  const pairLimiter = new RateLimiter(PAIR_FAILURES, LOGIN_WINDOW_MS);
  const emailLimiter = new RateLimiter(EMAIL_FAILURES_CEILING, 60 * 60_000);
  const setupLimiter = new RateLimiter(10, LOGIN_WINDOW_MS);

  function sessionCookie(token: string) {
    const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_MAX_AGE_S}`];
    if (ctx.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function clearCookie() {
    const parts = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (ctx.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  async function createSession(userId: string, request: Request, sql: Sql | TransactionSql = ctx.sql): Promise<string> {
    const token = newToken();
    const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? null;
    await sql`
      INSERT INTO genga_sessions (user_id, token_hash, expires_at, user_agent)
      VALUES (${userId}, ${hashToken(token)}, ${new Date(Date.now() + SESSION_MS)}, ${userAgent})
    `;
    return sessionCookie(token);
  }

  async function getUser(request: Request): Promise<SessionUser | null> {
    const token = parseCookies(request.headers.get('cookie')).get(cookieName);
    if (!token) return null;
    const [row] = await ctx.sql<(UserRow & { session_id: string; refreshed_at: Date })[]>`
      SELECT u.id, u.email, u.name, u.role, u.created_at, u.disabled_at, s.id AS session_id, s.refreshed_at
      FROM genga_sessions s JOIN genga_users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now() AND u.disabled_at IS NULL
    `;
    if (!row) return null;
    if (Date.now() - row.refreshed_at.getTime() > REFRESH_AFTER_MS) {
      await ctx.sql`
        UPDATE genga_sessions SET expires_at = ${new Date(Date.now() + SESSION_MS)}, refreshed_at = now()
        WHERE id = ${row.session_id}
      `;
    }
    return { ...toPublicUser(row), sessionId: row.session_id };
  }

  async function login(request: Request, emailInput: unknown, password: unknown): Promise<{ cookie: string }> {
    const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
    const ip = clientAddress(request, ctx.trustedProxies);
    const pair = `${email}\u0000${ip}`;
    // Count the attempt as a failure before the first await, so parallel requests see it.
    if (ipLimiter.isLimited(ip) || pairLimiter.isLimited(pair) || emailLimiter.isLimited(email)) throw rateLimited();
    const delay = loginDelayMs(emailLimiter.count(email));
    ipLimiter.hit(ip);
    pairLimiter.hit(pair);
    emailLimiter.hit(email);
    await sleep(delay);
    const [row] = await ctx.sql<(UserRow & { password_hash: string | null })[]>`
      SELECT id, email, name, role, created_at, disabled_at, password_hash
      FROM genga_users WHERE lower(email) = ${email}
    `;
    dummyHash ??= hashPassword('genga-timing-equalizer');
    const valid = await verifyPassword(
      typeof password === 'string' ? password : '',
      row?.password_hash ?? (await dummyHash),
    );
    if (!row || !valid || row.disabled_at || !row.password_hash) {
      throw new GengaError(401, 'invalid_credentials', 'Email ou mot de passe incorrect.');
    }
    pairLimiter.reset(pair);
    emailLimiter.release(email);
    const previous = parseCookies(request.headers.get('cookie')).get(cookieName);
    const cookie = await ctx.sql.begin(async (tx) => {
      if (previous) await tx`DELETE FROM genga_sessions WHERE token_hash = ${hashToken(previous)}`;
      return createSession(row.id, request, tx);
    });
    await audit(ctx, row.id, 'login');
    return { cookie };
  }

  async function logout(request: Request): Promise<string> {
    const token = parseCookies(request.headers.get('cookie')).get(cookieName);
    if (token) await ctx.sql`DELETE FROM genga_sessions WHERE token_hash = ${hashToken(token)}`;
    return clearCookie();
  }

  async function revokeSessions(userId: string) {
    await ctx.sql`DELETE FROM genga_sessions WHERE user_id = ${userId}`;
  }

  async function userCount(): Promise<number> {
    const [row] = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM genga_users WHERE role = 'admin' AND disabled_at IS NULL
    `;
    return row.count;
  }

  /** At boot, with no user, logs a one-time URL that creates the first admin. */
  async function ensureSetupToken(): Promise<string | null> {
    if ((await userCount()) > 0) return null;
    const token = newToken();
    await ctx.sql.begin(async (tx) => {
      await tx`DELETE FROM genga_tokens WHERE kind = 'setup'`;
      await tx`
        INSERT INTO genga_tokens (kind, token_hash, email, expires_at)
        VALUES ('setup', ${hashToken(token)}, ${ctx.adminEmail}, ${new Date(Date.now() + 24 * 60 * 60_000)})
      `;
    });
    const url = `${ctx.siteUrl}${ctx.adminPath}/setup?token=${token}`;
    ctx.log.info(`[genga] No user yet. Create the first admin within 24 hours: ${url}`);
    return token;
  }

  type TokenRow = { id: string; kind: 'setup' | 'invite'; user_id: string | null; email: string | null };

  async function findToken(token: string): Promise<TokenRow | null> {
    const [row] = await ctx.sql<TokenRow[]>`
      SELECT id, kind, user_id, email FROM genga_tokens
      WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
    `;
    return row ?? null;
  }

  async function describeToken(token: string) {
    const row = await findToken(token);
    if (!row) return null;
    let name = '';
    let email = row.email;
    if (row.user_id) {
      const [user] = await ctx.sql<{ email: string; name: string }[]>`
        SELECT email, name FROM genga_users WHERE id = ${row.user_id}
      `;
      email = user?.email ?? email;
      name = user?.name ?? '';
    }
    return { kind: row.kind, email, name };
  }

  /** Sets the password of an invited user, or creates the first admin. Returns a session cookie. */
  async function acceptToken(
    request: Request,
    token: string,
    input: { name?: unknown; email?: unknown; password?: unknown },
  ): Promise<{ cookie: string }> {
    const ip = clientAddress(request, ctx.trustedProxies);
    if (setupLimiter.isLimited(ip)) throw rateLimited();
    setupLimiter.hit(ip);
    const password = checkPassword(input.password);
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
    if (!(await findToken(token))) throw new GengaError(410, 'token_invalid', 'Ce lien a expiré ou a déjà servi.');
    const passwordHash = await hashPassword(password);
    const { userId, cookie } = await ctx.sql.begin(async (tx) => {
      const [row] = await tx<TokenRow[]>`
        SELECT id, kind, user_id, email FROM genga_tokens
        WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
        FOR UPDATE
      `;
      if (!row) throw new GengaError(410, 'token_invalid', 'Ce lien a expiré ou a déjà servi.');
      await tx`UPDATE genga_tokens SET used_at = now() WHERE id = ${row.id}`;
      if (row.kind === 'invite' && row.user_id) {
        await tx`
          UPDATE genga_users SET password_hash = ${passwordHash}, name = COALESCE(NULLIF(${name}, ''), name)
          WHERE id = ${row.user_id}
        `;
        await tx`DELETE FROM genga_sessions WHERE user_id = ${row.user_id}`;
        return { userId: row.user_id, cookie: await createSession(row.user_id, request, tx) };
      }
      const [{ count }] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM genga_users WHERE role = 'admin' AND disabled_at IS NULL
      `;
      if (count > 0) throw new GengaError(410, 'token_invalid', 'Un administrateur existe déjà.');
      const email = (row.email ?? (typeof input.email === 'string' ? input.email : '')).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Adresse email invalide.');
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO genga_users (email, name, password_hash, role)
        VALUES (${email}, ${name}, ${passwordHash}, 'admin') RETURNING id
      `;
      return { userId: user.id, cookie: await createSession(user.id, request, tx) };
    });
    await audit(ctx, userId, 'token.accept');
    return { cookie };
  }

  async function invite(email: string, name: string, role: Role): Promise<{ user: PublicUser; token: string }> {
    const token = newToken();
    const user = await ctx.sql.begin(async (tx) => {
      const [row] = await tx<UserRow[]>`
        INSERT INTO genga_users (email, name, role) VALUES (${email}, ${name}, ${role})
        RETURNING id, email, name, role, created_at, disabled_at
      `;
      await tx`
        INSERT INTO genga_tokens (kind, token_hash, user_id, expires_at)
        VALUES ('invite', ${hashToken(token)}, ${row.id}, ${new Date(Date.now() + 7 * 24 * 60 * 60_000)})
      `;
      return row;
    });
    return { user: toPublicUser(user), token };
  }

  async function resetLink(userId: string): Promise<string> {
    const token = newToken();
    await ctx.sql.begin(async (tx) => {
      await tx`DELETE FROM genga_tokens WHERE user_id = ${userId} AND used_at IS NULL`;
      await tx`
        INSERT INTO genga_tokens (kind, token_hash, user_id, expires_at)
        VALUES ('invite', ${hashToken(token)}, ${userId}, ${new Date(Date.now() + 7 * 24 * 60 * 60_000)})
      `;
    });
    return token;
  }

  function resetRateLimits() {
    for (const limiter of [ipLimiter, pairLimiter, emailLimiter, setupLimiter]) limiter.clear();
  }

  return {
    cookieName,
    resetRateLimits,
    getUser,
    login,
    logout,
    revokeSessions,
    userCount,
    ensureSetupToken,
    describeToken,
    acceptToken,
    invite,
    resetLink,
    createSession,
  };
}

export type GengaAuth = ReturnType<typeof createAuth>;

/** Where a write comes from, for example `{ via: 'mcp', tokenId }`. */
export type AuditSource = { via: string; tokenId?: string; grantId?: string; clientId?: string };

const auditSource = new AsyncLocalStorage<AuditSource>();

/** Runs `task`, and adds `source` to the detail of each audit entry that it writes. */
export function withAuditSource<T>(source: AuditSource, task: () => Promise<T>): Promise<T> {
  return auditSource.run(source, task);
}

export async function audit(
  ctx: GengaContext,
  userId: string | null,
  action: string,
  target: { collection?: string; documentId?: string; detail?: Record<string, unknown> } = {},
) {
  const detail = { ...target.detail, ...auditSource.getStore() };
  await ctx.sql`
    INSERT INTO genga_audit (user_id, action, collection, document_id, detail)
    VALUES (${userId}, ${action}, ${target.collection ?? null}, ${target.documentId ?? null},
      ${ctx.sql.json(detail as never)})
  `;
}
