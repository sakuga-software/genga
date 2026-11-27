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
      s3: null,
    });
  });

  it('reads the S3 settings, and never puts the secret in a message', () => {
    const secret = 'super-secret-value-1234567890';
    const s3 = {
      GENGA_S3_BUCKET: 'media',
      GENGA_S3_ENDPOINT: 'https://s3.fr-par.scw.cloud/',
      GENGA_S3_REGION: 'fr-par',
      GENGA_S3_ACCESS_KEY_ID: 'SCWEXAMPLE',
      GENGA_S3_SECRET_ACCESS_KEY: secret,
      GENGA_S3_PREFIX: 'genga',
      GENGA_S3_DELIVERY: 'signed',
      GENGA_S3_SIGNED_URL_TTL: '900',
    };
    expect(readSettings({ ...env, ...s3 }).s3).toMatchObject({
      bucket: 'media',
      endpoint: 'https://s3.fr-par.scw.cloud',
      region: 'fr-par',
      prefix: 'genga',
      delivery: 'signed',
      signedUrlExpiresIn: 900,
    });
    expect(
      readSettings({ ...env, GENGA_S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' }).s3,
    ).toMatchObject({
      accessKeyId: 'a',
      delivery: 'proxy',
    });
    const roleToken = {
      AWS_SESSION_TOKEN: 'role-token',
      AWS_ACCESS_KEY_ID: 'role',
      AWS_SECRET_ACCESS_KEY: 'role-secret',
    };
    expect(readSettings({ ...env, ...s3, ...roleToken }).s3).toMatchObject({
      accessKeyId: 'SCWEXAMPLE',
      sessionToken: undefined,
    });
    expect(readSettings({ ...env, GENGA_S3_BUCKET: 'b', ...roleToken }).s3).toMatchObject({
      accessKeyId: 'role',
      sessionToken: 'role-token',
    });
    for (const [values, problem] of [
      [{ GENGA_S3_SECRET_ACCESS_KEY: '' }, 'GENGA_S3_ACCESS_KEY_ID and GENGA_S3_SECRET_ACCESS_KEY are required'],
      [{ GENGA_S3_DELIVERY: 'cdn' }, 'GENGA_S3_DELIVERY must be proxy, public or signed'],
      [{ GENGA_S3_DELIVERY: 'public' }, 'GENGA_S3_PUBLIC_URL is required'],
      [{ GENGA_S3_ENDPOINT: 'https://s3.example/x' }, 'GENGA_S3_ENDPOINT must be an origin'],
      [{ GENGA_S3_SIGNED_URL_TTL: '999999' }, 'GENGA_S3_SIGNED_URL_TTL must be 604800 seconds'],
      [{ GENGA_S3_FORCE_PATH_STYLE: 'maybe' }, 'GENGA_S3_FORCE_PATH_STYLE must be true or false'],
    ] as const) {
      const error = (() => {
        try {
          readSettings({ ...env, ...s3, ...values });
        } catch (caught) {
          return caught as Error;
        }
        return null;
      })();
      expect(error?.message).toContain(problem);
      expect(error?.message).not.toContain(secret);
    }
  });

  it('reads the MCP switch and path', () => {
    expect(readSettings({ ...env, GENGA_MCP: 'off' }).mcp).toEqual({
      enabled: false,
      path: '/mcp',
      oauth: true,
      uploadPorts: null,
    });
    expect(readSettings({ ...env, GENGA_MCP_PATH: '/agents/' }).mcp).toEqual({
      enabled: true,
      path: '/agents',
      oauth: true,
      uploadPorts: null,
    });
    expect(readSettings({ ...env, GENGA_MCP_OAUTH: 'off' }).mcp.oauth).toBe(false);
    expect(readSettings({ ...env, GENGA_MCP_UPLOAD_PORTS: '443, 8443' }).mcp.uploadPorts).toEqual([443, 8443]);
    for (const [values, problem] of [
      [{ GENGA_MCP: 'maybe' }, 'GENGA_MCP must be on or off'],
      [{ GENGA_MCP_OAUTH: 'maybe' }, 'GENGA_MCP_OAUTH must be on or off'],
      [{ GENGA_MCP_PATH: '/a/b' }, 'GENGA_MCP_PATH must be one path segment'],
      [{ GENGA_MCP_PATH: '/api' }, 'GENGA_MCP_PATH cannot be /api'],
      [{ GENGA_MCP_PATH: '/admin' }, 'GENGA_MCP_PATH cannot be the admin path'],
      [{ GENGA_MCP_UPLOAD_PORTS: '443,http' }, 'GENGA_MCP_UPLOAD_PORTS must be a comma-separated list'],
      [{ GENGA_MCP_UPLOAD_PORTS: '0x1BB' }, 'GENGA_MCP_UPLOAD_PORTS must be a comma-separated list'],
      [{ GENGA_MCP_UPLOAD_PORTS: '1e2' }, 'GENGA_MCP_UPLOAD_PORTS must be a comma-separated list'],
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
