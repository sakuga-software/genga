import { DocumentPage } from 'genga/admin';
import { requireGenga } from '../../.server/genga';
import type { Route } from './+types/document';

export async function loader({ request, params }: Route.LoaderArgs) {
  return (await requireGenga()).admin.document(request, params.id);
}

export default DocumentPage;
