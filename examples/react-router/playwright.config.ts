import { defineConfig, devices } from '@playwright/test';

// `e2e/run.mjs` builds and starts the example, then runs these tests.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_SITE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'admin', testMatch: 'admin.spec.ts' },
    { name: 'custom-path', testMatch: 'custom-path.spec.ts' },
  ],
});
