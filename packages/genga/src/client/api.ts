export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Calls the Genga admin API. Same-origin `fetch` sends the `Origin` header the server checks. */
export async function apiRequest<T>(
  path: string,
  init: { method?: string; json?: unknown; body?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let response: Response;
  try {
    response = await fetch(`/admin/api/${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'Connexion perdue. Vérifiez votre réseau.', null);
  }
  const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string; details?: unknown };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.error ?? 'error',
      payload.message ?? `Erreur ${response.status}`,
      payload.details ?? null,
    );
  }
  return payload as T;
}
