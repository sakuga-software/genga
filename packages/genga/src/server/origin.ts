const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF check for every request that changes state. The `Origin` header must be on
 * the allow list. Without `Origin`, `Sec-Fetch-Site: same-origin` is accepted.
 * A request with neither header is rejected.
 */
export function isAllowedOrigin(request: Request, allowedOrigins: readonly string[]): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') return allowedOrigins.includes(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
