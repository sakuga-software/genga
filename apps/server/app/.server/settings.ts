import { existsSync } from 'node:fs';
import { MIN_SECRET_LENGTH, parseOrigins, type S3StorageOptions } from 'genga/server';

export type Settings = {
  databaseUrl: string;
  configPath: string;
  mediaDir: string;
  /** Public URL of this server, without a trailing slash. Media URLs and setup links start with it. */
  publicUrl: string;
  /** One path segment, for example `/admin`. */
  adminPath: string;
  allowedOrigins: string[];
  /** Origins that can read the public API from a browser. `*` allows every origin. */
  corsOrigins: string[] | '*';
  previewOrigins: string[];
  /** Proxies in front of this server. The server itself counts as one more hop. */
  trustedProxies: number;
  adminEmail: string | null;
  /** The public site, for the link "Voir le site" of the admin. */
  siteUrl: string | null;
  secret: string | null;
  port: number;
  /** Requests per minute and per client address on the public API. */
  rateLimit: number;
  /**
   * The MCP endpoint: on by default at `/mcp`, with OAuth sign-in for its clients. `uploadPorts`
   * is null for the default of genga.
   */
  mcp: { enabled: boolean; path: string; oauth: boolean; uploadPorts: number[] | null };
  /** The S3 bucket of the media files, or null for the directory `mediaDir`. */
  s3: S3StorageOptions | null;
};

export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(`Genga cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'SettingsError';
  }
}

/** Paths that the server uses for itself. The admin path cannot take one of them. */
export const RESERVED_SEGMENTS = new Set(['api', 'media', 'healthz', 'readyz', 'assets', '__manifest']);

const DEFAULT_CONFIG_PATHS = ['/config/genga.config.json', '/config/genga.config.mjs'];

function integer(value: string | undefined, fallback: number, name: string, problems: string[], min = 0): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    problems.push(`${name} must be an integer of ${min} or more, not "${value}".`);
    return fallback;
  }
  return parsed;
}

function origins(value: string | undefined, name: string, problems: string[]): string[] {
  try {
    return parseOrigins(value, name);
  } catch (error) {
    problems.push((error as Error).message.replace(/^Genga: /, ''));
    return [];
  }
}

function ports(value: string | undefined, name: string, problems: string[]): number[] | null {
  if (value === undefined || value.trim() === '') return null;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = parts.map(Number);
  if (!parts.length || parts.some((part, index) => !/^\d+$/.test(part) || parsed[index] < 1 || parsed[index] > 65535)) {
    problems.push(`${name} must be a comma-separated list of ports from 1 to 65535, not "${value}".`);
    return null;
  }
  return parsed;
}

function signedUrlTtl(value: string | undefined, problems: string[]): number {
  const ttl = integer(value, 3600, 'GENGA_S3_SIGNED_URL_TTL', problems, 60);
  if (ttl <= 604_800) return ttl;
  problems.push('GENGA_S3_SIGNED_URL_TTL must be 604800 seconds (7 days) or less.');
  return 3600;
}

const S3_DELIVERIES = ['proxy', 'public', 'signed'] as const;

/** `GENGA_S3_BUCKET` turns S3 on. The messages never contain a key or a secret. */
function s3Settings(env: NodeJS.ProcessEnv, problems: string[]): S3StorageOptions | null {
  const bucket = env.GENGA_S3_BUCKET?.trim();
  if (!bucket) return null;
  // One source for the whole set: a session token of the AWS_* variables does not fit GENGA_S3_* keys.
  const own = Boolean(env.GENGA_S3_ACCESS_KEY_ID?.trim());
  const accessKeyId = (own ? env.GENGA_S3_ACCESS_KEY_ID : env.AWS_ACCESS_KEY_ID)?.trim() || '';
  const secretAccessKey = (own ? env.GENGA_S3_SECRET_ACCESS_KEY : env.AWS_SECRET_ACCESS_KEY)?.trim() || '';
  const sessionToken = (own ? env.GENGA_S3_SESSION_TOKEN : env.AWS_SESSION_TOKEN)?.trim() || undefined;
  if (!accessKeyId || !secretAccessKey) {
    problems.push('GENGA_S3_ACCESS_KEY_ID and GENGA_S3_SECRET_ACCESS_KEY are required with GENGA_S3_BUCKET.');
  }
  const endpoint = env.GENGA_S3_ENDPOINT?.trim().replace(/\/+$/, '') || undefined;
  if (endpoint && !/^https?:\/\/[^/]+$/.test(endpoint)) {
    problems.push(`GENGA_S3_ENDPOINT must be an origin like https://s3.fr-par.scw.cloud, not "${endpoint}".`);
  }
  const delivery = env.GENGA_S3_DELIVERY?.trim().toLowerCase() || 'proxy';
  if (!(S3_DELIVERIES as readonly string[]).includes(delivery)) {
    problems.push(`GENGA_S3_DELIVERY must be proxy, public or signed, not "${env.GENGA_S3_DELIVERY}".`);
  }
  const publicUrl = env.GENGA_S3_PUBLIC_URL?.trim() || undefined;
  if (delivery === 'public' && !/^https?:\/\/./.test(publicUrl ?? '')) {
    problems.push(
      'GENGA_S3_PUBLIC_URL is required with GENGA_S3_DELIVERY=public, for example https://media.example.com.',
    );
  }
  const pathStyle = env.GENGA_S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  if (pathStyle && !['true', 'false', '1', '0'].includes(pathStyle)) {
    problems.push(`GENGA_S3_FORCE_PATH_STYLE must be true or false, not "${env.GENGA_S3_FORCE_PATH_STYLE}".`);
  }
  return {
    bucket,
    region: env.GENGA_S3_REGION?.trim() || env.AWS_REGION?.trim() || undefined,
    endpoint,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    prefix: env.GENGA_S3_PREFIX?.trim() || undefined,
    forcePathStyle: pathStyle ? ['true', '1'].includes(pathStyle) : undefined,
    delivery: delivery as S3StorageOptions['delivery'],
    publicUrl,
    signedUrlExpiresIn: signedUrlTtl(env.GENGA_S3_SIGNED_URL_TTL, problems),
  };
}

