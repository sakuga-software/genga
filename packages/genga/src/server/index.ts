import postgres from 'postgres';
import { blockSchemas, type GengaConfig } from '../config';
import { createAdmin } from './admin';
import { createApiTokens } from './api-tokens';
import { createApi } from './api';
import { createAuth } from './auth';
import { PublishedCache } from './cache';
import type { GengaContext, GengaLogger } from './context';
import { createDocuments } from './documents';
import {
  checkWebhooks,
  createEventBus,
  type GengaEvents,
  type WebhookConfig,
  type WebhookDeliveryOptions,
} from './events';
import { createScheduler, type SchedulerOptions } from './schedules';
import { createMcp, type McpOptions } from './mcp';
import { createOAuth } from './oauth';
import { createMedia } from './media';
import { runMigrations } from '../../migrations/migrate.mjs';
import { originOf } from './origin';
import { DEFAULT_MEDIA_PATH, normalizeAdminPath, normalizeBasePath } from '../paths';
import { checkPathCollisions, createHandler } from './handle';
import { createPublicApi, createPublicReads, PUBLIC_API_PATH, type PublicApiOptions } from './public-api';
import { checkPreviewConfig, previewTarget } from './preview';
import { createPublished } from './published';
import { createEmbeddedSource } from './source';
import type { StorageAdapter } from './storage/adapter';
import { localStorageAdapter } from './storage/local';
import { createUsers } from './users';

export type GengaOptions = {
  databaseUrl: string;
  /** Public origin of the site, for example `https://example.com`. */
  siteUrl: string;
  /**
   * Base path of the admin. The admin API is under `<adminPath>/api`.
   * Default: `GENGA_ADMIN_PATH`, else `/admin`.
   */
  adminPath?: string;
  /**
   * Base path of the media files. `genga.handle` serves them, and media URLs start with it.
   * Default: `/media`.
   */
  mediaPath?: string;
  /**
   * The public read API under `/api/v1`, served by `genga.handle`. Off by default: `true` or
   * an object turns it on. The server image turns it on.
   */
  publicApi?: boolean | PublicApiOptions;
  /** The link "Voir le site" of the admin. `null` hides it. Default: `/`. */
  siteLink?: string | null;
  /** Origins allowed to send writes. The origin of `siteUrl` is always allowed. */
  allowedOrigins?: string[];
  /** Directory of the local storage adapter. Ignored when `storage` is set. */
  mediaDir?: string;
  storage?: StorageAdapter;
  /** Email of the first admin, shown in the setup form. */
  adminEmail?: string | null;
  /**
   * Origins of preview pages on another origin (see `previewUrl`).
   * Default: `GENGA_PREVIEW_ORIGINS`. These origins cannot send writes.
   */
  previewOrigins?: string[];
  /** Secret that signs the preview tokens, 32 characters or more. Default: `GENGA_SECRET`. */
  previewSecret?: string | null;
  /**
   * `Cross-Origin-Resource-Policy` of `/media/*`. Use `cross-origin` when sites on other
   * origins show the media. Default: `same-origin`.
   */
  mediaResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin';
  /** `__Host-` cookie with `Secure`. Default: true when NODE_ENV is production. */
  secureCookies?: boolean;
  maxConnections?: number;
  /**
   * Number of proxies in front of the app that append to `X-Forwarded-For`.
   * Default: `GENGA_TRUSTED_PROXIES`, else 1 (one reverse proxy).
   */
  trustedProxies?: number;
  logger?: GengaLogger;
  /**
   * Receivers of the publish events, as signed webhooks (Standard Webhooks). Genga keeps each
   * event in an outbox table and retries for 24 hours. Default: `GENGA_WEBHOOKS`, a JSON array.
   */
  webhooks?: WebhookConfig[];
  /** Options of the webhook sender. */
  webhookDelivery?: WebhookDeliveryOptions;
  /**
   * The runner of scheduled publish and unpublish, on a timer after `ready()`. With several
   * replicas, one runs it at a time. `false` turns the timer off: call `genga.runSchedules()`
   * from a cron job instead.
   */
  scheduler?: false | SchedulerOptions;
  /**
   * The MCP endpoint. Off in `genga.handle` by default: an object turns it on at `path`
   * (default `/mcp`). The deprecated `genga.mcp` handler reads the same options.
   */
  mcp?: false | (McpOptions & { path?: string });
};

/** Reads a comma-separated list of origins. Throws on a value that is not an origin. */
export function parseOrigins(value: string | undefined, name = 'origin list'): string[] {
  const origins: string[] = [];
  for (const part of (value ?? '').split(',')) {
    const item = part.trim().replace(/\/+$/, '');
    if (!item) continue;
    const origin = originOf(item);
    if (!origin || origin !== item)
      throw new Error(`Genga: "${item}" in ${name} is not an origin like https://example.com.`);
    origins.push(origin);
  }
  return [...new Set(origins)];
}

