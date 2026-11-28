import { data, redirect, type RouteObject } from 'react-router';
import type {
  AppLayoutData,
  CollectionPageData,
  DashboardData,
  DocumentPageData,
  FormResult,
  LoginPageData,
  MediaPageData,
  OAuthConsentPageData,
  SetupPageData,
  TokensPageData,
  UsersPageData,
} from '../../types';
import { AdminAppLayout } from '../pages/app-layout';
import { CollectionPage } from '../pages/collection';
import { DashboardPage } from '../pages/dashboard';
import { AdminErrorPage } from '../pages/error';
import { LoginPage } from '../pages/login';
import { MediaPage } from '../pages/media';
import { OAuthConsentPage } from '../pages/oauth-consent';
import { SetupPage } from '../pages/setup';
import { TokensPage } from '../pages/tokens';
import { UsersPage } from '../pages/users';
import { load, send } from './data';

type Signed = { location: string };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

const RELOADED = 'genga-admin-reloaded';

/**
 * Loads a chunk of the admin app. After a deploy, the chunk of an open tab no longer exists: the
 * page then reloads once to get the new build.
 */
async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    const chunk = await load();
    remember(false);
    return chunk;
  } catch (error) {
    if (!remember(true)) throw error;
    window.location.reload();
    return new Promise<T>(() => {});
  }
}

/** Records the reload in the session of the tab. Returns false when the tab already reloaded, or has no storage. */
function remember(reloading: boolean): boolean {
  try {
    if (!reloading) {
      sessionStorage.removeItem(RELOADED);
      return true;
    }
    if (sessionStorage.getItem(RELOADED)) return false;
    sessionStorage.setItem(RELOADED, '1');
    return true;
  } catch {
    return false;
  }
}

function Loading() {
  return (
    <p className="genga-boot" role="status">
      Chargement…
    </p>
  );
}

/**
 * The routes of the admin app under `adminPath`. Each loader reads one screen of the admin API, in
 * the shape of the loader of the deprecated route module, so the pages stay the same.
 */
export function adminRoutes(adminPath: string): RouteObject[] {
  return [
    {
      path: adminPath,
      ErrorBoundary: AdminErrorPage,
      HydrateFallback: Loading,
      children: [
        {
          path: 'login',
          Component: LoginPage,
          loader: async ({ request }) => {
            const next = new URL(request.url).searchParams.get('next');
            const query = next ? `?next=${encodeURIComponent(next)}` : '';
            const { signedIn, ...page } = await load<LoginPageData & { signedIn: boolean }>(request, `session${query}`);
            if (signedIn) throw redirect(page.next);
            return page;
          },
          action: async ({ request }): Promise<FormResult | Response> => {
            const form = await request.formData();
            const result = await send<Signed>(request, 'session', {
              email: text(form, 'email'),
              password: text(form, 'password'),
              next: text(form, 'next'),
            });
            return result.ok ? redirect(result.value.location) : { error: result.error };
          },
        },
        {
          path: 'setup',
          Component: SetupPage,
          loader: ({ request }) => {
            const token = new URL(request.url).searchParams.get('token') ?? '';
            return load<SetupPageData>(request, `setup?token=${encodeURIComponent(token)}`);
          },
          action: async ({ request }): Promise<FormResult | Response> => {
            const form = await request.formData();
            const result = await send<Signed>(request, 'setup', {
              token: text(form, 'token'),
              name: text(form, 'name'),
              email: text(form, 'email'),
              password: text(form, 'password'),
              confirm: text(form, 'confirm'),
            });
            return result.ok ? redirect(result.value.location) : { error: result.error };
          },
        },
        {
          path: 'oauth/authorize',
          Component: OAuthConsentPage,
          loader: ({ request }) => {
            // The CSP forbids frames. This check also covers a browser without CSP.
            if (window.top !== window.self)
              throw data({ message: 'Cette page ne s’ouvre pas dans un cadre.' }, { status: 403 });
            return load<OAuthConsentPageData>(request, `consent${new URL(request.url).search}`);
          },
          action: async ({ request }) => {
            const form = await request.formData();
            const result = await send<{ location: string } | { page: OAuthConsentPageData }>(
              request,
              `consent${new URL(request.url).search}`,
              { decision: form.get('decision'), scopes: form.getAll('scope') },
              { session: true },
            );
            if (!result.ok) throw data({ message: result.error }, { status: result.status });
            if ('page' in result.value) return result.value.page;
            // The client URL can have a private-use scheme: only a full navigation opens it.
            window.location.assign(result.value.location);
            return null;
          },
        },
        {
          id: 'app',
          Component: AdminAppLayout,
          loader: ({ request }) => load<AppLayoutData>(request, 'views/layout'),
          children: [
            {
              index: true,
              Component: DashboardPage,
              loader: ({ request }) => load<DashboardData>(request, 'views/dashboard'),
            },
            {
              path: 'collections/:collection',
              Component: CollectionPage,
              loader: ({ request, params }) => {
                const search = new URL(request.url).search;
                const name = encodeURIComponent(params.collection ?? '');
                return load<CollectionPageData>(request, `views/collection/${name}${search}`);
              },
            },
            {
              path: 'collections/:collection/:id',
              lazy: async () => ({
                Component: (await loadChunk(() => import('../editor/document-page'))).DocumentPage,
              }),
              loader: ({ request, params }) =>
                load<DocumentPageData>(request, `views/document/${encodeURIComponent(params.id ?? '')}`),
            },
            {
              path: 'media',
              Component: MediaPage,
              loader: ({ request }) => load<MediaPageData>(request, 'views/media'),
            },
            {
              path: 'users',
              Component: UsersPage,
              loader: ({ request }) => load<UsersPageData>(request, 'views/users'),
            },
            {
              path: 'tokens',
              Component: TokensPage,
              loader: ({ request }) => load<TokensPageData>(request, 'views/tokens'),
            },
            {
              path: '*',
              loader: () => {
                throw data({ message: 'Cette page n’existe pas.' }, { status: 404 });
              },
            },
          ],
        },
      ],
    },
  ];
}
