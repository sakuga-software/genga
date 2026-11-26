import { vi } from 'vitest';
import { nextState } from './next-state';

vi.mock('next/headers', () => ({
  draftMode: async () => ({
    get isEnabled() {
      return nextState.draftMode;
    },
    enable() {
      nextState.draftMode = true;
      nextState.cookies.set('__prerender_bypass', { value: 'build-preview-id', options: { sameSite: 'none' } });
    },
    disable() {
      nextState.draftMode = false;
      nextState.cookies.delete('__prerender_bypass');
    },
  }),
  cookies: async () => ({
    get: (name: string) => {
      const cookie = nextState.cookies.get(name);
      return cookie ? { name, value: cookie.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      nextState.cookies.set(name, { value, options });
    },
    delete: (options: { name: string }) => {
      nextState.cookies.delete(options.name);
    },
  }),
}));

vi.mock('next/cache', () => ({
  revalidateTag: (tag: string, profile: unknown) => {
    nextState.revalidated.push({ tag, profile });
  },
}));
