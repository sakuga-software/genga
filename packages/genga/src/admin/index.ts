/**
 * The admin route components of Genga 0.3, for the route modules of a React Router app.
 * @deprecated Route `<adminPath>/*` to `genga.handle(request)`: it serves the prebuilt admin app.
 * This entry and its `react-router` peer leave at 1.0. See docs/migrate-to-admin-app.md.
 * @module
 */
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { AdminAppLayout } from './pages/app-layout';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { AdminErrorPage } from './pages/error';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { CollectionPage } from './pages/collection';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { DashboardPage } from './pages/dashboard';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { LoginPage } from './pages/login';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { MediaPage } from './pages/media';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { OAuthConsentPage } from './pages/oauth-consent';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { SetupPage } from './pages/setup';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { TokensPage } from './pages/tokens';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { UsersPage } from './pages/users';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { DocumentPage } from './editor/document-page';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { AppShell, useAdminLayout, type AppShellProps } from './shell/app-shell';
/** @deprecated Route `<adminPath>/*` to `genga.handle(request)`. Leaves at 1.0. */
export { adminPath, setAdminPath } from '../client/admin-path';