/** Reads and checks the environment. Throws a `SettingsError` that lists every problem. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const problems: string[] = [];

  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is required, for example postgres://genga:secret@postgres:5432/genga.');
  else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must start with postgres://.');

  const port = integer(env.PORT, 3000, 'PORT', problems, 1);

  const configPath = env.GENGA_CONFIG?.trim() || DEFAULT_CONFIG_PATHS.find((path) => existsSync(path)) || '';
  if (!configPath) {
    problems.push('GENGA_CONFIG is required: the path of a genga.config.json or genga.config.mjs file.');
  } else if (!/\.(json|mjs)$/.test(configPath)) {
    problems.push(`GENGA_CONFIG must end with .json or .mjs, not "${configPath}".`);
  } else if (!existsSync(configPath)) {
    problems.push(`GENGA_CONFIG points to ${configPath}, and this file does not exist. Mount it into the container.`);
  }

  let publicUrl = (env.GENGA_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, '');
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    if (url.search || url.hash || url.pathname !== '/') {
      problems.push('GENGA_PUBLIC_URL must be an origin without a path, for example https://cms.example.com.');
    }
    publicUrl = url.origin;
  } catch {
    problems.push(`GENGA_PUBLIC_URL must be a URL like https://cms.example.com, not "${env.GENGA_PUBLIC_URL}".`);
  }

  const adminPath = (env.GENGA_ADMIN_PATH?.trim() || '/admin').replace(/\/+$/, '');
  const segment = adminPath.slice(1);
  if (!/^\/[a-z0-9_-]+$/i.test(adminPath)) {
    problems.push(`GENGA_ADMIN_PATH must be one path segment like /admin, not "${env.GENGA_ADMIN_PATH}".`);
  } else if (RESERVED_SEGMENTS.has(segment.toLowerCase())) {
    problems.push(`GENGA_ADMIN_PATH cannot be /${segment}: the server uses this path.`);
  }

  const siteUrl = env.GENGA_SITE_URL?.trim() || null;
  if (siteUrl && !/^https?:\/\/[^/]/.test(siteUrl)) {
    problems.push(`GENGA_SITE_URL must be a URL like https://www.example.com, not "${siteUrl}".`);
  }

  const cors = env.GENGA_CORS_ORIGINS?.trim();
  const corsOrigins = cors === '*' ? '*' : origins(cors, 'GENGA_CORS_ORIGINS', problems);

  const secret = env.GENGA_SECRET?.trim() || null;
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    problems.push(`GENGA_SECRET must have at least ${MIN_SECRET_LENGTH} characters. Try: openssl rand -base64 48`);
  }

  const mcpSwitch = env.GENGA_MCP?.trim().toLowerCase() || 'on';
  if (!['on', 'off', 'true', 'false', '1', '0'].includes(mcpSwitch)) {
    problems.push(`GENGA_MCP must be on or off, not "${env.GENGA_MCP}".`);
  }
  const oauthSwitch = env.GENGA_MCP_OAUTH?.trim().toLowerCase() || 'on';
  if (!['on', 'off', 'true', 'false', '1', '0'].includes(oauthSwitch)) {
    problems.push(`GENGA_MCP_OAUTH must be on or off, not "${env.GENGA_MCP_OAUTH}".`);
  }
  const mcpPath = (env.GENGA_MCP_PATH?.trim() || '/mcp').replace(/\/+$/, '');
  if (!/^\/[a-z0-9_-]+$/i.test(mcpPath)) {
    problems.push(`GENGA_MCP_PATH must be one path segment like /mcp, not "${env.GENGA_MCP_PATH}".`);
  } else if (RESERVED_SEGMENTS.has(mcpPath.slice(1).toLowerCase())) {
    problems.push(`GENGA_MCP_PATH cannot be ${mcpPath}: the server uses this path.`);
  } else if (mcpPath.toLowerCase() === adminPath.toLowerCase()) {
    problems.push(`GENGA_MCP_PATH cannot be the admin path ${adminPath}.`);
  }

  const settings: Settings = {
    databaseUrl,
    configPath,
    mediaDir: env.GENGA_MEDIA_DIR?.trim() || '/data/media',
    publicUrl,
    adminPath,
    allowedOrigins: origins(env.GENGA_ALLOWED_ORIGINS, 'GENGA_ALLOWED_ORIGINS', problems),
    corsOrigins,
    previewOrigins: origins(env.GENGA_PREVIEW_ORIGINS, 'GENGA_PREVIEW_ORIGINS', problems),
    trustedProxies: integer(env.GENGA_TRUSTED_PROXIES, 0, 'GENGA_TRUSTED_PROXIES', problems),
    adminEmail: env.GENGA_ADMIN_EMAIL?.trim() || null,
    siteUrl,
    secret,
    port,
    rateLimit: integer(env.GENGA_RATE_LIMIT, 300, 'GENGA_RATE_LIMIT', problems, 1),
    mcp: {
      enabled: !['off', 'false', '0'].includes(mcpSwitch),
      path: mcpPath,
      oauth: !['off', 'false', '0'].includes(oauthSwitch),
      uploadPorts: ports(env.GENGA_MCP_UPLOAD_PORTS, 'GENGA_MCP_UPLOAD_PORTS', problems),
    },
    s3: s3Settings(env, problems),
  };
  if (problems.length) throw new SettingsError(problems);
  return settings;
}
