import { FileText } from 'lucide-react';
import type { MediaObject } from '../../fields/types';

export function MediaThumb({ media, className = '' }: { media: MediaObject; className?: string }) {
  if (!media.mime.startsWith('image/')) {
    return (
      <div className={`grid place-items-center bg-[var(--surface-tertiary)] text-[var(--muted)] ${className}`}>
        <FileText aria-hidden className="size-8" />
      </div>
    );
  }
  const small = media.sizes.find((size) => size.width >= 480) ?? media.sizes[0];
  return (
    <img
      src={small?.url ?? media.url}
      alt=""
      loading="lazy"
      className={`object-cover bg-[var(--surface-tertiary)] ${className}`}
    />
  );
}
