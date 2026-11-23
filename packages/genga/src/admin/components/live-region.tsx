import { useEffect, useRef, useState } from 'react';

/**
 * A polite live region. It announces a message only when the message changes,
 * and at most once per `minIntervalMs`, so autosave does not flood screen readers.
 */
export function LiveRegion({ message, minIntervalMs = 1500 }: { message: string; minIntervalMs?: number }) {
  const [spoken, setSpoken] = useState('');
  const last = useRef({ message: '', at: 0 });

  useEffect(() => {
    if (!message || message === last.current.message) return;
    const wait = Math.max(0, last.current.at + minIntervalMs - Date.now());
    const timer = window.setTimeout(() => {
      last.current = { message, at: Date.now() };
      setSpoken(message);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [message, minIntervalMs]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {spoken}
    </div>
  );
}
