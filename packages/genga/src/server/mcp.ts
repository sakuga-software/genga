import { McpError, ErrorCode, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { can, isOwnOnly, ROLE_LABELS, type ApiScope } from '../access';
import { serializeSchema } from '../config';
import type { Field } from '../fields/types';
import type { PublicUser } from '../types';
import { isUuid } from '../uuid';
import type { GengaApiTokens, TokenAuth } from './api-tokens';
import { audit, withAuditSource } from './auth';
import { JSON_BYTES, readBody, UPLOAD_OVERHEAD_BYTES } from './body';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { GengaError } from './errors';
import type { GengaMedia } from './media';
import { fetchRemoteFile, type RemoteFetchOptions } from './remote-fetch';

export type McpOptions = {
  /**
   * Browser origins that can call the MCP endpoint. A request without `Origin` (a CLI or a
   * desktop client) passes. Default: the allowed origins of the admin.
   */
  allowedOrigins?: string[];
  /** For tests: the DNS lookup and the address check of `upload_media` with a `url`. */
  remoteFetch?: Pick<RemoteFetchOptions, 'lookup' | 'isAllowedAddress' | 'timeoutMs'>;
};

type Services = {
  ctx: GengaContext;
  documents: GengaDocuments;
  media: GengaMedia;
  tokens: GengaApiTokens;
};

const SERVER_INFO = { name: 'genga', version: '1.0.0' };

const INSTRUCTIONS = `Genga is a CMS. Each collection has fields, and a "blocks" field holds a list of blocks.
1. Call list_collections first: it gives the fields, the blocks and the value format of each field type.
2. create_document makes a draft. update_draft changes it and needs the current draftRev (get_document gives it).
3. Give the preview_url to a human before you publish. Publish only when a human asks.
Your rights are the scopes of your token and the role of its user, whichever is smaller.`;

const VALUE_FORMATS: Record<Field['type'], string> = {
  text: 'string',
  textarea: 'string, can contain line breaks',
  slug: 'string of lowercase letters, digits and hyphens. Empty: Genga makes one from the title.',
  number: 'number or null',
  boolean: 'true or false',
  select: 'string: one of the option values',
  date: 'string "YYYY-MM-DD"',
  url: 'string: http, https, mailto, tel or a relative path',
  media: 'media id (uuid) from list_media or upload_media, or null',
  richText:
    'TipTap JSON: {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello","marks":[{"type":"bold"}]}]}]}. ' +
    'Nodes: paragraph, heading (attrs.level 2 to 4), bulletList, orderedList, listItem, blockquote, hardBreak, horizontalRule, codeBlock. ' +
    'Marks: bold, italic, strike, code, underline, link (attrs.href).',
  tags: 'array of strings (1 to 60 characters each)',
  array: 'array of objects with the item fields',
  group: 'object with the group fields',
  blocks: 'array of blocks: {"_type": "<block type>", ...the fields of the block}',
};

const DOCUMENT_STATUSES = ['draft', 'published', 'changed', 'all'] as const;
const uuid = z.string().describe('Document id (uuid)');
const draftRev = z.number().int().min(1).describe('The draftRev that you read last. A stale value gives a conflict.');
const data = z
  .looseObject({})
  .describe('Field values by field name. See list_collections for the fields and their format.');

type ToolOutput = { data: Record<string, unknown>; text: string };

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // Falls through to the error below.
  }
  throw new GengaError(400, 'bad_request', 'The cursor is not valid. Use the nextCursor of the previous page.');
}

