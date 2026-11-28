import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { setAdminPath, adminPath } from '../../client/admin-path';
import { AdminHostContext } from '../host';
import { adminRoutes } from './routes';

const meta = document.querySelector<HTMLMetaElement>('meta[name="genga-admin-path"]');
setAdminPath(meta?.content ?? '/admin');

const router = createBrowserRouter(adminRoutes(adminPath()));
const root = document.getElementById('genga-admin');
if (!root) throw new Error('Genga: the admin page has no #genga-admin element.');

createRoot(root).render(
  <StrictMode>
    <AdminHostContext.Provider value="app">
      <RouterProvider router={router} />
    </AdminHostContext.Provider>
  </StrictMode>,
);
