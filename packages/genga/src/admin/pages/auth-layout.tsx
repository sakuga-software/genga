import type { ReactNode } from 'react';
import { Card } from '@heroui/react';

export function AuthLayout({
  title,
  description,
  wide = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** A wider card, for a page with more than a short form. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="min-h-dvh grid place-items-center px-4 py-12 bg-[radial-gradient(60rem_30rem_at_20%_-10%,rgba(255,107,80,0.12),transparent),radial-gradient(40rem_30rem_at_110%_110%,rgba(23,120,255,0.12),transparent)]">
      <div className={wide ? 'w-full max-w-md' : 'w-full max-w-sm'}>
        <div className="mb-8 flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-xl bg-[var(--genga-coral)] text-[#050505] genga-display text-xl font-bold"
          >
            原
          </span>
          <div>
            <p className="genga-display text-xl font-semibold leading-none">Genga</p>
            <p className="genga-mono text-xs text-[var(--muted)] mt-1">CMS</p>
          </div>
        </div>
        <Card className="p-2">
          <Card.Header>
            <h1 className="genga-display text-2xl font-semibold">{title}</h1>
            {description && <Card.Description>{description}</Card.Description>}
          </Card.Header>
          <Card.Content>{children}</Card.Content>
        </Card>
      </div>
    </main>
  );
}
