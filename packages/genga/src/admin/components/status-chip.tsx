import { Chip } from '@heroui/react';
import type { DocumentStatus } from '../../types';

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: 'Brouillon',
  published: 'Publié',
  changed: 'Modifié',
};

const STATUS_COLORS: Record<DocumentStatus, 'default' | 'success' | 'warning'> = {
  draft: 'default',
  published: 'success',
  changed: 'warning',
};

export function StatusChip({ status }: { status: DocumentStatus }) {
  return (
    <Chip size="sm" variant="soft" color={STATUS_COLORS[status]}>
      {STATUS_LABELS[status]}
    </Chip>
  );
}
