import type { ReactNode } from 'react';

type KpiTone = 'default' | 'success' | 'warning';

const TONES: Record<KpiTone, string> = {
  default: 'bg-[var(--surface-tertiary)] text-[var(--foreground)]',
  success: 'bg-[color-mix(in_oklab,var(--success)_18%,transparent)] text-[var(--success)]',
  warning: 'bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] text-[var(--warning)]',
};

export type KpiItem = {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: KpiTone;
};

/** Key figures in one surface. A description list gives each value its label. */
export function KpiGroup({ items, label }: { items: KpiItem[]; label: string }) {
  return (
    <dl
      aria-label={label}
      className="grid divide-y divide-[var(--separator)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] sm:grid-flow-col sm:auto-cols-fr sm:divide-x sm:divide-y-0"
    >
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-3 p-5">
          <dt className="flex items-center gap-2 text-sm text-[var(--muted)]">
            {item.icon && (
              <span
                aria-hidden
                className={`grid size-7 place-items-center rounded-lg ${TONES[item.tone ?? 'default']}`}
              >
                {item.icon}
              </span>
            )}
            {item.label}
          </dt>
          <dd className="genga-display text-3xl font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
