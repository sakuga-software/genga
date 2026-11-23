import postgres from 'postgres';
import { blockSchemas, type GengaConfig } from '../config';
import { createAdmin } from './admin';
import { createApi } from './api';
import { createAuth } from './auth';
import { PublishedCache } from './cache';
import type { GengaContext, GengaLogger } from './context';
import { createDocuments } from './documents';
import { createMedia } from './media';
import { runMigrations } from '../../migrations/migrate.mjs';
import { originOf } from './origin';
import { createPublished } from './published';
import type { StorageAdapter } from './storage/adapter';
import { localStorageAdapter } from './storage/local';
import { createUsers } from './users';

export type GengaOptions = {
  databaseUrl: string;
  /** Public origin of the site, for example `https://example.com`. */
  siteUrl: string;
  /** Origins allowed to send writes. The origin of `siteUrl` is always allowed. */
  allowedOrigins?: string[];
  /** Directory of the local storage adapter. Ignored when `storage` is set. */
  mediaDir?: string;
  storage?: StorageAdapter;
  /** Email of the first admin, shown in the setup form. */
  adminEmail?: string | null;
  /** `__Host-` cookie with `Secure`. Default: true when NODE_ENV is production. */
  secureCookies?: boolean;
  maxConnections?: number;
  /**
   * Number of proxies in front of the app that append to `X-Forwarded-For`.
   * Default: `GENGA_TRUSTED_PROXIES`, else 1 (one reverse proxy).
   */
  trustedProxies?: number;
  logger?: GengaLogger;
};

function trustedProxiesFromEnv(): number {
  const value = Number(process.env.GENGA_TRUSTED_PROXIES ?? 1);
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

export function createGenga(config: GengaConfig, options: GengaOptions) {
  const sql = postgres(options.databaseUrl, {
    max: options.maxConnections ?? 10,
    onnotice: () => {},
    transform: { undefined: null },
  });
  const siteOrigin = originOf(options.siteUrl);
  const allowedOrigins = [...new Set([...(options.allowedOrigins ?? []), ...(siteOrigin ? [siteOrigin] : [])])];
  const ctx: GengaContext = {
    sql,
    config,
    blocks: blockSchemas(config),
    storage: options.storage ?? localStorageAdapter(options.mediaDir ?? './data/media'),
    cache: new PublishedCache(),
    log: options.logger ?? console,
    siteUrl: options.siteUrl.replace(/\/+$/, ''),
    allowedOrigins,
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production',
    adminEmail: options.adminEmail?.trim().toLowerCase() || null,
    maxUploadBytes: config.media?.maxUploadBytes ?? 20_000_000,
    trustedProxies: options.trustedProxies ?? trustedProxiesFromEnv(),
  };
  const auth = createAuth(ctx);
  const documents = createDocuments(ctx);
  const media = createMedia(ctx);
  const users = createUsers(ctx, auth);
  const published = createPublished(ctx, auth);
  const services = { ctx, auth, documents, media, users };

  let ready: Promise<void> | null = null;

  return {
    config,
    sql,
    auth,
    documents,
    media,
    users,
    published,
    admin: createAdmin(services),
    api: createApi(services),
    /** Runs the migrations once, then logs a setup URL if no user exists. */
    ready(): Promise<void> {
      ready ??= (async () => {
        await runMigrations(sql);
        await auth.ensureSetupToken();
      })().catch((error) => {
        ready = null;
        throw error;
      });
      return ready;
    },
    /** Lets the app add an origin at runtime, for example the dev server origin. */
    allowOrigin(origin: string) {
      if (!ctx.allowedOrigins.includes(origin)) ctx.allowedOrigins.push(origin);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

export type Genga = ReturnType<typeof createGenga>;

export { runMigrations } from '../../migrations/migrate.mjs';
export { GengaError } from './errors';
export { isAllowedOrigin } from './origin';
export { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './auth';
export { localStorageAdapter } from './storage/local';
export type { StorageAdapter } from './storage/adapter';
export { PREVIEW_HEADERS, PREVIEW_PARAM, type RouteResult } from './published';
export { ADMIN_HEADERS } from './api';
export { MEDIA_KEY_PATTERN, ALLOWED_MIME } from './media';
