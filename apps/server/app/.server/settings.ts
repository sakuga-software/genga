import { existsSync } from 'node:fs';
import { MIN_SECRET_LENGTH, parseOrigins } from 'genga/server';

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
  /** The MCP endpoint: on by default at `/mcp`. `uploadPorts` is null for the default of genga. */
  mcp: { enabled: boolean; path: string; uploadPorts: number[] | null };
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
  if (!parts.length || parsed.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    problems.push(`${name} must be a comma-separated list of ports from 1 to 65535, not "${value}".`);
    return null;
  }
  return parsed;
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
      uploadPorts: ports(env.GENGA_MCP_UPLOAD_PORTS, 'GENGA_MCP_UPLOAD_PORTS', problems),
    },
  };
  if (problems.length) throw new SettingsError(problems);
  return settings;
}
