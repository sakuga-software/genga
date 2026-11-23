import { createGenga, type Genga } from 'genga/server';
import { data } from 'react-router';
import { loadConfigFile } from './config-file';
import { createPublicApi } from './public-api';
import { readSettings, SettingsError, type Settings } from './settings';

export type GengaServer = {
  settings: Settings;
  genga: Genga;
  publicApi: ReturnType<typeof createPublicApi>;
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
    mediaResourcePolicy: 'cross-origin',
    adminEmail: settings.adminEmail,
    secureCookies: settings.publicUrl.startsWith('https:'),
    trustedProxies,
  });
  const publicApi = createPublicApi({
    genga,
    publicUrl: settings.publicUrl,
    corsOrigins: settings.corsOrigins,
    previewOrigins: settings.previewOrigins,
    previewSecret: settings.secret,
    rateLimit: settings.rateLimit,
    trustedProxies,
  });
  genga.ready().catch((error) => console.error('[genga] Start failed:', error));
  return { settings, genga, publicApi };
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
