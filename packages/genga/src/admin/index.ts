/**
 * The admin route components of Genga 0.3, for the route modules of a React Router app.
 * @deprecated Route `<adminPath>/*` to `genga.handle(request)`: it serves the prebuilt admin app.
 * This entry and its `react-router` peer leave at 1.0. See docs/migrate-to-admin-app.md.
 * @module
 */
export { AdminAppLayout } from './pages/app-layout';
export { AdminErrorPage } from './pages/error';
export { CollectionPage } from './pages/collection';
export { DashboardPage } from './pages/dashboard';
export { LoginPage } from './pages/login';
export { MediaPage } from './pages/media';
export { OAuthConsentPage } from './pages/oauth-consent';
export { SetupPage } from './pages/setup';
export { TokensPage } from './pages/tokens';
export { UsersPage } from './pages/users';
export { DocumentPage } from './editor/document-page';
export { AppShell, useAdminLayout, type AppShellProps } from './shell/app-shell';
export { adminPath, setAdminPath } from '../client/admin-path';
