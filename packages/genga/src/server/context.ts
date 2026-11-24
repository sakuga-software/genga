import type { Sql } from 'postgres';
import type { GengaConfig } from '../config';
import type { BlockSchemas } from '../fields/schema';
import type { PublishedCache } from './cache';
import type { StorageAdapter } from './storage/adapter';

export type GengaLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export type GengaContext = {
  sql: Sql;
  config: GengaConfig;
  blocks: BlockSchemas;
  storage: StorageAdapter;
  cache: PublishedCache;
  log: GengaLogger;
  siteUrl: string;
  /** Base path of the admin, for example `/admin`. The admin API is under `<adminPath>/api`. */
  adminPath: string;
  /** Base path of the media files, for example `/media`. */
  mediaPath: string;
  siteLink: string | null;
  allowedOrigins: string[];
  /** Origins of preview pages on another origin. They never get write access. */
  previewOrigins: string[];
  /** HMAC secret of the preview tokens. */
  previewSecret: string | null;
  /** `Cross-Origin-Resource-Policy` of `<mediaPath>/*`. */
  mediaResourcePolicy: 'same-origin' | 'same-site' | 'cross-origin';
  secureCookies: boolean;
  adminEmail: string | null;
  maxUploadBytes: number;
  /** Number of proxies in front of the app that append to `X-Forwarded-For`. */
  trustedProxies: number;
};
