type StoredCookie = { value: string; options: Record<string, unknown> };

/** The state of the mocks of `next/headers` and `next/cache`. */
export const nextState = {
  draftMode: false,
  cookies: new Map<string, StoredCookie>(),
  revalidated: [] as { tag: string; profile: unknown }[],
  reset() {
    this.draftMode = false;
    this.cookies.clear();
    this.revalidated.length = 0;
  },
};
