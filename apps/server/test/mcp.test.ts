import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createGenga, type Genga } from 'genga/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../app/.server/config-file';
import { TEST_URL } from './global-setup';

const config = parseConfig({
  collections: {
    posts: {
      label: 'Posts',
      path: '/blog/{slug}',
      fields: {
        title: { type: 'text', required: true },
        slug: { type: 'slug', from: 'title' },
        body: { type: 'blocks' },
      },
    },
  },
  blocks: [{ type: 'text', label: 'Text', fields: { content: { type: 'richText' } } }],
});

let genga: Genga;
let mediaDir: string;
let server: http.Server;
let baseUrl: string;

/** A plain Node server in front of `genga.handle`. The socket address goes in as the peer. */
async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', baseUrl), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
}

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-server-mcp-'));
  server = http.createServer(async (req, res) => {
    const request = await toRequest(req);
    const response =
      (await genga.handle(request, { peerAddress: req.socket.remoteAddress })) ??
      new Response('Not found', { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  genga = createGenga(config, {
    databaseUrl: TEST_URL,
    scheduler: false,
    siteUrl: baseUrl,
    siteLink: 'https://www.example.com',
    mediaDir,
    secureCookies: false,
    trustedProxies: 0,
    publicApi: true,
    mcp: { path: '/agents' },
    logger: { info: () => {}, warn: () => {}, error: console.error },
  });
  await genga.ready();
  await genga.sql`TRUNCATE genga_oauth_clients, genga_audit, genga_api_tokens, genga_documents, genga_users CASCADE`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await genga.close();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('MCP endpoint of the headless server', () => {
  it('drafts, publishes and serves a document over Streamable HTTP with the MCP SDK client', async () => {
    const { user } = await genga.auth.invite('mcp-editor@genga.test', 'Editor', 'editor');
    const { token } = await genga.tokens.create(user, { name: 'e2e', scopes: ['read', 'write', 'publish'] });
    const client = new Client({ name: 'genga-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/agents`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(14);

      const created = (await client.callTool({
        name: 'create_document',
        arguments: {
          collection: 'posts',
          data: {
            title: 'Hello from MCP',
            body: [
              {
                _type: 'text',
                content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] },
              },
            ],
          },
        },
      })) as CallToolResult;
      expect(created.isError).toBeFalsy();
      const { id, draftRev } = created.structuredContent as { id: string; draftRev: number };

      const published = (await client.callTool({
        name: 'publish_document',
        arguments: { id, draftRev },
      })) as CallToolResult;
      expect(published.isError).toBeFalsy();
      expect(published.structuredContent?.url).toBe('https://www.example.com/blog/hello-from-mcp');

      const response = await fetch(`${baseUrl}/api/v1/collections/posts/documents/hello-from-mcp`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { document: { id: string; data: { title: string } } };
      expect(body.document).toMatchObject({ id, data: { title: 'Hello from MCP' } });
    } finally {
      await client.close();
    }
  });

  it('answers 401 without a token, and leaves other paths to the router', async () => {
    const response = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer realm="genga", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/agents", scope="read write"`,
    );
    expect((await fetch(`${baseUrl}/mcp`, { method: 'POST' })).status).toBe(404);
  });

  it('signs in an SDK client with OAuth over HTTP, on the path of the setting', async () => {
    const resource = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/agents`);
    expect(await resource.json()).toMatchObject({ resource: `${baseUrl}/agents`, authorization_servers: [baseUrl] });

    const { user } = await genga.auth.invite('mcp-oauth@genga.test', 'OAuth', 'editor');
    let saved: OAuthTokens | undefined;
    let client: OAuthClientInformationMixed | undefined;
    let verifier = '';
    let authorizationUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: 'http://127.0.0.1:33418/callback',
      clientMetadata: {
        client_name: 'E2E',
        redirect_uris: ['http://127.0.0.1:33418/callback'],
        token_endpoint_auth_method: 'none',
      },
      clientInformation: () => client,
      saveClientInformation: (info) => {
        client = info;
      },
      tokens: () => saved,
      saveTokens: (tokens) => {
        saved = tokens;
      },
      redirectToAuthorization: (url) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
    };
    expect(await auth(provider, { serverUrl: `${baseUrl}/agents` })).toBe('REDIRECT');
    const url = authorizationUrl as URL;
    const cookie = (await genga.auth.createSession(user.id, new Request(baseUrl))).split(';')[0];
    const answer = await genga.admin
      .oauthAuthorizeAction(
        new Request(url, {
          method: 'POST',
          headers: { cookie, origin: baseUrl, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams([
            ['decision', 'allow'],
            ['scope', 'read'],
          ]),
        }),
      )
      .catch((thrown: unknown) => thrown);
    const code = new URL((answer as Response).headers.get('location') ?? '').searchParams.get('code') ?? '';
    expect(await auth(provider, { serverUrl: `${baseUrl}/agents`, authorizationCode: code })).toBe('AUTHORIZED');

    const mcp = new Client({ name: 'genga-e2e-oauth', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/agents`), { authProvider: provider }));
    try {
      expect((await mcp.listTools()).tools.length).toBe(14);
    } finally {
      await mcp.close();
    }
  });

  it('is off when the mcp option is false', async () => {
    const off = createGenga(config, {
      databaseUrl: TEST_URL,
      scheduler: false,
      siteUrl: baseUrl,
      mediaDir,
      mcp: false,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    try {
      expect(await off.handle(new Request(`${baseUrl}/agents`, { method: 'POST' }))).toBeNull();
      expect(await off.handle(new Request(`${baseUrl}/mcp`, { method: 'POST' }))).toBeNull();
    } finally {
      await off.close();
    }
  });
});
