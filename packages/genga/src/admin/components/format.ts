const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

export function formatDateTime(value: string | null | undefined) {
  return value ? dateTime.format(new Date(value)) : '—';
}

export function formatDate(value: string | null | undefined) {
  return value ? dateOnly.format(new Date(value)) : '—';
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} o`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} Ko`;
  return `${(size / 1024 / 1024).toFixed(1)} Mo`;
}
