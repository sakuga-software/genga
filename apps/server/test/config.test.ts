import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfigFile, parseConfig } from '../app/.server/config-file';
import { readSettings } from '../app/.server/settings';

const example = path.resolve(import.meta.dirname, '../config.example.json');

function minimal(overrides: Record<string, unknown> = {}) {
  return {
    collections: {
      posts: {
        label: 'Posts',
        path: '/blog/{slug}',
        fields: { title: { type: 'text' }, slug: { type: 'slug' } },
        ...overrides,
      },
    },
  };
}

function problems(raw: unknown): string {
  try {
    parseConfig(raw, 'test.json');
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('The config was accepted.');
}

describe('config file', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'genga-config-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('loads the example config: two collections and four blocks', async () => {
    const config = await loadConfigFile(example);
    expect(Object.keys(config.collections)).toEqual(['posts', 'pages']);
    expect(config.blocks.map((block) => block.type)).toEqual(['hero', 'rich-text', 'image', 'quote']);
    expect(config.blocks.every((block) => block.component === undefined)).toBe(true);
    const posts = config.collections.posts;
    expect(posts.path('hello')).toBe('/blog/hello');
    expect(
      posts.previewUrl && posts.previewUrl({ id: 'i', slug: 'hello', collection: 'posts', path: '/blog/hello' }),
    ).toBe('http://localhost:4321/blog/hello');
    expect(config.collections.pages.access).toEqual({ publish: ['admin'] });
  });

  it('turns templates into functions and defaults', () => {
    const config = parseConfig({
      ...minimal({ previewUrl: 'https://site.example/{collection}/{slug}?id={id}&p={path}' }),
      access: { delete: ['admin'] },
    });
    const posts = config.collections.posts;
    expect(posts.labelSingular).toBe('Posts');
    expect(posts.titleField).toBe('title');
    expect(posts.access).toEqual({ delete: ['admin'] });
    expect(
      (posts.previewUrl as (doc: object) => string)({ id: '1', slug: 'a', collection: 'posts', path: '/blog/a' }),
    ).toBe('https://site.example/posts/a?id=1&p=/blog/a');
    expect(parseConfig(minimal()).collections.posts.previewUrl).toBe(false);
  });

  it.each([
    [
      'an unknown field type',
      minimal({ fields: { title: { type: 'texte' }, slug: { type: 'slug' } } }),
      'collections.posts.fields.title',
    ],
    [
      'a typo in a field option',
      minimal({ fields: { title: { type: 'text', maxLenght: 3 }, slug: { type: 'slug' } } }),
      'maxLenght',
    ],
    ['a path without {slug}', minimal({ path: '/blog' }), 'collections.posts.path'],
    ['an unknown placeholder', minimal({ previewUrl: 'https://site.example/{name}' }), 'Unknown placeholder {name}'],
    ['a relative preview URL', minimal({ previewUrl: '/preview/{slug}' }), 'absolute'],
    ['no slug field', minimal({ fields: { title: { type: 'text' } } }), 'exactly one slug field'],
    ['a bad role', minimal({ access: { publish: ['owner'] } }), 'collections.posts.access.publish.0'],
    ['no collection', { collections: {} }, 'at least one collection'],
    [
      'a block type twice',
      {
        ...minimal(),
        blocks: [
          { type: 'a', label: 'A', fields: {} },
          { type: 'a', label: 'B', fields: {} },
        ],
      },
      'defined twice',
    ],
    ['an unknown top-level key', { ...minimal(), colections: {} }, 'colections'],
  ])('explains %s', (_label, raw, expected) => {
    const message = problems(raw);
    expect(message).toContain('The Genga config test.json is not valid');
    expect(message).toContain(expected);
  });

  it('reports a JSON syntax error', async () => {
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{ "collections": ');
    await expect(loadConfigFile(file)).rejects.toThrow(/not valid JSON/);
  });

  it('loads a module that exports a function of the genga helpers', async () => {
    const file = path.join(dir, 'genga.config.mjs');
    await writeFile(
      file,
      `export default ({ text, slug, richText, defineBlock }) => ({
        collections: {
          notes: {
            label: 'Notes',
            path: (value) => '/notes/' + value,
            previewUrl: (doc) => 'https://site.example' + doc.path,
            fields: { title: text({ required: true }), slug: slug({ from: 'title' }) },
          },
        },
        blocks: [defineBlock({ type: 'text', label: 'Text', fields: { body: richText() } })],
      });\n`,
    );
    const config = await loadConfigFile(file);
    expect(config.collections.notes.path('a')).toBe('/notes/a');
    expect(config.blocks[0].type).toBe('text');
  });
});

