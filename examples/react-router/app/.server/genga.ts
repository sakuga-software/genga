import { createGenga, type Genga, type RouteResult } from 'genga/server';
import { data, redirect } from 'react-router';
import { gengaConfig } from '../genga.config';

const globalStore = globalThis as typeof globalThis & { __genga?: Genga | null };

function siteUrl(): string {
  return process.env.SITE_URL || 'http://localhost:5173';
}

function allowedOrigins(): string[] {
  const fromEnv = (process.env.GENGA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (process.env.NODE_ENV === 'production') return fromEnv;
  return [...fromEnv, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];
}

function start(): Genga | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const genga = createGenga(gengaConfig, {
    databaseUrl,
    siteUrl: siteUrl(),
    allowedOrigins: allowedOrigins(),
    mediaDir: process.env.GENGA_MEDIA_DIR || './data/media',
    adminEmail: process.env.GENGA_ADMIN_EMAIL ?? null,
  });
  genga.ready().catch((error) => console.error('[genga] Start failed:', error));
  return genga;
}

/** The Genga instance, or `null` when DATABASE_URL is not set (the CMS is off). */
export function getGenga(): Genga | null {
  // In dev, Vite reloads this module. The global keeps one database pool.
  if (globalStore.__genga === undefined) globalStore.__genga = start();
  return globalStore.__genga;
}

/** For admin routes: the ready instance, or a 503 answer when the CMS is off. */
export async function requireGenga(): Promise<Genga> {
  const genga = getGenga();
  if (!genga) {
    throw data(
      { message: 'The CMS is off: DATABASE_URL is not set.' },
      { status: 503, headers: { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } },
    );
  }
  try {
    await genga.ready();
  } catch {
    throw data({ message: 'The CMS cannot reach its database.' }, { status: 503 });
  }
  return genga;
}

/** Turns a Genga route result into the loader answer: data, a 301, or a 404. */
export function documentData<T>(result: RouteResult<T>) {
  if (result.kind === 'redirect') throw redirect(result.location, { status: 301, headers: result.headers });
  if (result.kind === 'not-found') throw data(null, { status: 404, statusText: 'Not Found', headers: result.headers });
  return data({ doc: result.doc, preview: result.preview }, { headers: result.headers });
}
