import { isRouteErrorResponse, useRouteError } from 'react-router';
import { adminPath } from '../../client/admin-path';

const TITLES: Record<number, string> = { 503: 'CMS indisponible', 404: 'Introuvable', 403: 'Accès refusé' };

export function AdminErrorPage() {
  const error = useRouteError();
  let status = 500;
  let message = 'Une erreur inattendue est survenue.';
  if (isRouteErrorResponse(error)) {
    status = error.status;
    const payload = error.data as { message?: string } | string | null;
    message =
      (typeof payload === 'object' && payload?.message) ||
      (typeof payload === 'string' && payload) ||
      error.statusText ||
      message;
  }
  const title = TITLES[status] ?? 'Erreur';
  return (
    <main className="min-h-[60dvh] grid place-items-center px-4 py-16">
      <div className="max-w-md text-center">
        <p className="genga-mono text-sm text-[var(--genga-coral)]">{status}</p>
        <h1 className="genga-display text-3xl font-semibold mt-2">{title}</h1>
        <p className="mt-3 text-[var(--muted)]">{message}</p>
        <a href={adminPath()} className="mt-6 inline-block text-sm text-[var(--link)] underline underline-offset-4">
          Retour au tableau de bord
        </a>
      </div>
    </main>
  );
}