describe('settings', () => {
  const env = { DATABASE_URL: 'postgres://u:p@db/genga', GENGA_CONFIG: example };

  it('reads the defaults', () => {
    expect(readSettings(env)).toMatchObject({
      port: 3000,
      adminPath: '/admin',
      publicUrl: 'http://localhost:3000',
      mediaDir: '/data/media',
      corsOrigins: [],
      previewOrigins: [],
      trustedProxies: 0,
      rateLimit: 300,
      secret: null,
      siteUrl: null,
      mcp: { enabled: true, path: '/mcp', uploadPorts: null },
    });
  });

  it('reads the MCP switch and path', () => {
    expect(readSettings({ ...env, GENGA_MCP: 'off' }).mcp).toEqual({ enabled: false, path: '/mcp', uploadPorts: null });
    expect(readSettings({ ...env, GENGA_MCP_PATH: '/agents/' }).mcp).toEqual({
      enabled: true,
      path: '/agents',
      uploadPorts: null,
    });
    expect(readSettings({ ...env, GENGA_MCP_UPLOAD_PORTS: '443, 8443' }).mcp.uploadPorts).toEqual([443, 8443]);
    for (const [values, problem] of [
      [{ GENGA_MCP: 'maybe' }, 'GENGA_MCP must be on or off'],
      [{ GENGA_MCP_PATH: '/a/b' }, 'GENGA_MCP_PATH must be one path segment'],
      [{ GENGA_MCP_PATH: '/api' }, 'GENGA_MCP_PATH cannot be /api'],
      [{ GENGA_MCP_PATH: '/admin' }, 'GENGA_MCP_PATH cannot be the admin path'],
      [{ GENGA_MCP_UPLOAD_PORTS: '443,http' }, 'GENGA_MCP_UPLOAD_PORTS must be a comma-separated list'],
      [{ GENGA_MCP_UPLOAD_PORTS: '0' }, 'GENGA_MCP_UPLOAD_PORTS must be a comma-separated list'],
      [{ GENGA_MCP_UPLOAD_PORTS: '70000' }, 'GENGA_MCP_UPLOAD_PORTS must be a comma-separated list'],
    ] as const) {
      expect(() => readSettings({ ...env, ...values })).toThrow(problem);
    }
  });

  it('reads lists, wildcards and paths', () => {
    const settings = readSettings({
      ...env,
      GENGA_PUBLIC_URL: 'https://cms.example.com/',
      GENGA_ADMIN_PATH: '/cms/',
      GENGA_CORS_ORIGINS: '*',
      GENGA_PREVIEW_ORIGINS: 'https://a.example, https://b.example/',
      GENGA_TRUSTED_PROXIES: '2',
    });
    expect(settings).toMatchObject({
      publicUrl: 'https://cms.example.com',
      adminPath: '/cms',
      corsOrigins: '*',
      previewOrigins: ['https://a.example', 'https://b.example'],
      trustedProxies: 2,
    });
  });

  it('lists every problem at once', () => {
    let message = '';
    try {
      readSettings({
        GENGA_CONFIG: '/missing/genga.config.json',
        GENGA_PUBLIC_URL: 'https://cms.example.com/admin',
        GENGA_ADMIN_PATH: '/media',
        GENGA_SECRET: 'short',
        GENGA_TRUSTED_PROXIES: '-1',
        PORT: 'eighty',
        GENGA_PREVIEW_ORIGINS: 'not a url',
        GENGA_SITE_URL: 'www.example.com',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const expected of [
      'DATABASE_URL is required',
      'does not exist',
      'GENGA_PUBLIC_URL must be an origin',
      'GENGA_ADMIN_PATH cannot be /media',
      'GENGA_SECRET must have at least 32 characters',
      'GENGA_TRUSTED_PROXIES must be an integer',
      'PORT must be an integer',
      'GENGA_PREVIEW_ORIGINS',
      'GENGA_SITE_URL must be a URL',
    ]) {
      expect(message).toContain(expected);
    }
  });
});