/** A message that tells an agent what went wrong and what to do next. */
function describeError(error: unknown, user: PublicUser): string {
  if (!(error instanceof GengaError)) return 'Internal error. Try again later.';
  const details = error.details as { draftRev?: number } | undefined;
  switch (error.code) {
    case 'conflict':
      return `Conflict: the document changed after your last read. The current draftRev is ${details?.draftRev}. Call get_document, merge your change, then retry with draftRev ${details?.draftRev}.`;
    case 'forbidden':
      return `Forbidden: the role "${user.role}" (${ROLE_LABELS[user.role]}) of this token's user cannot do this action here. ${error.message}`;
    default: {
      const extra = error.details === undefined ? '' : ` Details: ${JSON.stringify(error.details)}`;
      return `${error.message} (${error.code}, HTTP ${error.status}).${extra}`;
    }
  }
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  const text = value.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text) || !text.length) {
    throw new GengaError(400, 'bad_request', 'data is not valid base64.');
  }
  if (Math.floor((text.length * 3) / 4) - 2 > maxBytes) {
    throw new GengaError(413, 'too_large', `The file is larger than ${maxBytes} bytes.`);
  }
  return Buffer.from(text, text.includes('-') || text.includes('_') ? 'base64url' : 'base64');
}

/**
 * The MCP server: one stateless server per request, over Streamable HTTP with JSON responses.
 * Every request needs `Authorization: Bearer gga_…`. Every write runs the admin services,
 * with `via: mcp` and the token id in the audit log.
 */
