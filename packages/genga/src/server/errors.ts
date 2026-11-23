export class GengaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GengaError';
  }
}

export const notFound = (message = 'Introuvable.') => new GengaError(404, 'not_found', message);
export const forbidden = (message = 'Action non autorisée.') => new GengaError(403, 'forbidden', message);
export const badRequest = (message: string, details?: unknown) => new GengaError(400, 'bad_request', message, details);

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
