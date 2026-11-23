import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

type SplitPaneProps = {
  start: ReactNode;
  end: ReactNode;
  /** Accessible name of the separator. */
  separatorLabel: string;
  /** Width of the start pane, in percent of the container. */
  defaultSize?: number;
  minStart?: number;
  minEnd?: number;
  /** If set, the size persists in `localStorage` under this key. */
  storageKey?: string;
  className?: string;
};

const SMALL_STEP = 2;
const LARGE_STEP = 10;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readStoredSize(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeSize(key: string, size: number) {
  try {
    window.localStorage.setItem(key, String(Math.round(size * 10) / 10));
  } catch {
    // Private mode or blocked storage: the size lasts until the page closes.
  }
}

/**
 * Two panes side by side, with a window splitter between them (WAI-ARIA APG pattern).
 * Pointer: drag the separator. Keyboard: arrows, Shift + arrows, Home and End.
 */
export function SplitPane({
  start,
  end,
  separatorLabel,
  defaultSize = 50,
  minStart = 20,
  minEnd = 20,
  storageKey,
  className = '',
}: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const startId = useId();
  const max = 100 - minEnd;
  const [size, setSize] = useState(() => clamp(defaultSize, minStart, max));
  const [dragging, setDragging] = useState(false);
  const fullKey = storageKey ? `genga:split:${storageKey}` : null;

  useEffect(() => {
    if (!fullKey) return;
    const stored = readStoredSize(fullKey);
    if (stored !== null) setSize(clamp(stored, minStart, max));
  }, [fullKey, minStart, max]);

  function update(next: number) {
    const value = clamp(next, minStart, max);
    setSize(value);
    if (fullKey) storeSize(fullKey, value);
  }

  function sizeAt(clientX: number) {
    const rect = container.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return size;
    return ((clientX - rect.left) / rect.width) * 100;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    // The capture keeps the drag alive when the pointer moves over the preview iframe.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragging) update(sizeAt(event.clientX));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? LARGE_STEP : SMALL_STEP;
    const moves: Record<string, () => number> = {
      ArrowLeft: () => size - step,
      ArrowRight: () => size + step,
      Home: () => minStart,
      End: () => max,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    update(move());
  }

  return (
    <div
      ref={container}
      data-dragging={dragging || undefined}
      className={`flex min-h-0 [&[data-dragging]]:cursor-col-resize [&[data-dragging]]:select-none [&[data-dragging]_iframe]:pointer-events-none ${className}`}
    >
      <div id={startId} className="min-h-0 min-w-0" style={{ flex: `0 0 ${size}%` }}>
        {start}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={separatorLabel}
        aria-controls={startId}
        aria-orientation="vertical"
        aria-valuenow={Math.round(size)}
        aria-valuemin={minStart}
        aria-valuemax={max}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center -mx-[3px]"
      >
        <span
          aria-hidden
          className="h-full w-px bg-[var(--border)] transition-colors group-hover:bg-[var(--focus)] group-focus-visible:bg-[var(--focus)]"
        />
        <span
          aria-hidden
          className="absolute h-8 w-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-tertiary)] group-hover:border-[var(--focus)] group-focus-visible:border-[var(--focus)]"
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1">{end}</div>
    </div>
  );
}
