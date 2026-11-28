import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoCspViolation, watchCsp } from './csp';

const SITE = process.env.E2E_SITE_URL ?? 'http://localhost:3920';
const SETUP_URL = process.env.E2E_SETUP_URL ?? '';
const EMAIL = 'admin@example.com';
const PASSWORD = 'a-long-e2e-password';
const SLUG = `hello-${Date.now().toString(36)}`;

/** A PNG of 1 × 1 pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let editorUrl = '';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await watchCsp(context);
  page = await context.newPage();
});

test.afterEach(async () => {
  await expectNoCspViolation(page);
});

test.afterAll(async () => {
  await context?.close();
});

test('the shell has no inline script and a strict CSP', async ({ request }) => {
  const response = await request.get(`${SITE}/admin/login`);
  expect(response.status()).toBe(200);
  const csp = response.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  expect(response.headers()['cache-control']).toBe('private, no-store');
  const html = await response.text();
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  const script = /src="(\/admin\/_app\/main-[^"]+\.js)"/.exec(html)?.[1] as string;
  const asset = await request.get(`${SITE}${script}`);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('the setup link creates the first admin', async () => {
  expect(SETUP_URL, 'E2E_SETUP_URL').not.toBe('');
  await page.goto(SETUP_URL);
  await expect(page.getByRole('heading', { name: 'Créer le premier administrateur' })).toBeVisible();
  await page.getByLabel('Nom').fill('Admin');
  await expect(page.getByLabel('Email')).toHaveValue(EMAIL);
  await page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmer le mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/admin');
});

test('the login page refuses a wrong password, then opens the page in next', async () => {
  await page.getByRole('button', { name: /Se déconnecter/ }).click();
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  await page.goto(`${SITE}/admin/media`);
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fmedia$/);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Mot de passe').fill('not-the-password');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByText('Email ou mot de passe incorrect.')).toBeVisible();
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin\/media$/);
  await expect(page.getByRole('heading', { name: 'Médias', level: 1 })).toBeVisible();
});

test('a media file uploads in the library', async () => {
  const upload = page.waitForResponse(
    (response) => response.url().endsWith('/admin/api/media') && response.request().method() === 'POST',
  );
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  expect((await upload).status()).toBe(201);
  await expect(page.getByText('pixel.png').first()).toBeVisible();
  await expect(page.locator('img[src^="/media/"]').first()).toBeVisible();
});

test('the editor saves the draft and the preview follows the title', async () => {
  await page.goto(`${SITE}/admin/collections/posts`);
  await page.getByRole('button', { name: /Nouveau : post/ }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  editorUrl = page.url();
  await page.getByLabel('Title').fill('Hello from the end-to-end test');
  await page.getByLabel('Slug', { exact: true }).fill(SLUG);
  await page.getByLabel('Publication date').fill('2026-11-28');
  const preview = page.frameLocator('iframe[title]').first();
  await expect(preview.getByRole('heading', { name: 'Hello from the end-to-end test' })).toBeVisible();
  const autosave = page.waitForResponse(
    (response) => response.url().endsWith('/draft') && response.request().method() === 'PUT' && response.ok(),
  );
  await page.getByLabel('Title').fill('Hello, live preview');
  await expect(preview.getByRole('heading', { name: 'Hello, live preview' })).toBeVisible();
  const saved = await (await autosave).json();
  expect(saved.draftRev).toBeGreaterThan(0);
  await expect(page.getByText('Enregistré', { exact: true }).first()).toBeVisible();
});

test('publish puts the post on the site, and the versions list it', async ({ request }) => {
  await page.getByRole('button', { name: 'Publier', exact: true }).click();
  await expect(page.getByText('Publié sur le site.').first()).toBeVisible();
  const published = await request.get(`${SITE}/blog/${SLUG}`);
  expect(published.status()).toBe(200);
  expect(await published.text()).toContain('Hello, live preview');
  await page.getByRole('button', { name: 'Versions' }).click();
  const drawer = page.getByRole('dialog', { name: 'Versions' });
  await expect(drawer.getByText('En ligne')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a reload keeps the editor, and the collection lists the post', async () => {
  await page.goto(editorUrl);
  await expect(page.getByLabel('Title')).toHaveValue('Hello, live preview');
  await page.goto(`${SITE}/admin/collections/posts?status=published`);
  await expect(page.getByRole('link', { name: /Hello, live preview/ })).toBeVisible();
});

test('an invitation gives a one-time link', async () => {
  await page.goto(`${SITE}/admin/users`);
  await page.getByLabel('Email').fill('author@example.com');
  await page.getByRole('button', { name: 'Créer le lien d’invitation' }).click();
  await expect(page.getByText(/\/admin\/setup\?token=/)).toBeVisible();
});

test('a personal token shows once', async () => {
  await page.goto(`${SITE}/admin/tokens`);
  await page.getByLabel('Nom').fill('e2e');
  await page.getByRole('button', { name: /Créer le jeton/ }).click();
  await expect(page.getByText('Jeton créé')).toBeVisible();
  await expect(page.getByText(/^gga_/)).toBeVisible();
});

test('the OAuth consent page gives a code to the client', async ({ request }) => {
  const callback = 'http://127.0.0.1:53999/callback';
  const registration = await request.post(`${SITE}/admin/api/oauth/register`, {
    data: { client_name: 'E2E client', redirect_uris: [callback], token_endpoint_auth_method: 'none' },
  });
  expect(registration.status()).toBe(201);
  const { client_id: clientId } = await registration.json();
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
    scope: 'read write',
    resource: `${SITE}/mcp`,
  });
  const response = await page.goto(`${SITE}/admin/oauth/authorize?${query}`);
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(page.getByRole('heading', { name: 'Autoriser l’accès' })).toBeVisible();
  await expect(page.getByText('E2E client')).toBeVisible();
  await expectNoCspViolation(page);
  // The client app: a page at the callback URL.
  await page.route(`${callback}?**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
  await page.getByRole('button', { name: 'Autoriser' }).click();
  await page.waitForURL(`${callback}?**`);
  const target = new URL(page.url());
  expect(target.searchParams.get('code')).toBeTruthy();
  expect(target.searchParams.get('state')).toBe('e2e-state');
  await page.goto(`${SITE}/admin`);
});
