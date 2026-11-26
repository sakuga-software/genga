import { expect, test } from '@playwright/test';

// WebKit blocks the cookies of a frame on another site, except `Partitioned` cookies. The admin
// is on `localhost` and the site on `127.0.0.1`: this test fails if Draft Mode loses its cookie.
const GENGA = process.env.E2E_GENGA_URL ?? 'http://localhost:3910';
const SITE = process.env.E2E_SITE_URL ?? 'http://127.0.0.1:3911';
const PASSWORD = 'a-long-e2e-password';

test('the preview works in WebKit, in a frame on another site', async ({ page }) => {
  await page.goto(`${GENGA}/admin/login`);
  await page.getByLabel('Email').fill('admin@genga.test');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(new RegExp(`^${GENGA}/admin/?$`));

  const slug = `webkit-${Date.now().toString(36)}`;
  const created = await page.request.post(`${GENGA}/admin/api/documents`, {
    headers: { Origin: GENGA },
    data: { collection: 'posts', data: { title: 'Seen in WebKit', slug, publishedDate: '2026-11-26', body: [] } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();

  await page.goto(`${GENGA}/admin/collections/posts/${id}`);
  const frame = page.frameLocator('iframe[title="Aperçu de la page sur le site"]');
  // The post has no published version: only Draft Mode shows it.
  await expect(frame.locator('h1')).toHaveText('Seen in WebKit');
  expect(page.frames().some((candidate) => candidate.url() === `${SITE}/blog/${slug}`)).toBe(true);

  await page.getByRole('textbox', { name: 'Title' }).first().fill('Typed in WebKit');
  await expect(frame.locator('h1')).toHaveText('Typed in WebKit', { timeout: 2_000 });
});
