import { previewRoute } from '@genga-cms/next';
import { genga } from '@/lib/genga';

export const { GET, POST, DELETE } = previewRoute(genga);
