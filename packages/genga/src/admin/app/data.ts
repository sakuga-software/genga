import { data, redirect } from 'react-router';
import { adminPath } from '../../client/admin-path';

const NETWORK_ERROR = 'Connexion perdue. Vérifiez votre réseau.';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${adminPath()}/api/${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw data({ message: NETWORK_ERROR }, { status: 503 });
  }
}

async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' ? body.message : `Erreur ${response.status}`;
}

function loginUrl(request: Request): string {
  const url = new URL(request.url);
  return `${adminPath('/login')}?next=${encodeURIComponent(url.pathname + url.search)}`;
}

/**
 * Reads the data of a screen for a client loader. Without a session, the router opens the login
 * page. Any other error goes to the error page of the admin, with the message of the server.
 */
export async function load<T>(request: Request, path: string): Promise<T> {
  const response = await call(path, { signal: request.signal });
  if (response.status === 401) throw redirect(loginUrl(request));
  if (!response.ok) throw data({ message: await messageOf(response) }, { status: response.status });
  return (await response.json()) as T;
}

/**
 * Sends a form of the admin app as JSON. An error of the server becomes the message of the form.
 * With `session`, a 401 opens the login page. Without it, a 401 is a form error, for example a wrong password.
 */
export async function send<T>(
  request: Request,
  path: string,
  body: unknown,
  { session = false }: { session?: boolean } = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string; status: number }> {
  let response: Response;
  try {
    response = await call(path, { method: 'POST', body: JSON.stringify(body), signal: request.signal });
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 503 };
  }
  if (session && response.status === 401) throw redirect(loginUrl(request));
  if (!response.ok) return { ok: false, error: await messageOf(response), status: response.status };
  return { ok: true, value: (await response.json()) as T };
}
