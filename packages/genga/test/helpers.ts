import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { blocks, date, defineBlock, defineConfig, media, richText, slug, tags, text, textarea } from '../src';
import { createGenga, type Genga } from '../src/server';
import type { PublicUser } from '../src/types';
import { TEST_URL } from './global-setup';

export const imageBlock = defineBlock({
  type: 'image',
  label: 'Image',
  fields: { image: media({ required: true }), caption: text() },
  component: () => null,
});

export const textBlock = defineBlock({
  type: 'rich-text',
  label: 'Texte',
  fields: { content: richText({ required: true }) },
  component: () => null,
});

export const testConfig = defineConfig({
  collections: {
    journal: {
      label: 'Journal',
      labelSingular: 'Article',
      titleField: 'title',
      sortField: 'publishedDate',
      path: (value) => `/journal/${value}`,
      fields: {
        title: text({ required: true }),
        slug: slug({ from: 'title', required: true }),
        excerpt: textarea(),
        cover: media(),
        publishedDate: date(),
        tags: tags(),
        body: blocks(),
      },
    },
  },
  blocks: [imageBlock, textBlock],
});

export const SITE = 'http://genga.test';

type Context = { genga: Genga; mediaDir: string };

/** One Genga instance per test file, on the test database, with empty tables before each test. */
export function useGenga(): Context {
  const context = {} as Context;
  beforeAll(async () => {
    context.mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-media-'));
    context.genga = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      mediaDir: context.mediaDir,
      secureCookies: false,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    await context.genga.ready();
  });
  beforeEach(async () => {
    context.genga.auth.resetRateLimits();
    await context.genga.sql`
      TRUNCATE genga_audit, genga_redirects, genga_versions, genga_documents, genga_media, genga_tokens, genga_sessions, genga_users CASCADE
    `;
  });
  afterAll(async () => {
    await context.genga.close();
    await rm(context.mediaDir, { recursive: true, force: true });
  });
  return context;
}

export async function createUser(
  genga: Genga,
  role: PublicUser['role'],
  email = `${role}-${crypto.randomUUID()}@genga.test`,
) {
  const { user } = await genga.auth.invite(email, role, role);
  return user;
}

export function request(url = '/', init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie.split(';')[0]);
  return new Request(new URL(url, SITE), { ...init, headers });
}

export async function pngFile(name = 'image.png', color = { r: 255, g: 107, b: 80 }, width = 1200) {
  const body = await sharp({ create: { width, height: 600, channels: 3, background: color } })
    .png()
    .toBuffer();
  return new File([new Uint8Array(body)], name, { type: 'image/png' });
}

export function paragraph(text: string, href?: string) {
  return {
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }],
      },
    ],
  };
}
