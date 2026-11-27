import { createGenga, s3StorageAdapter, type Genga } from 'genga/server';
import { data } from 'react-router';
import { loadConfigFile } from './config-file';
import { readSettings, SettingsError, type Settings } from './settings';

export type GengaServer = {
  settings: Settings;
  genga: Genga;
};

function startGenga(...args: Parameters<typeof createGenga>): Genga {
  try {
    return createGenga(...args);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Genga: ')) {
      throw new SettingsError([error.message.slice('Genga: '.length)]);
    }
    throw error;
  }
}

async function boot(): Promise<GengaServer> {
  const settings = readSettings();
  const config = await loadConfigFile(settings.configPath);
  // This server appends the socket address to X-Forwarded-For, so it counts as one more proxy.
  const trustedProxies = settings.trustedProxies + 1;
  const genga = startGenga(config, {
    databaseUrl: settings.databaseUrl,
    siteUrl: settings.publicUrl,
    adminPath: settings.adminPath,
    siteLink: settings.siteUrl,
    allowedOrigins: settings.allowedOrigins,
    previewOrigins: settings.previewOrigins,
    previewSecret: settings.secret,
    mediaDir: settings.mediaDir,
    storage: settings.s3 ? s3StorageAdapter(settings.s3) : undefined,
    mediaResourcePolicy: 'cross-origin',
    adminEmail: settings.adminEmail,
    secureCookies: settings.publicUrl.startsWith('https:'),
    trustedProxies,
    publicApi: { corsOrigins: settings.corsOrigins, rateLimit: settings.rateLimit },
    mcp: settings.mcp.enabled
      ? {
          path: settings.mcp.path,
          oauth: settings.mcp.oauth ? {} : false,
          ...(settings.mcp.uploadPorts && { uploadPorts: settings.mcp.uploadPorts }),
        }
      : false,
  });
  genga.ready().catch((error) => console.error('[genga] Start failed:', error));
  return { settings, genga };
}

const store = globalThis as typeof globalThis & { __gengaServer?: Promise<GengaServer> };

// In development, Vite reloads modules, and the global keeps one database pool.
store.__gengaServer ??= boot();
// A bad setting or config stops the process at start, before the server listens.
await store.__gengaServer;

export function getServer(): Promise<GengaServer> {
  return store.__gengaServer as Promise<GengaServer>;
}

/** For admin routes: checks the admin path segment and waits for the migrations. */
export async function requireAdmin(params: { admin?: string }): Promise<Genga> {
  const { genga, settings } = await getServer();
  if (`/${params.admin ?? ''}` !== settings.adminPath) {
    throw data({ message: 'Introuvable.' }, { status: 404 });
  }
  try {
    await genga.ready();
  } catch {
    throw data({ message: 'Le CMS ne joint pas sa base de données.' }, { status: 503 });
  }
  return genga;
}

/**
 * For the resource routes of the Genga paths. The root middleware answers them first; these
 * routes give React Router a match, so it does not render its 404 page.
 */
export async function handleOrNotFound(request: Request): Promise<Response> {
  const response = await (await getServer()).genga.handle(request);
  return response ?? new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
