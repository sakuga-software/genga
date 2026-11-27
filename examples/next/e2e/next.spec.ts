import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

const GENGA = process.env.E2E_GENGA_URL ?? 'http://localhost:3910';
const SITE = process.env.E2E_SITE_URL ?? 'https://127.0.0.1:3912';
const SETUP_URL = process.env.E2E_SETUP_URL ?? '';
const PASSWORD = 'a-long-e2e-password';

/** A PNG of 1 × 1 pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Next.js keeps rendered pages on disk across runs: each run uses its own slugs.
const RUN = Date.now().toString(36);
const SLUG = `hello-${RUN}`;
const RENAMED = `renamed-${RUN}`;

const heroId = crypto.randomUUID();
const textId = crypto.randomUUID();

function body(heroTitle: string, image: Record<string, unknown> | null = null) {
  return [
    { _id: heroId, _type: 'hero', title: heroTitle, text: '', image, ctaLabel: '', ctaUrl: '' },
    {
      _id: textId,
      _type: 'rich-text',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Server text', marks: [{ type: 'bold' }] }] }],
      },
    },
  ];
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let admin: Page;
let api: APIRequestContext;
let postId = '';
let mediaId = '';

/** A call to the admin API with the session of the admin. Writes need the Origin of the admin. */
async function call(method: string, pathname: string, data?: unknown) {
  const response = await api.fetch(`${GENGA}/admin/api${pathname}`, {
    method,
    headers: { Origin: GENGA },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${pathname}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function draftRev(id: string): Promise<number> {
  return (await call('GET', `/documents/${id}`)).document.draftRev;
}

async function saveAndPublish(id: string, data: Record<string, unknown>) {
  const saved = await call('PUT', `/documents/${id}/draft`, { data, draftRev: await draftRev(id) });
  await call('POST', `/documents/${id}/publish`, { draftRev: saved.draftRev });
}

/** The HTML of a site page for a visitor without cookies. */
async function visit(request: APIRequestContext, pathname: string) {
  const response = await request.get(`${SITE}${pathname}`, { maxRedirects: 0 });
  return { status: response.status(), headers: response.headers(), html: await response.text() };
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  admin = await context.newPage();
  api = context.request;
});

test.afterAll(async () => {
  await context?.close();
});

test('the setup link creates the first admin', async () => {
  expect(SETUP_URL, 'e2e/run.mjs gives the setup link').not.toBe('');
  await admin.goto(SETUP_URL);
  await admin.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await admin.getByLabel('Confirmer le mot de passe').fill(PASSWORD);
  await admin.getByRole('button', { name: /Créer le compte|Enregistrer/ }).click();
  await expect(admin).toHaveURL(new RegExp(`^${GENGA}/admin/?$`));
});

test('a published post renders on the server, with an image from the CMS', async ({ request }) => {
  const upload = await api.post(`${GENGA}/admin/api/media`, {
    headers: { Origin: GENGA },
    multipart: { file: { name: 'pixel.png', mimeType: 'image/png', buffer: PNG }, alt: 'A pixel' },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  mediaId = (await upload.json()).media.id;

  const created = await call('POST', '/documents', {
    collection: 'posts',
    data: { title: 'Hello Next', slug: SLUG, publishedDate: '2026-11-26', body: body('Hero one') },
  });
  postId = created.id;
  await saveAndPublish(postId, {
    title: 'Hello Next',
    slug: SLUG,
    publishedDate: '2026-11-26',
    cover: mediaId,
    body: body('Hero one', null),
  });

  const page = await visit(request, `/blog/${SLUG}`);
  expect(page.status).toBe(200);
  expect(page.html).toContain('<h1>Hello Next</h1>');
  expect(page.html).toContain('<h2>Hero one</h2>');
  expect(page.html).toContain('<strong>Server text</strong>');
  expect(page.html).toMatch(new RegExp(`<img class="cover" src="${GENGA}/media/[^"]+"`));
  expect(page.html).not.toContain('data-genga-block-id="');
  // The ISR header of Next.js: `revalidateTag` clears the cache of Next.js, and a CDN keeps its copy until `s-maxage`.
  expect(page.headers['cache-control']).toMatch(/^s-maxage=3600, stale-while-revalidate/);
});

test('a publish shows on the site within 5 seconds, without a restart', async ({ request }) => {
  await saveAndPublish(postId, {
    title: 'Hello again',
    slug: SLUG,
    publishedDate: '2026-11-26',
    cover: mediaId,
    body: body('Hero two'),
  });
  await expect
    .poll(async () => (await visit(request, `/blog/${SLUG}`)).html, { timeout: 5_000, intervals: [250] })
    .toContain('<h1>Hello again</h1>');
});

test('the editor preview follows each keystroke, and refreshes after the autosave', async () => {
  await admin.goto(`${GENGA}/admin/collections/posts/${postId}`);
  const frame = admin.frameLocator('iframe[title="Aperçu de la page sur le site"]');
  await expect(frame.locator('h1')).toHaveText('Hello again');
  await expect(frame.locator('[data-genga-block-id]')).toHaveCount(2);

  const title = admin.getByRole('textbox', { name: 'Title' }).first();
  await title.fill('Typed in the editor');
  // The header is a Client Component: it changes before any save.
  await expect(frame.locator('h1')).toHaveText('Typed in the editor', { timeout: 2_000 });
  // The metadata comes from the server: it changes after the autosave and `router.refresh()`.
  await expect.poll(() => frame.locator('title').textContent(), { timeout: 15_000 }).toBe('Typed in the editor');

  await admin.getByRole('button', { name: /Hero/, expanded: false }).first().click();
  const heroTitle = admin.getByRole('textbox', { name: 'Title' }).nth(1);
  await heroTitle.fill('Live hero');
  // The hero block is a Client Component: it follows the draft at once.
  await expect(frame.locator(`[data-genga-block-id="${heroId}"] h2`)).toHaveText('Live hero', { timeout: 2_000 });
});

test('a visitor still sees the published post', async ({ request }) => {
  const page = await visit(request, `/blog/${SLUG}`);
  expect(page.html).toContain('<h1>Hello again</h1>');
  expect(page.html).not.toContain('Typed in the editor');
});

test('the preview entry route checks the token', async ({ request }) => {
  const bad = await request.get(`${SITE}/api/genga/preview?genga-preview=${postId}&genga-token=bad.token`, {
    timeout: 10_000,
    maxRedirects: 0,
  });
  expect(bad.status()).toBe(401);
  expect(bad.headers()['cache-control']).toBe('private, no-store');

  const { preview } = await call('GET', `/documents/${postId}/preview`);
  const entry = await request.get(preview.url, { maxRedirects: 0 });
  expect(entry.status()).toBe(307);
  expect(entry.headers()['location']).toBe(`/blog/${SLUG}`);
  expect(entry.headers()['referrer-policy']).toBe('no-referrer');
  const cookies = entry.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie');
  expect(cookies.map((cookie) => cookie.value).join('\n')).toMatch(/__prerender_bypass=.*Partitioned/);
  expect(cookies.map((cookie) => cookie.value).join('\n')).toMatch(/genga-preview=.*HttpOnly.*Partitioned/i);
});

test('the editor renews the token through the bridge, also on a page without the draft', async () => {
  const frameElement = admin.locator('iframe[title="Aperçu de la page sur le site"]');
  const frame = admin.frames().find((candidate) => candidate.url().startsWith(SITE));
  expect(frame, 'the preview frame is open').toBeTruthy();
  // The home page has no draft: only the bridge of the layout listens to the editor.
  await frame!.goto(`${SITE}/`);
  await expect(admin.frameLocator('iframe[title="Aperçu de la page sur le site"]').locator('h1')).toHaveText(
    'Genga example',
  );
  const { preview } = await call('GET', `/documents/${postId}/preview`);
  const token = new URL(preview.url).searchParams.get('genga-token');
  const renewal = admin.waitForResponse(
    (response) => response.url() === `${SITE}/api/genga/preview` && response.request().method() === 'POST',
  );
  const refreshAfterRenewal = admin.waitForRequest(
    (request) => request.url().startsWith(`${SITE}/`) && new URL(request.url()).searchParams.has('_rsc'),
  );
  // The message that the editor sends before a token expires.
  await frameElement.evaluate(
    (element: HTMLIFrameElement, { documentId, token, site }) =>
      element.contentWindow!.postMessage({ type: 'genga:token', documentId, token }, site),
    { documentId: postId, token: token!, site: SITE },
  );
  expect((await renewal).status()).toBe(204);
  // After the renewal, the page asks the server again: the draft comes back at once.
  await refreshAfterRenewal;
});

test('the entry route refuses a renewal with a bad token', async () => {
  const frame = admin.frames().find((candidate) => candidate.url().startsWith(SITE));
  const status = await frame!.evaluate(
    (documentId) =>
      fetch('/api/genga/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, token: 'bad.token' }),
      }).then((response) => response.status),
    postId,
  );
  expect(status).toBe(401);
});

test('a slug change redirects the old URL permanently', async ({ request }) => {
  await saveAndPublish(postId, {
    title: 'Hello again',
    slug: RENAMED,
    publishedDate: '2026-11-26',
    cover: mediaId,
    body: body('Hero two'),
  });
  await expect
    .poll(async () => (await visit(request, `/blog/${SLUG}`)).status, { timeout: 5_000, intervals: [250] })
    .toBe(308);
  expect((await visit(request, `/blog/${SLUG}`)).headers['location']).toBe(`/blog/${RENAMED}`);
  expect((await visit(request, `/blog/${RENAMED}`)).html).toContain('<h1>Hello again</h1>');
});
