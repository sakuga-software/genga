import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  blocks as blocksField,
  defineBlock,
  defineConfig,
  media,
  normalizeAdminPath,
  richText,
  richTextToHtml,
  slug,
  text,
  toPublicData,
  validate,
  type RichTextDoc,
} from '../src';
import { RenderBlocks, RichText } from '../src/render';
import { createGenga, createPreviewToken, verifyPreviewToken } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, request, SITE, useGenga } from './helpers';

const SECRET = 'a-preview-secret-of-thirty-two-chars!';

describe('schema-only blocks', () => {
  const quote = defineBlock({ type: 'quote', label: 'Quote', fields: { text: text({ required: true }) } });

  it('validates data and renders nothing without a component', () => {
    const config = defineConfig({
      collections: {
        pages: {
          label: 'Pages',
          labelSingular: 'Page',
          titleField: 'title',
          path: (value) => `/${value}`,
          fields: { title: text(), slug: slug(), body: blocksField() },
        },
      },
      blocks: [quote],
    });
    const blocks = { quote: { fields: quote.fields } };
    const result = validate(
      config.collections.pages.fields,
      { title: 'A', slug: 'a', body: [{ _id: 'b1', _type: 'quote', text: 'Hello' }] },
      'publish',
      blocks,
    );
    expect(result.ok).toBe(true);
    const html = renderToStaticMarkup(
      createElement(RenderBlocks, { blocks: [{ _id: 'b1', _type: 'quote', text: 'Hello' }], registry: [quote] }),
    );
    expect(html).toBe('<div></div>');
  });
});

describe('richTextToHtml', () => {
  const doc: RichTextDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Title <b>' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold & "quoted"', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }] },
          { type: 'text', text: 'local', marks: [{ type: 'link', attrs: { href: '/about' } }] },
          { type: 'text', text: 'evil', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        ],
      },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: "it's <script>" }] },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { src: 'x' } },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }] },
    ],
  };

  it('gives the same markup as <RichText>', () => {
    const react = renderToStaticMarkup(createElement(RichText, { value: doc }));
    expect(react).toBe(`<div>${richTextToHtml(doc)}</div>`);
  });

  it('escapes text and drops unsafe links and unknown nodes', () => {
    const html = richTextToHtml(doc);
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<a href="/about">local</a>');
  });

  it('gives an empty string for an empty value', () => {
    expect(richTextToHtml(null)).toBe('');
    expect(richTextToHtml({ type: 'doc' })).toBe('');
  });
});

describe('toPublicData', () => {
  it('makes media URLs absolute and adds the HTML of rich text, in blocks too', () => {
    const fields = { cover: media(), intro: richText(), body: { type: 'blocks' as const } };
    const blocks = { text: { fields: { content: richText() } } };
    const image = {
      id: 'm1',
      url: '/media/a.png',
      filename: 'a.png',
      mime: 'image/png',
      alt: '',
      width: 10,
      height: 10,
      sizes: [{ width: 480, url: '/media/a-w480.webp' }],
    };
    const paragraph = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };
    const result = toPublicData<Record<string, any>>(
      fields,
      { cover: image, intro: paragraph, body: [{ _id: 'b', _type: 'text', content: paragraph }] },
      blocks,
      'https://cms.example.com/',
    );
    expect(result.cover.url).toBe('https://cms.example.com/media/a.png');
    expect(result.cover.sizes[0].url).toBe('https://cms.example.com/media/a-w480.webp');
    expect(result.intro.html).toBe('<p>Hi</p>');
    expect(result.intro.content).toEqual(paragraph.content);
    expect(result.body[0].content.html).toBe('<p>Hi</p>');
  });
});

describe('preview tokens', () => {
  const id = '6f1c2a5e-3b1d-4c55-9f0e-2a7d8c9b0e11';
  const other = '0b8e7c1d-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

  it('accepts a token for its document until it expires', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = createPreviewToken(SECRET, id, { now });
    expect(verifyPreviewToken(SECRET, token, id, now + 9 * 60_000)).toBe(true);
    expect(verifyPreviewToken(SECRET, token, id, now + 10 * 60_000 + 1000)).toBe(false);
    expect(verifyPreviewToken(SECRET, token, other, now)).toBe(false);
    expect(verifyPreviewToken(`${SECRET}x`, token, id, now)).toBe(false);
  });

  it('rejects changed and malformed tokens', () => {
    const now = Date.now();
    const token = createPreviewToken(SECRET, id, { now });
    const [expiry, signature] = token.split('.');
    const later = (Number.parseInt(expiry, 36) + 3600).toString(36);
    expect(verifyPreviewToken(SECRET, `${later}.${signature}`, id, now)).toBe(false);
    for (const bad of ['', 'x', `${token}.x`, `zz.${signature}`, null, 'a'.repeat(300)]) {
      expect(verifyPreviewToken(SECRET, bad, id, now)).toBe(false);
    }
  });
});

