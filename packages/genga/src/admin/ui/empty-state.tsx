import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
};

/** A dashed frame that tells the user that a list has no item, and what to do next. */
export function EmptyState({ title, description, icon, size = 'md', className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border)] px-6 text-center ${
        size === 'sm' ? 'py-8' : 'py-12'
      } ${className}`}
    >
      {icon && (
        <span
          aria-hidden
          className="grid size-10 place-items-center rounded-full bg-[var(--surface-secondary)] text-[var(--muted)]"
        >
          {icon}
        </span>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="font-medium">{title}</p>
        {description && <p className="text-sm text-[var(--muted)]">{description}</p>}
      </div>
    </div>
  );
}
