import { defineConfig, devices } from '@playwright/test';

// `e2e/run.mjs` starts the Genga server and the site, then runs these tests.
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
  },
  projects: [
    { name: 'chromium', testMatch: 'next.spec.ts', use: { ...devices['Desktop Chrome'] } },
    // After `chromium`: it logs in with the admin that the first project creates.
    {
      name: 'webkit',
      testMatch: 'preview-webkit.spec.ts',
      dependencies: ['chromium'],
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
