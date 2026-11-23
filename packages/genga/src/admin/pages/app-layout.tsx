import { Outlet, useLoaderData } from 'react-router';
import type { AppLayoutData } from '../../types';
import { AppShell } from '../shell/app-shell';

export function AdminAppLayout() {
  const data = useLoaderData() as AppLayoutData;
  return (
    <AppShell data={data}>
      <Outlet />
    </AppShell>
  );
}
