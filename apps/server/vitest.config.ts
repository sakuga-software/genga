import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = fileURLToPath(new URL('../../packages/genga/src/', import.meta.url));

export default defineConfig({
  // The tests read the genga source, so they need no build first.
  resolve: {
    alias: [
      { find: /^genga$/, replacement: `${source}index.ts` },
      { find: /^genga\/(server|client|preview)$/, replacement: `${source}$1/index.ts` },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
