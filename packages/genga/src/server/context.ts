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
  allowedOrigins: string[];
  secureCookies: boolean;
  adminEmail: string | null;
  maxUploadBytes: number;
  /** Number of proxies in front of the app that append to `X-Forwarded-For`. */
  trustedProxies: number;
};