export function createMcp({ ctx, documents, media, tokens }: Services, options: McpOptions = {}) {
  const maxBodyBytes = Math.max(JSON_BYTES, Math.ceil(ctx.maxUploadBytes / 3) * 4 + UPLOAD_OVERHEAD_BYTES);

  function absolute(path: string) {
    return new URL(path, `${ctx.siteUrl}/`).href;
  }

  /** The public page of a document. A headless server shows its documents on another site (`siteLink`). */
  function pageUrl(path: string) {
    const site = ctx.siteLink && /^https?:\/\//.test(ctx.siteLink) ? ctx.siteLink.replace(/\/+$/, '') : ctx.siteUrl;
    return new URL(path, `${site}/`).href;
  }

  function editorUrl(collection: string, id: string) {
    return absolute(`${ctx.adminPath}/collections/${encodeURIComponent(collection)}/${id}`);
  }

  function buildServer({ user, token }: TokenAuth) {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    const has = (scope: ApiScope) => token.scopes.includes(scope);

    function missingScope(scope: ApiScope): CallToolResult {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `This token has no "${scope}" scope. Its scopes: ${token.scopes.join(', ')}. Create a token with the "${scope}" scope in the admin (Jetons d'accès).`,
          },
        ],
      };
    }

    async function run(scope: ApiScope, task: () => Promise<ToolOutput>): Promise<CallToolResult> {
      if (!has(scope)) return missingScope(scope);
      try {
        const result = await task();
        return { content: [{ type: 'text', text: result.text }], structuredContent: result.data };
      } catch (error) {
        if (!(error instanceof GengaError)) ctx.log.error('[genga] MCP tool error:', error);
        return { isError: true, content: [{ type: 'text', text: describeError(error, user) }] };
      }
    }

    function readableCollections() {
      return Object.entries(ctx.config.collections).filter(([, collection]) => can(user, 'read', collection.access));
    }

    function collectionSchema(name: string) {
      const schema = serializeSchema(ctx.config);
      const collection = ctx.config.collections[name];
      const blockFields = Object.values(collection.fields).filter((field) => field.type === 'blocks');
      const allowed = new Set(
        blockFields.flatMap((field) => (field.type === 'blocks' && field.allowed) || Object.keys(schema.blocks)),
      );
      return {
        name,
        label: collection.label,
        labelSingular: collection.labelSingular,
        titleField: collection.titleField,
        path: collection.path('{slug}'),
        fields: collection.fields,
        blocks: Object.values(schema.blocks).filter((block) => allowed.has(block.type)),
        rights: {
          create: has('write') && can(user, 'create', collection.access),
          update: has('write') && can(user, 'update', collection.access),
          publish: has('publish') && can(user, 'publish', collection.access),
          ownDocumentsOnly: isOwnOnly(user, collection.access),
        },
      };
    }

    async function documentView(id: string) {
      const doc = await documents.get(user, id);
      const [published, versions] = await Promise.all([
        documents.publishedData(user, id),
        documents.versions(user, id),
      ]);
      const collection = ctx.config.collections[doc.collection];
      return {
        document: {
          id: doc.id,
          collection: doc.collection,
          slug: doc.slug,
          title: doc.title,
          status: doc.status,
          draftRev: doc.draftRev,
          updatedAt: doc.updatedAt,
          publishedAt: doc.publishedAt,
          authorName: doc.authorName,
          path: collection.path(doc.slug),
          canPublish: has('publish') && doc.canPublish,
          editorUrl: editorUrl(doc.collection, doc.id),
          draft: doc.draft,
        },
        published,
        versions: { count: versions.length, recent: versions.slice(0, 5) },
      };
    }

    server.registerTool(
      'list_collections',
      {
        title: 'List collections',
        description:
          'Lists the collections that you can read, with their fields, their block types, your rights, and the JSON format of each field type. Call it before you write content.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () =>
        run('read', async () => {
          const collections = readableCollections().map(([name]) => collectionSchema(name));
          return {
            data: { collections, valueFormats: VALUE_FORMATS },
            text: collections.length
              ? `${collections.length} collection(s): ${collections.map((c) => `${c.name} (${c.label})`).join(', ')}.`
              : 'You cannot read any collection.',
          };
        }),
    );

    server.registerTool(
      'list_documents',
      {
        title: 'List documents',
        description:
          'Lists the documents of a collection, newest change first. Status: draft (never published), published (live and up to date), changed (live, with later draft changes) or all. An author sees only the documents that it created.',
        inputSchema: {
          collection: z.string().describe('Collection name, from list_collections'),
          status: z.enum(DOCUMENT_STATUSES).default('all'),
          search: z.string().max(200).optional().describe('Text in the title or the slug'),
          tag: z.string().max(60).optional().describe('A value of a tags field'),
          limit: z.number().int().min(1).max(100).default(20),
          cursor: z.string().max(200).optional().describe('nextCursor of the previous page'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        run('read', async () => {
          const offset = decodeCursor(args.cursor);
          const rows = await documents.list(user, args.collection, {
            status: args.status,
            search: args.search,
            tag: args.tag,
            limit: args.limit + 1,
            offset,
          });
          const page = rows.slice(0, args.limit);
          const nextCursor = rows.length > args.limit ? encodeCursor(offset + args.limit) : null;
          return {
            data: { documents: page, nextCursor },
            text: `${page.length} document(s)${nextCursor ? ', more with nextCursor' : ''}.`,
          };
        }),
    );

    server.registerTool(
      'get_document',
      {
        title: 'Get a document',
        description:
          'Gives one document by id, or by collection and slug: its draft, its published data, its draftRev and its recent versions.',
        inputSchema: {
          id: uuid.optional(),
          collection: z.string().optional(),
          slug: z.string().max(200).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        run('read', async () => {
          let id = args.id;
          if (!id) {
            if (!args.collection || !args.slug) {
              throw new GengaError(400, 'bad_request', 'Give an id, or a collection and a slug.');
            }
            id = await documents.findBySlug(user, args.collection, args.slug);
          }
          const view = await documentView(id);
          return {
            data: view,
            text: `${view.document.title} (${view.document.collection}/${view.document.slug}): ${view.document.status}, draftRev ${view.document.draftRev}.`,
          };
        }),
    );

    server.registerTool(
      'create_document',
      {
        title: 'Create a draft',
        description:
          'Creates a draft in a collection. data uses the fields of the collection (see list_collections). Missing fields take their default value. The draft is not published.',
        inputSchema: { collection: z.string(), data },
      },
      (args) =>
        run('write', async () => {
          const created = await documents.create(user, args.collection, args.data);
          return {
            data: {
              id: created.id,
              slug: created.slug,
              draftRev: 1,
              status: 'draft',
              editorUrl: editorUrl(args.collection, created.id),
            },
            text: `Draft ${created.id} created with the slug "${created.slug}" and draftRev 1.`,
          };
        }),
    );

    server.registerTool(
      'update_draft',
      {
        title: 'Update a draft',
        description:
          'Changes the draft of a document. mode "merge" (default) replaces only the top-level fields in data; mode "replace" replaces the whole draft. Needs the current draftRev. A published document stays live until you publish again.',
        inputSchema: { id: uuid, draftRev, data, mode: z.enum(['merge', 'replace']).default('merge') },
        annotations: { idempotentHint: false },
      },
      (args) =>
        run('write', async () => {
          let next: Record<string, unknown> = args.data;
          let collection: string;
          if (args.mode === 'merge') {
            const current = await documents.get(user, args.id);
            if (current.draftRev !== args.draftRev) {
              throw new GengaError(409, 'conflict', 'Conflict.', { draftRev: current.draftRev });
            }
            next = { ...current.draft, ...args.data };
            collection = current.collection;
          } else {
            collection = (await documents.get(user, args.id)).collection;
          }
          const saved = await documents.saveDraft(user, args.id, next, args.draftRev);
          await audit(ctx, user.id, 'document.update', {
            collection,
            documentId: args.id,
            detail: { draftRev: saved.draftRev, mode: args.mode },
          });
          const warning = saved.slugError ? ` Warning: ${saved.slugError}` : '';
          return {
            data: { ...saved, id: args.id },
            text: `Draft saved: draftRev ${saved.draftRev}, status ${saved.status}.${warning}`,
          };
        }),
    );

    server.registerTool(
      'publish_document',
      {
        title: 'Publish a document',
        description:
          'Publishes the current draft: it becomes the live version. Needs the publish scope and a role that can publish. Publish only when a human asks.',
        inputSchema: { id: uuid, draftRev },
        annotations: { destructiveHint: true },
      },
      (args) =>
        run('publish', async () => {
          const result = await documents.publish(user, args.id, args.draftRev);
          return {
            data: { ...result, id: args.id, url: pageUrl(result.previewPath) },
            text: `Published at ${pageUrl(result.previewPath)}.`,
          };
        }),
    );

    server.registerTool(
      'unpublish_document',
      {
        title: 'Unpublish a document',
        description: 'Takes a document offline. The draft stays. Needs the publish scope and a role that can publish.',
        inputSchema: { id: uuid },
        annotations: { destructiveHint: true },
      },
      (args) =>
        run('publish', async () => {
          const result = await documents.unpublish(user, args.id);
          return { data: { ...result, id: args.id }, text: 'The document is offline. Its draft stays.' };
        }),
    );

    server.registerTool(
      'list_versions',
      {
        title: 'List versions',
        description: 'Lists the saved versions of a document, newest first (100 at most).',
        inputSchema: { id: uuid },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        run('read', async () => {
          const versions = await documents.versions(user, args.id);
          return { data: { versions }, text: `${versions.length} version(s).` };
        }),
    );

    server.registerTool(
      'restore_version',
      {
        title: 'Restore a version',
        description:
          'Copies a version into the draft. It does not publish. The current draft is kept as a version first.',
        inputSchema: { id: uuid, versionId: z.string().describe('Version id from list_versions'), draftRev },
      },
      (args) =>
        run('write', async () => {
          const result = await documents.restore(user, args.id, args.versionId, args.draftRev);
          return {
            data: { id: args.id, draftRev: result.draftRev, status: result.status },
            text: `Version restored into the draft: draftRev ${result.draftRev}.`,
          };
        }),
    );

    server.registerTool(
      'list_media',
      {
        title: 'List media',
        description: 'Lists the media library, newest first. Use the id of a media in a media field.',
        inputSchema: {
          search: z.string().max(200).optional().describe('Text in the filename or the alt text'),
          limit: z.number().int().min(1).max(200).default(50),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        run('read', async () => {
          const items = (await media.list(user, { search: args.search, limit: args.limit })).map((item) => ({
            ...item,
            url: absolute(item.url),
            sizes: item.sizes.map((size) => ({ ...size, url: absolute(size.url) })),
          }));
          return { data: { media: items }, text: `${items.length} media item(s).` };
        }),
    );

    server.registerTool(
      'upload_media',
      {
        title: 'Upload a media',
        description:
          'Adds an image (JPEG, PNG, WebP, AVIF, GIF) or a PDF to the media library. Give data (base64) or url (a public http or https URL that the server downloads). The same bytes give the same media.',
        inputSchema: {
          data: z.string().optional().describe('The file as base64, or a data: URL'),
          url: z.string().max(2000).optional().describe('A public http(s) URL'),
          filename: z.string().max(200).optional(),
          alt: z.string().max(500).optional().describe('Text alternative for people who cannot see the image'),
        },
      },
      (args) =>
        run('write', async () => {
          if (Boolean(args.data) === Boolean(args.url)) {
            throw new GengaError(400, 'bad_request', 'Give data or url, not both.');
          }
          let body: Buffer;
          let filename = args.filename;
          if (args.data) {
            body = decodeBase64(args.data, ctx.maxUploadBytes);
          } else {
            const remote = await fetchRemoteFile(args.url as string, {
              ...options.remoteFetch,
              maxBytes: ctx.maxUploadBytes,
            });
            body = remote.body;
            filename ??= remote.filename;
          }
          const file = new File([new Uint8Array(body)], filename || 'fichier');
          const result = await media.upload(user, file, args.alt ?? '');
          const item = { ...result.media, url: absolute(result.media.url) };
          return {
            data: { media: item, deduplicated: result.deduplicated },
            text: result.deduplicated
              ? `This file is already in the library: media ${item.id}.`
              : `Uploaded media ${item.id} (${item.mime}).`,
          };
        }),
    );

    server.registerTool(
      'update_media_alt',
      {
        title: 'Change the alt text of a media',
        description: 'Changes the alt text of a media. The new text shows on every published page that uses the media.',
        inputSchema: { id: z.string().describe('Media id'), alt: z.string().max(500) },
      },
      (args) =>
        run('write', async () => {
          const item = await media.updateAlt(user, args.id, args.alt);
          await audit(ctx, user.id, 'media.update', { detail: { mediaId: item.id } });
          return { data: { media: { ...item, url: absolute(item.url) } }, text: 'Alt text saved.' };
        }),
    );

    server.registerTool(
      'preview_url',
      {
        title: 'Preview URL',
        description:
          'Gives the URL where a human sees the draft before it is published, and the URL of the editor. The same-origin preview needs a session in the admin.',
        inputSchema: { id: uuid },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        run('read', async () => {
          const doc = await documents.get(user, args.id);
          const previewUrl = doc.preview ? absolute(doc.preview.url) : null;
          const editor = editorUrl(doc.collection, doc.id);
          return {
            data: { previewUrl, editorUrl: editor },
            text: previewUrl
              ? `Preview: ${previewUrl}\nEditor: ${editor}`
              : `No preview for this collection. Editor: ${editor}`,
          };
        }),
    );

    server.registerResource(
      'collection-schema',
      new ResourceTemplate('genga://collections/{name}/schema', {
        list: async () => ({
          resources: has('read')
            ? readableCollections().map(([name, collection]) => ({
                uri: `genga://collections/${name}/schema`,
                name: `${collection.label} schema`,
                mimeType: 'application/json',
              }))
            : [],
        }),
      }),
      {
        title: 'Collection schema',
        description: 'The fields and blocks of a collection.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const name = String(variables.name);
        if (!has('read')) throw new McpError(ErrorCode.InvalidRequest, 'This token has no "read" scope.');
        const collection = ctx.config.collections[name];
        if (!collection || !can(user, 'read', collection.access)) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown collection: ${name}.`);
        }
        const body = { ...collectionSchema(name), valueFormats: VALUE_FORMATS };
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
      },
    );

    server.registerResource(
      'document',
      new ResourceTemplate('genga://documents/{id}', { list: undefined }),
      {
        title: 'Document',
        description: 'A document with its draft, published data and draftRev.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const id = String(variables.id);
        if (!has('read')) throw new McpError(ErrorCode.InvalidRequest, 'This token has no "read" scope.');
        if (!isUuid(id)) throw new McpError(ErrorCode.InvalidParams, 'The document id is not a uuid.');
        try {
          const view = await documentView(id);
          return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }] };
        } catch (error) {
          throw new McpError(ErrorCode.InvalidParams, describeError(error, user));
        }
      },
    );

    server.registerPrompt(
      'write_article',
      {
        title: 'Write an article',
        description: 'Guides you to draft a document in a collection with its fields and blocks.',
        argsSchema: {
          collection: z.string().describe('Collection name'),
          topic: z.string().describe('What the article is about'),
          audience: z.string().optional().describe('Who reads it'),
        },
      },
      ({ collection: name, topic, audience }) => {
        const collection = ctx.config.collections[name];
        if (!collection || !can(user, 'read', collection.access)) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown collection: ${name}. Call list_collections.`);
        }
        const schema = collectionSchema(name);
        const fieldLines = Object.entries(schema.fields).map(
          ([field, definition]) =>
            `- ${field} (${definition.type}${definition.required ? ', required to publish' : ''}): ${VALUE_FORMATS[definition.type]}`,
        );
        const blockLines = schema.blocks.map(
          (block) =>
            `- ${block.type} (${block.label}): fields ${Object.entries(block.fields)
              .map(([field, definition]) => `${field}: ${definition.type}`)
              .join(', ')}`,
        );
        const text = [
          `Write a ${collection.labelSingular.toLowerCase()} for the collection "${name}" about: ${topic}.`,
          audience ? `Audience: ${audience}.` : '',
          '',
          'Fields:',
          ...fieldLines,
          ...(blockLines.length ? ['', 'Block types for the blocks field:', ...blockLines] : []),
          '',
          'Steps:',
          '1. Call list_media if the article needs an image. Use upload_media for a new image, with an alt text.',
          `2. Call create_document with the collection "${name}" and the data. Put the body in blocks, one idea per block.`,
          '3. Read the validation errors, if any, and fix the data with update_draft and the draftRev that you got.',
          '4. Call preview_url and give the URL to the human. Do not publish unless the human asks.',
        ]
          .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
          .join('\n');
        return { messages: [{ role: 'user', content: { type: 'text', text } }] };
      },
    );

    return server;
  }

  function originAllowed(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (origin === null) return true;
    return origin !== 'null' && (options.allowedOrigins ?? ctx.allowedOrigins).includes(origin);
  }

  /** Answers a request to the MCP endpoint (POST, GET or DELETE). Mount it at a path like `/mcp`. */
  return async function handle(request: Request): Promise<Response> {
    if (!originAllowed(request)) return jsonRpcError(403, 'Origin not allowed.');
    let auth: TokenAuth | null;
    try {
      auth = await tokens.authenticate(request);
    } catch (error) {
      if (error instanceof GengaError && error.status === 429) {
        return jsonRpcError(429, error.message, { 'Retry-After': '900' });
      }
      ctx.log.error('[genga] MCP authentication error:', error);
      return jsonRpcError(500, 'Internal error.');
    }
    if (!auth) {
      const presented = request.headers.has('authorization');
      return jsonRpcError(
        401,
        presented
          ? 'The token is not valid: unknown, revoked, expired, or of a disabled user.'
          : 'Send Authorization: Bearer <token>. Create a token in the admin (Jetons d’accès).',
        {
          'WWW-Authenticate': presented ? 'Bearer realm="genga", error="invalid_token"' : 'Bearer realm="genga"',
        },
      );
    }
    if (request.method !== 'POST') {
      return jsonRpcError(405, 'This MCP server is stateless: send JSON-RPC messages with POST.', { Allow: 'POST' });
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(await readBody(request, maxBodyBytes)));
    } catch (error) {
      if (error instanceof GengaError) return jsonRpcError(error.status, error.message);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error.' }, id: null }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      );
    }
    const server = buildServer(auth);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await withAuditSource({ via: 'mcp', tokenId: auth.token.id }, () =>
        transport.handleRequest(request, { parsedBody }),
      );
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    } finally {
      await server.close().catch(() => {});
    }
  };
}

export type GengaMcp = ReturnType<typeof createMcp>;
