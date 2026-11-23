import { DEFAULT_ADMIN_PATH, normalizeAdminPath } from '../paths';

let current = DEFAULT_ADMIN_PATH;

/**
 * Sets the base path of the admin in this process. The admin pages call it with the
 * path from their loader data, before their children render.
 */
export function setAdminPath(path: string) {
  current = normalizeAdminPath(path);
}

/** The admin base path, followed by `sub`. For example `adminPath('/media')` gives `/admin/media`. */
export function adminPath(sub = ''): string {
  return `${current}${sub}`;
}
