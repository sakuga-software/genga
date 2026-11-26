import { OAuthConsentPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/oauth-authorize';

export function headers() {
  return {
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Cache-Control': 'private, no-store',
  };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.oauthAuthorizeLoader(request);
}

export async function action({ request, params }: Route.ActionArgs) {
  return (await requireAdmin(params)).admin.oauthAuthorizeAction(request);
}

export default OAuthConsentPage;
