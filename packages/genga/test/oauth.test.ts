import { createHash, randomBytes } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublicUser } from '../src/types';
import { createGenga, type Genga } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, request, SITE, testConfig, useGenga } from './helpers';

const MCP_URL = `${SITE}/mcp`;
const CALLBACK = 'http://127.0.0.1:33418/callback';
const METADATA_URL = 'https://client.example/oauth/client.json';

class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | null = null;

  constructor(
    readonly redirectUrl = CALLBACK,
    readonly clientMetadataUrl?: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

function form(values: Record<string, string | string[]>) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  }
  return params;
}

describe('OAuth for the MCP server', () => {
  const ctx = useGenga();
  let genga: Genga;
  let metadataDocument: Record<string, unknown>;
  const clients: Client[] = [];

  beforeAll(async () => {
    genga = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      mediaDir: ctx.mediaDir,
      secureCookies: false,
      logger: { info: () => {}, warn: () => {}, error: console.error },
      mcp: {
        oauth: {
          fetchClientMetadata: async (url) => {
            if (url !== METADATA_URL) throw new Error('unknown document');
            return {
              body: Buffer.from(JSON.stringify(metadataDocument)),
              filename: 'client.json',
              contentType: 'application/json',
              url,
            };
          },
        },
      },
    });
    await genga.ready();
  });

  beforeEach(() => {
    genga.oauth?.resetRateLimits();
    genga.tokens.resetRateLimits();
    metadataDocument = {
      client_id: METADATA_URL,
      client_name: 'Metadata client',
      client_uri: 'https://client.example',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
    };
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await genga.close();
  });

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) =>
    (await genga.handle(new Request(input, init))) ?? new Response('Not found', { status: 404 });

  function oauth() {
    if (!genga.oauth) throw new Error('OAuth is off');
    return genga.oauth;
  }

  async function sessionOf(user: PublicUser) {
    return genga.auth.createSession(user.id, request('/'));
  }

  /** Opens the consent screen, then answers it. Returns the redirect to the client. */
  async function consent(
    user: PublicUser,
    url: URL,
    answer: Record<string, string | string[]> = { decision: 'allow', scope: ['read', 'write'] },
  ): Promise<URL> {
    const cookie = await sessionOf(user);
    const page = await genga.admin.oauthAuthorizeLoader(request(`${url.pathname}${url.search}`, { cookie }));
    expect(page.valid).toBe(true);
    try {
      const result = await genga.admin.oauthAuthorizeAction(
        request(`${url.pathname}${url.search}`, {
          method: 'POST',
          cookie,
          headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
          body: form(answer),
        }),
      );
      throw new Error(`No redirect: ${JSON.stringify(result)}`);
    } catch (thrown) {
      if (!(thrown instanceof Response)) throw thrown;
      return new URL(thrown.headers.get('location') ?? '');
    }
  }

  /** The whole flow of the SDK client: discovery, registration, consent, code exchange. */
  async function connect(user: PublicUser, provider = new MemoryProvider(), scopes = ['read', 'write']) {
    expect(await auth(provider, { serverUrl: MCP_URL, fetchFn })).toBe('REDIRECT');
    const back = await consent(user, provider.authorizationUrl as URL, { decision: 'allow', scope: scopes });
    expect(back.searchParams.get('iss')).toBe(SITE);
    const code = back.searchParams.get('code') as string;
    expect(await auth(provider, { serverUrl: MCP_URL, authorizationCode: code, fetchFn })).toBe('AUTHORIZED');
    return provider;
  }

  async function mcpClient(provider: MemoryProvider) {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: fetchFn });
    const client = new Client({ name: 'genga-oauth-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  function mcpPost(token: string) {
    return fetchFn(MCP_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  }

  async function tokenRequest(values: Record<string, string>) {
    return fetchFn(`${SITE}/admin/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(values),
    });
  }

  describe('discovery', () => {
    it('answers 401 with the resource metadata URL and the default scopes', async () => {
      const response = await fetchFn(MCP_URL, { method: 'POST', body: '{}' });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer realm="genga", resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
      );
      const bad = await mcpPost(`ggo_${'x'.repeat(43)}`);
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
    });

    it('serves the protected resource metadata at the path and at the root', async () => {
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const response = await fetchFn(`${SITE}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(await response.json()).toMatchObject({
          resource: MCP_URL,
          authorization_servers: [SITE],
          scopes_supported: ['read', 'write'],
        });
      }
    });

    it('serves the authorization server metadata with PKCE, CIMD and iss', async () => {
      const response = await fetchFn(`${SITE}/.well-known/oauth-authorization-server`);
      expect(await response.json()).toMatchObject({
        issuer: SITE,
        authorization_endpoint: `${SITE}/admin/oauth/authorize`,
        token_endpoint: `${SITE}/admin/api/oauth/token`,
        registration_endpoint: `${SITE}/admin/api/oauth/register`,
        revocation_endpoint: `${SITE}/admin/api/oauth/revoke`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      });
      const preflight = await fetchFn(`${SITE}/admin/api/oauth/token`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('is off without the mcp option, and with oauth: false', async () => {
      expect(ctx.genga.oauth).toBeNull();
      expect(await ctx.genga.handle(request('/.well-known/oauth-authorization-server'))).toBeNull();
      const off = createGenga(testConfig, { databaseUrl: TEST_URL, siteUrl: SITE, mcp: { oauth: false } });
      try {
        expect(off.oauth).toBeNull();
        expect(await off.handle(request('/.well-known/oauth-protected-resource/mcp'))).toBeNull();
      } finally {
        await off.close();
      }
    });
  });

  describe('the flow of a real client', () => {
    it('registers, asks consent, exchanges the code, and calls the tools with the rights of the user', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor);
      expect(provider.info?.client_id).toMatch(/^ggc_/);
      expect(provider.saved).toMatchObject({ token_type: 'Bearer', scope: 'read write', expires_in: 3600 });
      expect(provider.saved?.access_token).toMatch(/^ggo_/);
      expect(provider.saved?.refresh_token).toMatch(/^ggr_/);

      const client = await mcpClient(provider);
      const created = (await client.callTool({
        name: 'create_document',
        arguments: { collection: 'journal', data: { title: 'Par OAuth' } },
      })) as CallToolResult & { structuredContent?: { id: string } };
      expect(created.isError).toBeFalsy();
      const published = (await client.callTool({
        name: 'publish_document',
        arguments: { id: created.structuredContent?.id, draftRev: 1 },
      })) as CallToolResult;
      expect(published.isError).toBe(true);
      expect((published.content as { text: string }[])[0].text).toContain(
        'connect this client again and allow the "publish" scope',
      );

      const [entry] = await genga.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM genga_audit WHERE action = 'document.create'
      `;
      const [grant] = await oauth().listGrants(editor);
      expect(entry.detail).toMatchObject({ via: 'mcp', grantId: grant.id, clientId: provider.info?.client_id });
      expect(grant).toMatchObject({ clientName: 'Test client', clientHost: null, scopes: ['read', 'write'] });
    });

    it('keeps the scopes ∩ role rule: an author with the publish scope cannot publish', async () => {
      const author = await createUser(genga, 'author');
      const provider = new MemoryProvider();
      expect(await auth(provider, { serverUrl: MCP_URL, fetchFn, scope: 'read write publish' })).toBe('REDIRECT');
      const page = await genga.admin.oauthAuthorizeLoader(
        request(`${provider.authorizationUrl?.pathname}${provider.authorizationUrl?.search}`, {
          cookie: await sessionOf(author),
        }),
      );
      expect(page).toMatchObject({ valid: true, scopes: ['read', 'write', 'publish'], canPublish: false });
      const back = await consent(author, provider.authorizationUrl as URL, {
        decision: 'allow',
        scope: ['read', 'write', 'publish'],
      });
      await auth(provider, { serverUrl: MCP_URL, authorizationCode: back.searchParams.get('code') ?? '', fetchFn });
      const client = await mcpClient(provider);
      const created = (await client.callTool({
        name: 'create_document',
        arguments: { collection: 'journal', data: { title: 'Auteur' } },
      })) as CallToolResult & { structuredContent?: { id: string } };
      const published = (await client.callTool({
        name: 'publish_document',
        arguments: { id: created.structuredContent?.id, draftRev: 1 },
      })) as CallToolResult;
      expect(published.isError).toBe(true);
      expect(JSON.stringify(published.content)).toContain('Forbidden');
    });

    it('uses a client metadata document as the client id', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor, new MemoryProvider(CALLBACK, METADATA_URL));
      expect(provider.info?.client_id).toBe(METADATA_URL);
      const [grant] = await oauth().listGrants(editor);
      expect(grant).toMatchObject({ clientName: 'Metadata client', clientHost: 'client.example' });
      expect((await mcpPost(provider.saved?.access_token ?? '')).status).toBe(200);
    });

    it('refuses a metadata document whose client_id is not its URL', async () => {
      metadataDocument.client_id = 'https://other.example/client.json';
      const provider = new MemoryProvider(CALLBACK, METADATA_URL);
      await auth(provider, { serverUrl: MCP_URL, fetchFn });
      const editor = await createUser(genga, 'editor');
      const url = provider.authorizationUrl as URL;
      const page = await genga.admin.oauthAuthorizeLoader(
        request(`${url.pathname}${url.search}`, { cookie: await sessionOf(editor) }),
      );
      expect(page.valid).toBe(false);
    });

    it('sends a person without a session to the login page, and keeps the request in next', async () => {
      const provider = new MemoryProvider();
      await auth(provider, { serverUrl: MCP_URL, fetchFn });
      const url = provider.authorizationUrl as URL;
      const thrown = await genga.admin
        .oauthAuthorizeLoader(request(`${url.pathname}${url.search}`))
        .catch((error) => error);
      expect(thrown).toBeInstanceOf(Response);
      const location = new URL((thrown as Response).headers.get('location') ?? '', SITE);
      expect(location.pathname).toBe('/admin/login');
      expect(location.searchParams.get('next')).toBe(`${url.pathname}${url.search}`);
    });

    it('sends access_denied when the person refuses', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = new MemoryProvider();
      await auth(provider, { serverUrl: MCP_URL, fetchFn });
      const back = await consent(editor, provider.authorizationUrl as URL, { decision: 'deny' });
      expect(back.searchParams.get('error')).toBe('access_denied');
      expect(back.searchParams.get('state')).toBe(provider.authorizationUrl?.searchParams.get('state'));
      expect(await oauth().listGrants(editor)).toEqual([]);
    });

    it('grants only the scopes that the person keeps', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor, new MemoryProvider(), ['read']);
      expect(provider.saved?.scope).toBe('read');
      const client = await mcpClient(provider);
      const result = (await client.callTool({
        name: 'create_document',
        arguments: { collection: 'journal', data: { title: 'Non' } },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    });

    it('lets the person add the publish scope that the client did not ask for', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor, new MemoryProvider(), ['read', 'write', 'publish']);
      expect(provider.authorizationUrl?.searchParams.get('scope')).toBe('read write');
      expect(provider.saved?.scope).toBe('read write publish');
    });
  });

  describe('authorization requests', () => {
    async function registered(redirectUris = [CALLBACK]) {
      const response = await fetchFn(`${SITE}/admin/api/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Manual',
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { client_id: string };
    }

    function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        resource: MCP_URL,
        ...extra,
      });
      return { verifier, url: new URL(`${SITE}/admin/oauth/authorize?${params}`) };
    }

    async function load(user: PublicUser, url: URL) {
      return genga.admin
        .oauthAuthorizeLoader(request(`${url.pathname}${url.search}`, { cookie: await sessionOf(user) }))
        .catch((error: unknown) => {
          if (error instanceof Response) return new URL(error.headers.get('location') ?? '');
          throw error;
        });
    }

    it('shows an error page, never a redirect, for an unknown client or redirect URI', async () => {
      const editor = await createUser(genga, 'editor');
      const { client_id } = await registered();
      expect(await load(editor, authorizeQuery('unknown').url)).toMatchObject({ valid: false });
      const other = authorizeQuery(client_id, { redirect_uri: 'https://evil.example/callback' }).url;
      expect(await load(editor, other)).toMatchObject({ valid: false });
    });

    it('accepts another port on a loopback redirect URI', async () => {
      const editor = await createUser(genga, 'editor');
      const { client_id } = await registered();
      const page = await load(
        editor,
        authorizeQuery(client_id, { redirect_uri: 'http://127.0.0.1:51234/callback' }).url,
      );
      expect(page).toMatchObject({ valid: true, nativeRedirect: true, redirectTarget: 'http://127.0.0.1:51234' });
    });

    it('sends the other errors to the client: no PKCE, plain PKCE, another resource, unknown scopes', async () => {
      const editor = await createUser(genga, 'editor');
      const { client_id } = await registered();
      const cases: [Record<string, string>, string][] = [
        [{ code_challenge: '' }, 'invalid_request'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
        [{ scope: 'admin' }, 'invalid_scope'],
        [{ response_type: 'token' }, 'unsupported_response_type'],
      ];
      for (const [extra, error] of cases) {
        const result = await load(editor, authorizeQuery(client_id, extra).url);
        expect(result).toBeInstanceOf(URL);
        expect((result as URL).searchParams.get('error')).toBe(error);
        expect((result as URL).searchParams.get('state')).toBe('xyz');
        expect((result as URL).searchParams.get('iss')).toBe(SITE);
      }
    });

    it('refuses a consent posted from another origin', async () => {
      const editor = await createUser(genga, 'editor');
      const { client_id } = await registered();
      const { url } = authorizeQuery(client_id);
      const thrown = await genga.admin
        .oauthAuthorizeAction(
          request(`${url.pathname}${url.search}`, {
            method: 'POST',
            cookie: await sessionOf(editor),
            headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
            body: form({ decision: 'allow', scope: 'read' }),
          }),
        )
        .catch((error: unknown) => error);
      expect(thrown).toMatchObject({ init: { status: 403 } });
    });

    it('refuses the code with a bad verifier, and revokes the grant when a code comes back', async () => {
      const editor = await createUser(genga, 'editor');
      const { client_id } = await registered();
      const { url, verifier } = authorizeQuery(client_id);
      const code = (await consent(editor, url)).searchParams.get('code') as string;
      const base = { grant_type: 'authorization_code', client_id, code, redirect_uri: CALLBACK, resource: MCP_URL };

      const wrong = await tokenRequest({ ...base, code_verifier: randomBytes(32).toString('base64url') });
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });

      const second = authorizeQuery(client_id);
      const code2 = (await consent(editor, second.url)).searchParams.get('code') as string;
      const ok = await tokenRequest({ ...base, code: code2, code_verifier: second.verifier });
      expect(ok.status).toBe(200);
      const { access_token } = (await ok.json()) as { access_token: string };
      expect((await mcpPost(access_token)).status).toBe(200);

      const replay = await tokenRequest({ ...base, code: code2, code_verifier: second.verifier });
      expect(replay.status).toBe(400);
      expect((await mcpPost(access_token)).status).toBe(401);
      expect(verifier).toBeTruthy();
    });

    it('rotates refresh tokens, and a reused refresh token ends the grant', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor);
      const client_id = provider.info?.client_id as string;
      const first = provider.saved?.refresh_token as string;
      const rotated = await tokenRequest({ grant_type: 'refresh_token', client_id, refresh_token: first });
      expect(rotated.status).toBe(200);
      const next = (await rotated.json()) as { access_token: string; refresh_token: string };
      expect(next.refresh_token).not.toBe(first);
      expect((await mcpPost(next.access_token)).status).toBe(200);

      const wider = await tokenRequest({
        grant_type: 'refresh_token',
        client_id,
        refresh_token: next.refresh_token,
        scope: 'read write publish',
      });
      expect(await wider.json()).toMatchObject({ error: 'invalid_scope' });

      const reused = await tokenRequest({ grant_type: 'refresh_token', client_id, refresh_token: first });
      expect(reused.status).toBe(400);
      expect((await mcpPost(next.access_token)).status).toBe(401);
      expect(await oauth().listGrants(editor)).toEqual([]);
    });

    it('authenticates a confidential client with client_secret_basic', async () => {
      const editor = await createUser(genga, 'editor');
      const response = await fetchFn(`${SITE}/admin/api/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Web', redirect_uris: ['https://app.example/callback'] }),
      });
      const registration = (await response.json()) as { client_id: string; client_secret: string };
      expect(registration.client_secret).toMatch(/^ggs_/);
      const { url, verifier } = authorizeQuery(registration.client_id, {
        redirect_uri: 'https://app.example/callback',
      });
      const code = (await consent(editor, url)).searchParams.get('code') as string;
      const body = { grant_type: 'authorization_code', code, code_verifier: verifier };
      const basic = (secret: string) =>
        `Basic ${Buffer.from(`${registration.client_id}:${secret}`).toString('base64')}`;
      const denied = await fetchFn(`${SITE}/admin/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('wrong') },
        body: form(body),
      });
      expect(denied.status).toBe(401);
      const ok = await fetchFn(`${SITE}/admin/api/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(registration.client_secret),
        },
        body: form(body),
      });
      expect(ok.status).toBe(200);
    });

    it('refuses dangerous redirect URIs at registration, and accepts a private-use scheme', async () => {
      for (const uri of [
        'javascript:alert(1)',
        'http://example.com/callback',
        'https://app.example/cb#frag',
        'data:text/html,x',
      ]) {
        const response = await fetchFn(`${SITE}/admin/api/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [uri] }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
      }
      await registered(['cursor://anysphere.cursor-mcp/oauth/callback', 'http://localhost:8787/callback']);
    });

    it('limits the registrations of one address', async () => {
      const send = () =>
        fetchFn(`${SITE}/admin/api/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ redirect_uris: [CALLBACK] }),
        });
      for (let index = 0; index < 30; index += 1) expect((await send()).status).toBe(201);
      expect((await send()).status).toBe(429);
    });
  });

  describe('revocation', () => {
    it('revokes from the admin, lists grants on the tokens page, and stops on a disabled user', async () => {
      const admin = await createUser(genga, 'admin');
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor);
      const token = provider.saved?.access_token as string;

      const page = await genga.admin.tokens(request('/admin/tokens', { cookie: await sessionOf(admin) }));
      expect(page.mcpUrl).toBe(MCP_URL);
      expect(page.allGrants?.map((grant) => grant.user.id)).toEqual([editor.id]);

      const [grant] = await oauth().listGrants(editor);
      const response = await fetchFn(`${SITE}/admin/api/grants/${grant.id}`, {
        method: 'DELETE',
        headers: { cookie: (await sessionOf(admin)).split(';')[0], origin: SITE },
      });
      expect(response.status).toBe(200);
      expect((await mcpPost(token)).status).toBe(401);

      const again = await connect(editor);
      expect((await mcpPost(again.saved?.access_token as string)).status).toBe(200);
      await genga.users.update(admin, editor.id, { disabled: true });
      expect((await mcpPost(again.saved?.access_token as string)).status).toBe(401);
      expect(await oauth().listGrants(editor)).toEqual([]);
    });

    it('revokes with the revocation endpoint of the client', async () => {
      const editor = await createUser(genga, 'editor');
      const provider = await connect(editor);
      const response = await fetchFn(`${SITE}/admin/api/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ token: provider.saved?.refresh_token as string, client_id: provider.info?.client_id as string }),
      });
      expect(response.status).toBe(200);
      expect((await mcpPost(provider.saved?.access_token as string)).status).toBe(401);
    });

    it('does not let an editor revoke the grant of another person', async () => {
      const editor = await createUser(genga, 'editor');
      const other = await createUser(genga, 'editor');
      await connect(editor);
      const [grant] = await oauth().listGrants(editor);
      await expect(oauth().revokeGrant(other, grant.id)).rejects.toMatchObject({ status: 404 });
    });

    it('keeps personal tokens working', async () => {
      const editor = await createUser(genga, 'editor');
      const { token } = await genga.tokens.create(editor, { name: 'perso', scopes: ['read'] });
      expect((await mcpPost(token)).status).toBe(200);
    });
  });
});
