import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { originOf } from './origin';
import type { GengaContext } from './context';

/** The file that the build of the admin app writes next to its assets. */
export const ADMIN_MANIFEST = 'genga-admin.json';
export const ADMIN_ASSETS_SEGMENT = '_app';

type Manifest = { script: string; style: string };

type Assets = {
  dir: string;
  manifest: Manifest;
  files: Map<string, string>;
  bodies: Map<string, Uint8Array<ArrayBuffer>>;
};

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Where the assets can be: next to the built entry, in the package of the app, or in the source tree. */
function candidateDirs(configured: string | undefined): string[] {
  if (configured) return [configured];
  const dirs: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(path.join(here, 'admin-app'), path.join(here, '../../dist/admin-app'));
    // A bundler that copies genga into the server build moves `import.meta.url`: the package stays.
    const pkg = createRequire(import.meta.url).resolve('genga/package.json');
    dirs.push(path.join(path.dirname(pkg), 'dist/admin-app'));
  } catch {
    // genga is not resolvable from here, for example in the tests of the package.
  }
  return dirs;
}

function loadAssets(dir: string): Assets | null {
  const manifestPath = path.join(dir, ADMIN_MANIFEST);
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const type = TYPES[path.extname(name)];
    if (type && name !== ADMIN_MANIFEST) files.set(name, type);
  }
  return { dir, manifest, files, bodies: new Map() };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The Content Security Policy of the admin pages. The admin app has no inline script and no
 * inline style element: React sets styles through the CSSOM, which `style-src` does not block.
 * No site can frame the admin: a move inside the app keeps the policy of the first page, so the
 * consent page cannot have a policy of its own.
 */
export function adminCsp(ctx: GengaContext): string {
  const images = new Set(["'self'", 'data:', 'blob:']);
  const base = ctx.storage.publicBaseUrl ? originOf(ctx.storage.publicBaseUrl) : null;
  if (base) images.add(base);
  for (const origin of ctx.storage.deliveryOrigins ?? []) images.add(origin);
  // A custom adapter with signed URLs and no `deliveryOrigins`: the redirect can go to any HTTPS host.
  if (ctx.storage.signedUrl && !ctx.storage.deliveryOrigins?.length) images.add('https:');
  const frames = new Set(["'self'", ...ctx.previewOrigins]);
  const site = originOf(ctx.siteUrl);
  if (site) frames.add(site);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${[...images].join(' ')}`,
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${[...frames].join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Serves the prebuilt admin app: its HTML shell under `<adminPath>`, its assets under `<adminPath>/_app/`. */
export function createAdminApp(ctx: GengaContext, assetsDir?: string) {
  let assets: Assets | null = null;
  let reported = false;
  const assetsPath = `${ctx.adminPath}/${ADMIN_ASSETS_SEGMENT}`;

  /** Finds the build at the first request. A missing build is looked up again at the next request. */
  function getAssets(): Assets | null {
    if (assets) return assets;
    for (const dir of candidateDirs(assetsDir)) {
      assets = loadAssets(dir);
      if (assets) return assets;
    }
    if (!reported) {
      reported = true;
      ctx.log.error('[genga] The admin app is missing: no genga-admin.json in dist/admin-app of the genga package.');
    }
    return null;
  }

  function shell(found: Assets): Response {
    // The id of the stylesheet link stops React Aria from adding a <style> element (see admin.css).
    const admin = escapeAttribute(ctx.adminPath);
    const html = `<!doctype html>
<html lang="fr" class="dark" data-theme="dark" data-genga-admin>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="genga-admin-path" content="${admin}">
<title>Genga</title>
<link rel="stylesheet" id="react-aria-pressable-style" href="${admin}/${ADMIN_ASSETS_SEGMENT}/${escapeAttribute(found.manifest.style)}">
<script type="module" src="${admin}/${ADMIN_ASSETS_SEGMENT}/${escapeAttribute(found.manifest.script)}"></script>
</head>
<body>
<div id="genga-admin"><p class="genga-boot" role="status">Chargement…</p></div>
</body>
</html>
`;
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': adminCsp(ctx),
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
      },
    });
  }

  function asset(found: Assets, name: string, method: string): Response {
    const type = found.files.get(name);
    if (!type) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    let body = found.bodies.get(name);
    if (!body) {
      body = new Uint8Array(readFileSync(path.join(found.dir, name)));
      found.bodies.set(name, body);
    }
    return new Response(method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return function serve(request: Request, pathname: string): Response {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const found = getAssets();
    if (!found) {
      return new Response('The admin app is not built.', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (pathname.startsWith(`${assetsPath}/`)) return asset(found, pathname.slice(assetsPath.length + 1), method);
    if (pathname === assetsPath) return new Response('Not found', { status: 404 });
    const response = shell(found);
    return method === 'HEAD' ? new Response(null, response) : response;
  };
}