describe('admin path', () => {
  it('normalizes and checks the path', () => {
    expect(normalizeAdminPath(undefined)).toBe('/admin');
    expect(normalizeAdminPath('/cms/')).toBe('/cms');
    expect(normalizeAdminPath('/cms/admin')).toBe('/cms/admin');
    for (const bad of ['cms', '/c ms', '//cms', '/cms?x', '/../x']) expect(() => normalizeAdminPath(bad)).toThrow();
  });

  const ctx = useGenga();

  it('uses the path in redirects, setup links and the login next value', async () => {
    const genga = createGenga(ctx.genga.config, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      mediaDir: ctx.mediaDir,
      adminPath: '/cms',
      secureCookies: false,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    try {
      const redirect = await genga.admin.requireUser(request('/cms/media?q=1')).catch((error: Response) => error);
      expect((redirect as Response).headers.get('location')).toBe('/cms/login?next=%2Fcms%2Fmedia%3Fq%3D1');

      for (const [next, expected] of [
        ['/cms/collections/journal', '/cms/collections/journal'],
        ['/cms', '/cms'],
        ['/cmsx/evil', '/cms'],
        ['//evil.example/cms', '/cms'],
        ['/cms\\..\\evil', '/cms'],
        ['https://evil.example/cms', '/cms'],
      ]) {
        const data = await genga.admin.loginLoader(request(`/cms/login?next=${encodeURIComponent(next)}`));
        expect(data.next).toBe(expected);
        expect(data.adminPath).toBe('/cms');
      }
      const admin = await createUser(genga, 'admin');
      expect((await genga.users.resetLink(admin, admin.id)).link).toMatch(/^http:\/\/genga\.test\/cms\/setup\?token=/);
    } finally {
      await genga.close();
    }
  });
});

describe('preview targets', () => {
  const ctx = useGenga();

  function configWith(previewUrl: (doc: { slug: string }) => string) {
    return defineConfig({
      collections: {
        posts: {
          label: 'Posts',
          labelSingular: 'Post',
          titleField: 'title',
          path: (value) => `/blog/${value}`,
          previewUrl,
          fields: { title: text(), slug: slug({ from: 'title' }) },
        },
      },
      blocks: [],
    });
  }

  const base = { databaseUrl: TEST_URL, siteUrl: SITE, logger: { info() {}, warn() {}, error() {} } };

  it('refuses at start a preview origin that is not allowed, or without a secret', () => {
    const config = configWith((doc) => `https://site.example/blog/${doc.slug}`);
    expect(() => createGenga(config, { ...base, previewSecret: SECRET })).toThrow(/GENGA_PREVIEW_ORIGINS/);
    expect(() =>
      createGenga(config, { ...base, previewOrigins: ['https://site.example'], previewSecret: null }),
    ).toThrow(/GENGA_SECRET/);
    expect(() =>
      createGenga(config, { ...base, previewOrigins: ['https://site.example'], previewSecret: 'short' }),
    ).toThrow(/32 characters/);
  });

  it('gives the editor a URL with a token scoped to the document, and never write access', async () => {
    const config = configWith((doc) => `https://site.example/blog/${doc.slug}?lang=en`);
    const genga = createGenga(config, {
      ...base,
      mediaDir: ctx.mediaDir,
      previewOrigins: ['https://site.example'],
      previewSecret: SECRET,
    });
    try {
      const editor = await createUser(genga, 'editor');
      const { id } = await genga.documents.create(editor, 'posts', { title: 'Hello' });
      const doc = await genga.documents.get(editor, id);
      expect(doc.preview?.origin).toBe('https://site.example');
      const url = new URL(doc.preview!.url);
      expect(url.pathname).toBe('/blog/hello');
      expect(url.searchParams.get('lang')).toBe('en');
      expect(url.searchParams.get('genga-preview')).toBe(id);
      expect(verifyPreviewToken(SECRET, url.searchParams.get('genga-token'), id)).toBe(true);

      const draft = await genga.published.draft<{ title: string }>(id);
      expect(draft?.data.title).toBe('Hello');
      expect(await genga.published.findById(id)).toBeNull();

      const write = await genga.api(
        request('/admin/api/documents', {
          method: 'POST',
          headers: { origin: 'https://site.example', 'content-type': 'application/json' },
          body: '{}',
        }),
        'documents',
      );
      expect(write.status).toBe(403);
    } finally {
      await genga.close();
    }
  });

  it('gives no preview for a document whose URL leaves the preview origins', async () => {
    const config = configWith((doc) =>
      doc.slug === 'other' ? 'https://evil.example/other' : `https://site.example/blog/${doc.slug}`,
    );
    const warnings: unknown[] = [];
    const genga = createGenga(config, {
      ...base,
      mediaDir: ctx.mediaDir,
      previewOrigins: ['https://site.example'],
      previewSecret: SECRET,
      logger: { info() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} },
    });
    try {
      const editor = await createUser(genga, 'editor');
      const { id } = await genga.documents.create(editor, 'posts', { title: 'Other' });
      expect((await genga.documents.get(editor, id)).preview).toBeNull();
      expect(warnings).toHaveLength(1);
    } finally {
      await genga.close();
    }
  });

  it('keeps a relative URL without a token on the site origin', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { id, slug: value } = await ctx.genga.documents.create(editor, 'journal', { title: 'Local' });
    const doc = await ctx.genga.documents.get(editor, id);
    expect(doc.preview).toEqual({ url: `/journal/${value}?genga-preview=${id}`, origin: null });
  });
});
