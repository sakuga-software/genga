import type { ApiScope } from '../../access';

export const SCOPE_LABELS: Record<ApiScope, { label: string; description: string }> = {
  read: { label: 'Lecture', description: 'Lire les collections, les documents, les versions et les médias.' },
  write: { label: 'Écriture', description: 'Créer et modifier des brouillons, envoyer des médias.' },
  publish: { label: 'Publication', description: 'Publier et dépublier des documents.' },
};
