export const DEFAULT_ADMIN_PATH = '/admin';

/**
 * Checks an admin base path and removes the trailing slash.
 * The path has one or more segments of `a-z`, `0-9`, `-` and `_`, for example `/admin` or `/cms/admin`.
 */
export function normalizeAdminPath(value: string | null | undefined): string {
  const path = (value ?? '').trim().replace(/\/+$/, '');
  if (!path) return DEFAULT_ADMIN_PATH;
  if (!/^(\/[a-z0-9_-]+)+$/i.test(path)) {
    throw new Error(`Genga: the admin path "${value}" is not valid. Use a path like "/admin".`);
  }
  return path;
}

/** True when `pathname` is the admin path or a path below it. */
export function isUnderPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}