function publicApiOptionsOf(value: GengaOptions['publicApi']): PublicApiOptions | null {
  if (!value) return null;
  return value === true ? {} : value;
}

/** Reads `GENGA_WEBHOOKS`. The error never repeats the value: it holds secrets. */
export function webhooksFromEnv(value = process.env.GENGA_WEBHOOKS): WebhookConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Genga: GENGA_WEBHOOKS must be a JSON array of { "url", "secret", "events" } objects.');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object')) {
    throw new Error('Genga: GENGA_WEBHOOKS must be a JSON array of { "url", "secret", "events" } objects.');
  }
  return parsed as WebhookConfig[];
}

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
  const log = options.logger ?? console;
  const previewSecret =
    (options.previewSecret === undefined ? process.env.GENGA_SECRET : options.previewSecret) || null;
  const webhooks = checkWebhooks(options.webhooks ?? webhooksFromEnv(), previewSecret);
  const events = createEventBus(sql, log, webhooks, options.webhookDelivery);
  const siteOrigin = originOf(options.siteUrl);
  const allowedOrigins = [...new Set([...(options.allowedOrigins ?? []), ...(siteOrigin ? [siteOrigin] : [])])];
  const ctx: GengaContext = {
    sql,
    config,
    blocks: blockSchemas(config),
    storage: options.storage ?? localStorageAdapter(options.mediaDir ?? './data/media'),
    cache: new PublishedCache(),
    events,
    log,
    siteUrl: options.siteUrl.replace(/\/+$/, ''),
    adminPath: normalizeAdminPath(options.adminPath ?? process.env.GENGA_ADMIN_PATH),
    mediaPath: normalizeBasePath(options.mediaPath, DEFAULT_MEDIA_PATH, 'media path'),
    siteLink: options.siteLink === undefined ? '/' : options.siteLink,
    allowedOrigins,
    secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production',
    adminEmail: options.adminEmail?.trim().toLowerCase() || null,
    maxUploadBytes: config.media?.maxUploadBytes ?? 20_000_000,
    trustedProxies: options.trustedProxies ?? trustedProxiesFromEnv(),
    previewOrigins: options.previewOrigins ?? parseOrigins(process.env.GENGA_PREVIEW_ORIGINS, 'GENGA_PREVIEW_ORIGINS'),
    previewSecret,
    mediaResourcePolicy: options.mediaResourcePolicy ?? 'same-origin',
  };
  checkPreviewConfig(ctx);
  const publicApiOptions = publicApiOptionsOf(options.publicApi);
  const mcpOptions = options.mcp || null;
  const mcpPath = mcpOptions ? normalizeBasePath(mcpOptions.path, '/mcp', 'MCP path') : null;
  checkPathCollisions({
    'admin path': ctx.adminPath,
    'media path': ctx.mediaPath,
    'public API path': publicApiOptions ? PUBLIC_API_PATH : null,
    'MCP path': mcpPath,
  });
  const auth = createAuth(ctx);
  const documents = createDocuments(ctx);
  const media = createMedia(ctx);
  const users = createUsers(ctx, auth);
  const published = createPublished(ctx, auth);
  const tokens = createApiTokens(ctx);
  const oauth =
    mcpPath && mcpOptions && mcpOptions.oauth !== false
      ? createOAuth({ ctx, tokens }, mcpPath, mcpOptions.oauth ?? {})
      : null;
  const services = { ctx, auth, documents, media, users, tokens, oauth };
  const reads = createPublicReads({ ctx, published });
  const source = createEmbeddedSource({ ctx, auth, published, reads });
  const api = createApi(services);
  const mcp = createMcp(services, mcpOptions ?? {});
  const scheduler = createScheduler(ctx, documents, options.scheduler || {}, options.maxConnections ?? 10);

  let ready: Promise<void> | null = null;
  function whenReady(): Promise<void> {
    ready ??= (async () => {
      await runMigrations(sql);
      await auth.ensureSetupToken();
      events.start();
      if (options.scheduler !== false) scheduler.start();
    })().catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  }

  const warned = new Set<string>();
  function deprecated<A extends unknown[], R>(name: string, replacement: string, run: (...args: A) => R) {
    return (...args: A): R => {
      if (!warned.has(name)) {
        warned.add(name);
        ctx.log.warn(`[genga] ${name} is deprecated and leaves at 1.0. Use ${replacement}.`);
      }
      return run(...args);
    };
  }

  const handle = createHandler({
    ctx,
    ready: whenReady,
    adminApi: api,
    media: media.serve,
    publicApi: publicApiOptions ? createPublicApi({ ctx, published, media }, reads, publicApiOptions) : null,
    mcp: mcpPath ? { path: mcpPath, handle: mcp } : null,
    oauth,
  });

  return {
    /** The content source of embedded mode: published content in the public shape. */
    mode: source.mode,
    getDocument: source.getDocument,
    listDocuments: source.listDocuments,
    resolveRoute: source.resolveRoute,
    getDraft: source.getDraft,
    sitemap: source.sitemap,
    tagsFor: source.tagsFor,
    config,
    sql,
    /** Base path of the admin, for example `/admin`. */
    adminPath: ctx.adminPath,
    auth,
    documents,
    media: { ...media, serve: deprecated('genga.media.serve', 'genga.handle(request)', media.serve) },
    users,
    published,
    tokens,
    /** The OAuth server of the MCP endpoint. Null when the `mcp` option is off or sets `oauth: false`. */
    oauth,
    /** Base path of the media files, for example `/media`. */
    mediaPath: ctx.mediaPath,
    admin: createAdmin(services),
    /**
     * The one Fetch handler: the admin API, the media files, and when they are on, the public
     * API and the MCP endpoint. It returns null for any other path, so the app answers it.
     * It waits for `ready()` and answers 503 when the database is not reachable.
     */
    handle,
    /** The publish events, in process. Webhooks carry the same events to other processes. */
    events: { on: events.on } satisfies GengaEvents,
    /** Sends the due webhook deliveries now, and waits for them. */
    deliverWebhooks: () => events.drain(),
    /** @deprecated Use `genga.handle(request)`, which serves `<adminPath>/api/*`. Leaves at 1.0. */
    api: deprecated('genga.api', 'genga.handle(request)', api),
    /**
     * The MCP endpoint, a fetch-style handler. Clients send `Authorization: Bearer gga_…`.
     * @deprecated Set the `mcp` option and use `genga.handle(request)`. Leaves at 1.0.
     */
    mcp: deprecated('genga.mcp', 'the mcp option and genga.handle(request)', mcp),
    /** Runs the migrations once, then logs a setup URL if no user exists. */
    ready: whenReady,
    /** The URL of the preview frame of a document, with a fresh preview token on another origin. */
    previewTarget: (collection: string, doc: { id: string; slug: string }) => previewTarget(ctx, collection, doc),
    /** Lets the app add an origin at runtime, for example the dev server origin. */
    allowOrigin(origin: string) {
      if (!ctx.allowedOrigins.includes(origin)) ctx.allowedOrigins.push(origin);
    },
    /** Runs the due scheduled publish and unpublish now. Returns how many ran. */
    runSchedules: () => scheduler.run(),
    async close() {
      await scheduler.stop();
      await events.stop();
      await sql.end({ timeout: 5 });
    },
  };
}

