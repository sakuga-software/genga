import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

/**
 * Reads a value that only the browser has, for example from `localStorage`. The server render
 * and the hydration use `serverValue`, then React renders again with the value of the browser.
 * `read` must return the same value while the source does not change.
 */
export function useBrowserValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(subscribe, read, () => serverValue);
}
