import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiScope } from '../src/access';
import type { PublicUser } from '../src/types';
import { createGenga } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, paragraph, pngFile, request, SITE, testConfig, useGenga } from './helpers';

const MCP_URL = `${SITE}/mcp`;
const ALL: ApiScope[] = ['read', 'write', 'publish'];

type Result = CallToolResult & { structuredContent?: Record<string, any> };

describe('MCP server', () => {
  const ctx = useGenga();
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function tokenFor(user: PublicUser, scopes: ApiScope[] = ALL) {
    return (await ctx.genga.tokens.create(user, { name: 'test', scopes })).token;
  }

  async function connect(user: PublicUser, scopes: ApiScope[] = ALL) {
    const token = await tokenFor(user, scopes);
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, init) => ctx.genga.mcp(new Request(input, init)),
    });
    const client = new Client({ name: 'genga-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
    return (await client.callTool({ name, arguments: args })) as Result;
  }

  function text(result: Result) {
    return (result.content as { type: string; text: string }[]).map((part) => part.text).join('\n');
  }

  function post(headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
    return ctx.genga.mcp(
      request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  describe('transport and authentication', () => {
    it('answers 401 with WWW-Authenticate without a token or with a bad one', async () => {
      const missing = await post({});
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="genga"');
      const bad = await post({ authorization: `Bearer gga_${'x'.repeat(43)}` });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
    });

    it('refuses a browser origin outside the allow list, and accepts the site origin', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const token = await tokenFor(editor);
      const auth = { authorization: `Bearer ${token}` };
      expect((await post({ ...auth, origin: 'https://evil.example' })).status).toBe(403);
      expect((await post({ ...auth, origin: 'null' })).status).toBe(403);
      const ok = await post({ ...auth, origin: SITE });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('answers 405 to GET and DELETE: the server is stateless', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const token = await tokenFor(editor);
      for (const method of ['GET', 'DELETE']) {
        const response = await ctx.genga.mcp(
          request('/mcp', { method, headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }),
        );
        expect(response.status).toBe(405);
      }
    });

    it('refuses a revoked token, an expired token and the token of a disabled user', async () => {
      const admin = await createUser(ctx.genga, 'admin');
      const editor = await createUser(ctx.genga, 'editor');
      const revoked = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
      await ctx.genga.tokens.revoke(editor, revoked.item.id);
      expect((await post({ authorization: `Bearer ${revoked.token}` })).status).toBe(401);

      const expired = await ctx.genga.tokens.create(editor, {
        name: 'b',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await ctx.genga
        .sql`UPDATE genga_api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${expired.item.id}`;
      expect((await post({ authorization: `Bearer ${expired.token}` })).status).toBe(401);

      const live = await tokenFor(editor);
      expect((await post({ authorization: `Bearer ${live}` })).status).toBe(200);
      await ctx.genga.users.update(admin, editor.id, { disabled: true });
      expect((await post({ authorization: `Bearer ${live}` })).status).toBe(401);
    });

    it('refuses a body that is not JSON', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const response = await ctx.genga.mcp(
        request('/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await tokenFor(editor)}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: '{not json',
        }),
      );
      expect(response.status).toBe(400);
    });

    it('lists the tools, the resources and the prompt', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          'create_document',
          'get_document',
          'list_collections',
          'list_documents',
          'list_relation_targets',
          'list_media',
          'list_versions',
          'preview_url',
          'publish_document',
          'restore_version',
          'unpublish_document',
          'update_draft',
          'update_media_alt',
          'upload_media',
        ].sort(),
      );
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
        'genga://collections/{name}/schema',
        'genga://documents/{id}',
      ]);
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toEqual(['write_article']);
    });
  });

  describe('tools', () => {
    it('list_collections gives the fields, the blocks, the rights and the value formats', async () => {
      const author = await createUser(ctx.genga, 'author');
      const result = await call(await connect(author), 'list_collections');
      expect(result.isError).toBeFalsy();
      const [journal] = result.structuredContent?.collections ?? [];
      expect(journal).toMatchObject({
        name: 'journal',
        titleField: 'title',
        path: '/journal/{slug}',
        rights: { create: true, update: true, publish: false, ownDocumentsOnly: true },
      });
      expect(journal.fields.body.type).toBe('blocks');
      expect(journal.blocks.map((block: { type: string }) => block.type).sort()).toEqual(['image', 'rich-text']);
      expect(result.structuredContent?.valueFormats.richText).toContain('"type":"doc"');
    });

    it.each([
      ['list_collections', 'read', {}],
      ['list_documents', 'read', { collection: 'journal' }],
      ['list_relation_targets', 'read', { collection: 'journal' }],
      ['get_document', 'read', { id: '00000000-0000-4000-8000-000000000000' }],
      ['list_versions', 'read', { id: '00000000-0000-4000-8000-000000000000' }],
      ['list_media', 'read', {}],
      ['preview_url', 'read', { id: '00000000-0000-4000-8000-000000000000' }],
      ['create_document', 'write', { collection: 'journal', data: { title: 'x' } }],
      ['update_draft', 'write', { id: '00000000-0000-4000-8000-000000000000', draftRev: 1, data: {} }],
      ['restore_version', 'write', { id: '00000000-0000-4000-8000-000000000000', versionId: 'x', draftRev: 1 }],
      ['upload_media', 'write', { data: 'aGVsbG8=' }],
      ['update_media_alt', 'write', { id: '00000000-0000-4000-8000-000000000000', alt: 'x' }],
      ['publish_document', 'publish', { id: '00000000-0000-4000-8000-000000000000', draftRev: 1 }],
      ['unpublish_document', 'publish', { id: '00000000-0000-4000-8000-000000000000' }],
    ] as const)('%s needs the %s scope', async (tool, scope, args) => {
      const editor = await createUser(ctx.genga, 'editor');
      const client = await connect(
        editor,
        ALL.filter((candidate) => candidate !== scope),
      );
      const result = await call(client, tool, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`no "${scope}" scope`);
    });

    it('a token without the read scope cannot read', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const result = await call(await connect(editor, ['write']), 'list_collections');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('no "read" scope');
    });

    it('create_document, get_document, update_draft and a draftRev conflict', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const client = await connect(editor);
      const created = await call(client, 'create_document', {
        collection: 'journal',
        data: { title: 'Bonjour MCP', tags: ['ia'], body: [{ _type: 'rich-text', content: paragraph('Salut') }] },
      });
      expect(created.isError).toBeFalsy();
      const { id, draftRev, slug } = created.structuredContent as { id: string; draftRev: number; slug: string };
      expect(draftRev).toBe(1);
      expect(slug).toBe('bonjour-mcp');

      const bySlug = await call(client, 'get_document', { collection: 'journal', slug: 'bonjour-mcp' });
      expect(bySlug.structuredContent?.document).toMatchObject({ id, draftRev: 1, status: 'draft' });
      expect(bySlug.structuredContent?.published).toBeNull();

      const updated = await call(client, 'update_draft', { id, draftRev: 1, data: { excerpt: 'Résumé' } });
      expect(updated.structuredContent).toMatchObject({ draftRev: 2, status: 'draft' });
      const after = await call(client, 'get_document', { id });
      expect(after.structuredContent?.document.draft).toMatchObject({ title: 'Bonjour MCP', excerpt: 'Résumé' });

      const stale = await call(client, 'update_draft', { id, draftRev: 1, data: { excerpt: 'Autre' } });
      expect(stale.isError).toBe(true);
      expect(text(stale)).toContain('The current draftRev is 2');
      const staleReplace = await call(client, 'update_draft', {
        id,
        draftRev: 1,
        mode: 'replace',
        data: { title: 'X' },
      });
      expect(text(staleReplace)).toContain('The current draftRev is 2');
    });

    it('create_document reports validation errors with their path', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'));
      const result = await call(client, 'create_document', {
        collection: 'journal',
        data: { title: 'x', body: [{ _type: 'unknown-block' }] },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Bloc inconnu');
      expect(text(result)).toContain('"path":["body",0,"_type"]');
    });

    it('publishes and unpublishes with the publish scope and an editor role', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const client = await connect(editor);
      const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Live', slug: 'live' });
      const published = await call(client, 'publish_document', { id, draftRev: 1 });
      expect(published.isError).toBeFalsy();
      expect(published.structuredContent?.url).toBe(`${SITE}/journal/live`);
      expect((await ctx.genga.published.find('journal', 'live'))?.id).toBe(id);
      const view = await call(client, 'get_document', { id });
      expect(view.structuredContent?.published).toMatchObject({ slug: 'live', data: { title: 'Live' } });
      await call(client, 'unpublish_document', { id });
      expect(await ctx.genga.published.find('journal', 'live')).toBeNull();
    });

    it('an editor token without the publish scope cannot publish', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Nope' });
      const result = await call(await connect(editor, ['read', 'write']), 'publish_document', { id, draftRev: 1 });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('no "publish" scope');
      expect(await ctx.genga.published.find('journal', 'nope')).toBeNull();
    });

    it('an author cannot publish, even with the publish scope', async () => {
      const author = await createUser(ctx.genga, 'author');
      const client = await connect(author, ALL);
      const created = await call(client, 'create_document', { collection: 'journal', data: { title: 'Mine' } });
      const { id } = created.structuredContent as { id: string };
      const result = await call(client, 'publish_document', { id, draftRev: 1 });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Forbidden');
      expect(await ctx.genga.published.find('journal', 'mine')).toBeNull();
      expect((await call(client, 'unpublish_document', { id })).isError).toBe(true);
    });

    it('an author sees and changes only its own drafts', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const author = await createUser(ctx.genga, 'author');
      const other = await ctx.genga.documents.create(editor, 'journal', {
        title: 'Editor draft',
        slug: 'editor-draft',
      });
      const own = await ctx.genga.documents.create(author, 'journal', { title: 'Author draft' });
      const client = await connect(author);

      const listed = await call(client, 'list_documents', { collection: 'journal' });
      expect(listed.structuredContent?.documents.map((doc: { id: string }) => doc.id)).toEqual([own.id]);
      const byId = await call(client, 'get_document', { id: other.id });
      expect(byId.isError).toBe(true);
      const bySlug = await call(client, 'get_document', { collection: 'journal', slug: 'editor-draft' });
      expect(text(bySlug)).toContain('Document introuvable');
      const update = await call(client, 'update_draft', { id: other.id, draftRev: 1, data: { title: 'Hacked' } });
      expect(update.isError).toBe(true);
      const replace = await call(client, 'update_draft', {
        id: other.id,
        draftRev: 1,
        mode: 'replace',
        data: { title: 'Hacked' },
      });
      expect(replace.isError).toBe(true);
      expect((await ctx.genga.documents.get(editor, other.id)).draft.title).toBe('Editor draft');
      expect((await call(client, 'list_versions', { id: other.id })).isError).toBe(true);
      expect((await call(client, 'preview_url', { id: other.id })).isError).toBe(true);
      await expect(client.readResource({ uri: `genga://documents/${other.id}` })).rejects.toThrow();
    });

    it('list_documents filters by status, search and tag, and pages with a cursor', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      for (const [title, tags] of [
        ['Alpha', ['ia']],
        ['Beta', ['web']],
        ['Gamma', ['ia', 'web']],
      ] as const) {
        await ctx.genga.documents.create(editor, 'journal', { title, tags: [...tags] });
      }
      const live = await ctx.genga.documents.create(editor, 'journal', { title: 'Delta', slug: 'delta' });
      await ctx.genga.documents.publish(editor, live.id, 1);
      const client = await connect(editor);
      const titles = (result: Result) => result.structuredContent?.documents.map((doc: { title: string }) => doc.title);

      expect(titles(await call(client, 'list_documents', { collection: 'journal', tag: 'ia' })).sort()).toEqual([
        'Alpha',
        'Gamma',
      ]);
      expect(titles(await call(client, 'list_documents', { collection: 'journal', status: 'published' }))).toEqual([
        'Delta',
      ]);
      expect(titles(await call(client, 'list_documents', { collection: 'journal', search: 'amm' }))).toEqual(['Gamma']);

      const first = await call(client, 'list_documents', { collection: 'journal', limit: 3 });
      expect(first.structuredContent?.documents).toHaveLength(3);
      const cursor = first.structuredContent?.nextCursor;
      expect(cursor).toBeTypeOf('string');
      const second = await call(client, 'list_documents', { collection: 'journal', limit: 3, cursor });
      expect(second.structuredContent?.documents).toHaveLength(1);
      expect(second.structuredContent?.nextCursor).toBeNull();
      expect([...titles(first), ...titles(second)].sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
      expect((await call(client, 'list_documents', { collection: 'journal', cursor: 'bad' })).isError).toBe(true);
    });

    it('list_versions and restore_version, with a draftRev check', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const client = await connect(editor);
      const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Première', slug: 'v' });
      await ctx.genga.documents.publish(editor, id, 1);
      await ctx.genga.documents.saveDraft(editor, id, { title: 'Seconde', slug: 'v' }, 1);
      const versions = await call(client, 'list_versions', { id });
      const [published] = versions.structuredContent?.versions ?? [];
      expect(published).toMatchObject({ kind: 'published', isPublished: true });
      const stale = await call(client, 'restore_version', { id, versionId: published.id, draftRev: 1 });
      expect(text(stale)).toContain('The current draftRev is 2');
      const restored = await call(client, 'restore_version', { id, versionId: published.id, draftRev: 2 });
      expect(restored.structuredContent).toMatchObject({ draftRev: 3 });
      expect((await ctx.genga.documents.get(editor, id)).draft.title).toBe('Première');
    });

    it('upload_media from base64, list_media and update_media_alt', async () => {
      const author = await createUser(ctx.genga, 'author');
      const client = await connect(author);
      const png = Buffer.from(await (await pngFile()).arrayBuffer()).toString('base64');
      const uploaded = await call(client, 'upload_media', { data: png, filename: 'cover.png', alt: 'Couverture' });
      expect(uploaded.isError).toBeFalsy();
      const media = uploaded.structuredContent?.media;
      expect(media).toMatchObject({ mime: 'image/png', filename: 'cover.png', alt: 'Couverture' });
      expect(media.url).toMatch(new RegExp(`^${SITE}/media/[a-f0-9]{64}\\.png$`));
      const again = await call(client, 'upload_media', { data: `data:image/png;base64,${png}` });
      expect(again.structuredContent).toMatchObject({ deduplicated: true, media: { id: media.id } });

      const listed = await call(client, 'list_media', {});
      expect(listed.structuredContent?.media.map((item: { id: string }) => item.id)).toEqual([media.id]);
      const alt = await call(client, 'update_media_alt', { id: media.id, alt: 'Nouvelle' });
      expect(alt.structuredContent?.media.alt).toBe('Nouvelle');
    });

    it('upload_media refuses a file that is not an allowed type', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'));
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const result = await call(client, 'upload_media', { data: svg.toString('base64'), filename: 'x.png' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('unsupported_type');
    });

    it('upload_media refuses a file over the size limit', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'));
      const big = Buffer.alloc(ctx.genga.config.media?.maxUploadBytes ?? 20_000_001).toString('base64');
      const result = await call(client, 'upload_media', { data: big });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('too_large');
    });

    it('upload_media refuses a URL to a private address or to a port other than 80 and 443', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'));
      for (const url of [
        'http://127.0.0.1/a.png',
        'http://10.0.0.1/a.png',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/a.png',
        'http://localhost/a.png',
        'http://93.184.216.34:6379/a.png',
        'https://files.example:8443/a.png',
        'file:///etc/passwd',
      ]) {
        const result = await call(client, 'upload_media', { url });
        expect(result.isError, url).toBe(true);
        expect(text(result), url).toMatch(/url_blocked|fetch_failed/);
      }
      const [{ count }] = await ctx.genga.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_media`;
      expect(count).toBe(0);
    });

    it('refuses an upload port outside 1 to 65535', () => {
      for (const port of [0, 65536, 80.5]) {
        expect(() =>
          createGenga(testConfig, { databaseUrl: TEST_URL, siteUrl: SITE, mcp: { uploadPorts: [443, port] } }),
        ).toThrow('mcp.uploadPorts must hold ports from 1 to 65535');
      }
    });

    it('upload_media allows few downloads at once per token', async () => {
      const slow = createGenga(testConfig, {
        databaseUrl: TEST_URL,
        siteUrl: SITE,
        mediaDir: ctx.mediaDir,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        mcp: { remoteFetch: { lookup: () => new Promise(() => {}), timeoutMs: 1000 } },
      });
      try {
        const editor = await createUser(ctx.genga, 'editor');
        const { token } = await ctx.genga.tokens.create(editor, { name: 'slow', scopes: ALL });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
          fetch: (input, init) => slow.mcp(new Request(input, init)),
        });
        const client = new Client({ name: 'genga-test', version: '1.0.0' });
        await client.connect(transport);
        clients.push(client);
        const results = await Promise.all(
          Array.from({ length: 6 }, () => call(client, 'upload_media', { url: 'http://slow.example/a.png' })),
        );
        const refused = results.filter((result) => text(result).includes('too_many_downloads'));
        expect(refused).toHaveLength(3);
      } finally {
        await slow.close();
      }
    });

    it('preview_url gives the preview and the editor URLs', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Aperçu', slug: 'apercu' });
      const result = await call(await connect(editor), 'preview_url', { id });
      expect(result.structuredContent).toEqual({
        previewUrl: `${SITE}/journal/apercu?genga-preview=${id}`,
        editorUrl: `${SITE}/admin/collections/journal/${id}`,
      });
    });

    it('writes an audit entry with via mcp and the token id for each write', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const token = await ctx.genga.tokens.create(editor, { name: 'audit', scopes: ALL });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { authorization: `Bearer ${token.token}` } },
        fetch: (input, init) => ctx.genga.mcp(new Request(input, init)),
      });
      const client = new Client({ name: 'genga-test', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);

      const created = await call(client, 'create_document', { collection: 'journal', data: { title: 'Audit' } });
      const { id } = created.structuredContent as { id: string };
      await call(client, 'update_draft', { id, draftRev: 1, data: { excerpt: 'e' } });
      await call(client, 'publish_document', { id, draftRev: 2 });
      const [version] = (await call(client, 'list_versions', { id })).structuredContent?.versions ?? [];
      await call(client, 'restore_version', { id, versionId: version.id, draftRev: 2 });
      await call(client, 'unpublish_document', { id });

      const rows = await ctx.genga.sql<{ action: string; user_id: string; detail: Record<string, unknown> }[]>`
        SELECT action, user_id, detail FROM genga_audit WHERE document_id = ${id} ORDER BY id
      `;
      expect(rows.map((row) => row.action)).toEqual([
        'document.create',
        'document.update',
        'document.publish',
        'document.restore',
        'document.unpublish',
      ]);
      for (const row of rows) {
        expect(row.user_id).toBe(editor.id);
        expect(row.detail).toMatchObject({ via: 'mcp', tokenId: token.item.id });
      }
      await ctx.genga.documents.saveVersion(editor, id, 'admin');
      await ctx.genga.documents.publish(editor, id, 3);
      const [adminEntry] = await ctx.genga.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM genga_audit WHERE document_id = ${id} ORDER BY id DESC LIMIT 1
      `;
      expect(adminEntry.detail.via).toBeUndefined();
    });
  });

  describe('resources and prompt', () => {
    it('the prompt needs the read scope', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'), ['publish']);
      await expect(
        client.getPrompt({ name: 'write_article', arguments: { collection: 'journal', topic: 'x' } }),
      ).rejects.toThrow(/read/);
    });

    it('treats inherited property names as unknown collections', async () => {
      const client = await connect(await createUser(ctx.genga, 'editor'));
      for (const name of ['__proto__', 'constructor', 'toString']) {
        const created = await call(client, 'create_document', { collection: name, data: { title: 'x' } });
        expect(text(created), name).toContain('Collection inconnue');
        const listed = await call(client, 'list_documents', { collection: name });
        expect(text(listed), name).toContain('Collection inconnue');
        await expect(client.readResource({ uri: `genga://collections/${name}/schema` })).rejects.toThrow(
          /Unknown collection/,
        );
        await expect(
          client.getPrompt({ name: 'write_article', arguments: { collection: name, topic: 'x' } }),
        ).rejects.toThrow(/Unknown collection/);
      }
    });

    it('reads the schema and the document resources', async () => {
      const editor = await createUser(ctx.genga, 'editor');
      const client = await connect(editor);
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual(['genga://collections/journal/schema']);
      const schema = await client.readResource({ uri: 'genga://collections/journal/schema' });
      expect(JSON.parse((schema.contents[0] as { text: string }).text)).toMatchObject({ name: 'journal' });

      const { id } = await ctx.genga.documents.create(editor, 'journal', { title: 'Ressource' });
      const doc = await client.readResource({ uri: `genga://documents/${id}` });
      expect(JSON.parse((doc.contents[0] as { text: string }).text).document).toMatchObject({ id, draftRev: 1 });
      await expect(client.readResource({ uri: 'genga://collections/unknown/schema' })).rejects.toThrow();
    });

    it('the write_article prompt lists the fields and the block types', async () => {
      const client = await connect(await createUser(ctx.genga, 'author'));
      const prompt = await client.getPrompt({
        name: 'write_article',
        arguments: { collection: 'journal', topic: 'Le MCP' },
      });
      const message = (prompt.messages[0].content as { text: string }).text;
      expect(message).toContain('Le MCP');
      expect(message).toContain('- body (blocks)');
      expect(message).toContain('- rich-text (Texte)');
      expect(message).toContain('create_document');
    });
  });
});
