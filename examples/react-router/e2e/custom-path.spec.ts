import { expect, test } from '@playwright/test';
import { expectNoCspViolation, watchCsp } from './csp';

const SITE = process.env.E2E_SITE_URL ?? 'http://localhost:3920';
const ADMIN = process.env.E2E_ADMIN_PATH ?? '/cms';

test('the admin works under a custom admin path', async ({ browser, request }) => {
  test.skip(ADMIN === '/admin', 'The run sets a custom admin path for this project.');
  const context = await browser.newContext();
  await watchCsp(context);
  const page = await context.newPage();
  await page.goto(`${SITE}${ADMIN}`);
  await expect(page).toHaveURL(new RegExp(`${ADMIN}/login\\?next=`));
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Mot de passe').fill('a-long-e2e-password');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour' })).toBeVisible();
  await page.getByRole('link', { name: 'Blog' }).first().click();
  await page.getByRole('link', { name: /Hello, live preview/ }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Hello, live preview');
  expect(new URL(page.url()).pathname.startsWith(`${ADMIN}/collections/posts/`)).toBe(true);
  await expectNoCspViolation(page);
  expect((await request.get(`${SITE}/admin/login`)).status()).toBe(404);
  await context.close();
});
