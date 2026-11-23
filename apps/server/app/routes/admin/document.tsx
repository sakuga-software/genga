import { DocumentPage } from 'genga/admin';
import { requireAdmin } from '../../.server/genga';
import type { Route } from './+types/document';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireAdmin(params)).admin.document(request, params.id);
}

export default DocumentPage;
