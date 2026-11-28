import { createContext, useContext } from 'react';

/**
 * Who renders the admin pages: the prebuilt admin app, or the deprecated route modules of a React
 * Router app. The few pages that post a native form read it.
 */
export type AdminHost = 'app' | 'routes';

export const AdminHostContext = createContext<AdminHost>('routes');

export function useAdminHost(): AdminHost {
  return useContext(AdminHostContext);
}
