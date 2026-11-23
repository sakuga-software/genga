import { redirect } from 'react-router';
import { getServer } from '../.server/genga';

export async function loader() {
  const { settings } = await getServer();
  return redirect(settings.adminPath);
}