export type Genga = ReturnType<typeof createGenga>;

export { runMigrations } from '../../migrations/migrate.mjs';
export { GengaError } from './errors';
export { isAllowedOrigin } from './origin';
export type { GengaHandler, HandleContext } from './handle';
export type { GengaEventListener, GengaEvents, WebhookConfig, WebhookDeliveryOptions } from './events';
export { tagsFor, type GengaEvent, type GengaEventType } from '../events';
export { signWebhook, verifyWebhook, WebhookVerificationError } from '../webhooks';
export { PUBLIC_API_PATH, type PublicApiOptions } from './public-api';
export {
  GengaSourceError,
  type CacheInfo,
  type DocumentPage,
  type GengaRouteResult,
  type GengaSource,
  type ListQuery,
  type PreviewInput,
  type PublicDocument,
  type SitemapEntry,
} from '../source';
export { clientIp, hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './auth';
export { localStorageAdapter } from './storage/local';
export { s3StorageAdapter, type S3Delivery, type S3StorageOptions } from './storage/s3';
export type { StorageAdapter } from './storage/adapter';
export { PREVIEW_HEADERS, PREVIEW_PARAM, type RouteResult } from './published';
export {
  createPreviewToken,
  verifyPreviewToken,
  MIN_SECRET_LENGTH,
  PREVIEW_TOKEN_PARAM,
  PREVIEW_TOKEN_TTL_MS,
  type PreviewTarget,
} from './preview';
export { ADMIN_HEADERS } from './api';
export { API_TOKEN_PREFIX, type TokenAuth } from './api-tokens';
export { withAuditSource, type AuditSource } from './auth';
export type { McpOptions } from './mcp';
export { OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX, type OAuthOptions } from './oauth';
export type { SchedulerOptions } from './schedules';
export { DEFAULT_ALLOWED_PORTS, fetchRemoteFile, isPublicAddress, type RemoteFetchOptions } from './remote-fetch';
export { MEDIA_KEY_PATTERN, ALLOWED_MIME } from './media';
