export const DEFAULT_ADMIN_PATH = '/admin';
export const DEFAULT_MEDIA_PATH = '/media';

/**
 * Checks a base path and removes the trailing slash.
 * The path has one or more segments of `a-z`, `0-9`, `-` and `_`, for example `/admin` or `/cms/admin`.
 */
export function normalizeBasePath(value: string | null | undefined, fallback: string, name = 'path'): string {
  const path = (value ?? '').trim().replace(/\/+$/, '');
  if (!path) return fallback;
  if (!/^(\/[a-z0-9_-]+)+$/i.test(path)) {
    throw new Error(`Genga: the ${name} "${value}" is not valid. Use a path like "${fallback}".`);
  }
  return path;
}

/** Checks an admin base path and removes the trailing slash. */
export function normalizeAdminPath(value: string | null | undefined): string {
  return normalizeBasePath(value, DEFAULT_ADMIN_PATH, 'admin path');
}

/** True when `pathname` is the admin path or a path below it. */
export function isUnderPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}
