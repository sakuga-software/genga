# MCP server

Genga has a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. An AI
client, for example Claude Code, Claude Desktop, Cursor or VS Code, connects to it and works
with your content: it reads the collections and their blocks, writes drafts, uploads media,
and, if you allow it, publishes.

The server uses the Streamable HTTP transport. It is stateless: each request is complete in
itself, and the server keeps no session. Every write goes through the same services as the
admin, with the same validation, the same access rules and an entry in the audit log.

## Enable it

### Headless server

The [headless server](./headless-server.md) serves MCP at `/mcp` by default.

| Variable         | Default | Purpose                                                                       |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `GENGA_MCP`      | `on`    | `off` turns the endpoint off: its path answers like any unknown path.         |
| `GENGA_MCP_PATH` | `/mcp`  | One path segment. It cannot be the admin path or a path that the server uses. |

The endpoint URL is `GENGA_PUBLIC_URL` plus the path, for example
`https://cms.example.com/mcp`.

### In your React Router app

`genga.mcp(request)` is a fetch-style handler: it takes a `Request` and returns a `Response`.
Route POST, GET and DELETE of one path to it. With React Router, a resource route does this:

```ts
// app/routes.ts
route('/mcp', 'routes/mcp.ts'),
```

```ts
// app/routes/mcp.ts
import { genga } from '../.server/genga';

export const loader = ({ request }: { request: Request }) => genga.mcp(request);
export const action = ({ request }: { request: Request }) => genga.mcp(request);
```

Any other framework that speaks `Request` and `Response` (Hono, Next.js route handlers,
Remix, Bun, Deno) can call it the same way. The option `mcp.allowedOrigins` of `createGenga`
sets the browser origins that can call it (see [Security](#security-model)).

## Create a token

MCP clients cannot use the admin cookie. They send a personal access token in a header:

```http
Authorization: Bearer gga_…
```

1. In the admin, open **Réglages › Jetons d’accès**. Every role has this page.
2. Give the token a name (for example « Claude Code, portable »), choose its scopes and its
   expiry, then select **Créer le jeton**.
3. Copy the token. The admin shows it once: Genga stores only its SHA-256 hash.

| Scope     | Lets the token                                                             |
| --------- | -------------------------------------------------------------------------- |
| `read`    | read the collections, the documents, the versions and the media.           |
| `write`   | create and change drafts, restore versions, upload media, change alt text. |
| `publish` | publish and unpublish documents.                                           |

A token never has more rights than its user. The rights of a request are the scopes of the
token **and** the role of the user, both:

- An author token with the `publish` scope still cannot publish, because the author role
  cannot.
- An editor token without the `publish` scope cannot publish, because the token cannot.
- An author token sees and changes only the documents that the author created. The SQL
  queries apply this rule, as in the admin.
- Collection `access` overrides apply too.

Genga checks the user on each request. A change of role applies at once. A disabled user
loses its tokens: disabling revokes them, and enabling the user again does not bring them
back. A deleted user loses its tokens too.

The page lists your tokens with their scopes, their last use, their creation date and their
expiry. **Révoquer** stops a token at once. An administrator also sees the tokens of the other
people and can revoke them. A user can have 50 active tokens.

## Connect a client

Replace the URL with your endpoint, and `gga_…` with your token.

### Claude Code

```sh
claude mcp add --transport http genga https://cms.example.com/mcp \
  --header "Authorization: Bearer gga_…"
```

### Claude Desktop

Claude Desktop starts local servers. The `mcp-remote` package connects it to a remote server
with a header:

```json
{
  "mcpServers": {
    "genga": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://cms.example.com/mcp", "--header", "Authorization:${GENGA_AUTH}"],
      "env": { "GENGA_AUTH": "Bearer gga_…" }
    }
  }
}
```

The file is `claude_desktop_config.json` (**Settings › Developer › Edit Config**). Keep no
space around the colon in `--header`: some systems split arguments on spaces.

### Cursor

`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "genga": {
      "url": "https://cms.example.com/mcp",
      "headers": { "Authorization": "Bearer gga_…" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`. The `inputs` entry asks for the token once and keeps it in the secret
storage of VS Code, out of the file:

```json
{
  "inputs": [{ "type": "promptString", "id": "genga-token", "description": "Genga token", "password": true }],
  "servers": {
    "genga": {
      "type": "http",
      "url": "https://cms.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:genga-token}" }
    }
  }
}
```

### MCP Inspector

To try the endpoint by hand:

```sh
npx @modelcontextprotocol/inspector --cli https://cms.example.com/mcp --transport http \
  --header "Authorization: Bearer gga_…" --method tools/list
```

## Tools

Every tool validates its input with a JSON schema, and returns structured content plus a
short text. An error comes back as a tool result with `isError: true` and a message that says
what to do next: the scope that is missing, the role that cannot do the action, the
validation issues with their path, or the current `draftRev` after a conflict.

| Tool                 | Scope     | Input                                                                                                          | Result                                                                                              |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `list_collections`   | `read`    | none                                                                                                           | The readable collections: fields, block types, your rights, and the JSON format of each field type. |
| `list_documents`     | `read`    | `collection`, `status` (`draft`, `published`, `changed`, `all`), `search`, `tag`, `limit` (1 to 100), `cursor` | `documents`, `nextCursor`.                                                                          |
| `get_document`       | `read`    | `id`, or `collection` and `slug`                                                                               | The draft, the published data, `draftRev`, the five latest versions.                                |
| `create_document`    | `write`   | `collection`, `data`                                                                                           | `id`, `slug`, `draftRev` (1). The draft is not published.                                           |
| `update_draft`       | `write`   | `id`, `draftRev`, `data`, `mode` (`merge` or `replace`)                                                        | The new `draftRev` and status.                                                                      |
| `publish_document`   | `publish` | `id`, `draftRev`                                                                                               | The URL of the page.                                                                                |
| `unpublish_document` | `publish` | `id`                                                                                                           | The status. The draft stays.                                                                        |
| `list_versions`      | `read`    | `id`                                                                                                           | The versions, newest first.                                                                         |
| `restore_version`    | `write`   | `id`, `versionId`, `draftRev`                                                                                  | The new `draftRev`. It does not publish.                                                            |
| `list_media`         | `read`    | `search`, `limit` (1 to 200)                                                                                   | The media items, with absolute URLs.                                                                |
| `upload_media`       | `write`   | `data` (base64 or a `data:` URL) or `url` (public http or https), `filename`, `alt`                            | The media item. The same bytes give the same item.                                                  |
| `update_media_alt`   | `write`   | `id`, `alt`                                                                                                    | The media item.                                                                                     |
| `preview_url`        | `read`    | `id`                                                                                                           | The preview URL of the draft, and the URL of the editor.                                            |

Notes:

- `update_draft` in `merge` mode replaces the top-level fields that `data` contains and keeps
  the other fields. In `replace` mode, `data` is the whole draft. Both modes need the
  `draftRev` that you read last. If someone saved the document in between, the tool refuses
  the change and gives the current `draftRev`: read the document again, merge, and retry.
- `publish_document` validates the required fields, like the **Publier** button.
- `preview_url` gives the same URL as the preview of the editor. On the origin of the admin,
  the preview needs a session in the admin. On another origin, the URL carries a preview
  token that is valid 10 minutes for this document.
- Rich text is TipTap JSON. `list_collections` describes the format of each field type.

## Resources

| URI                                 | Content                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `genga://collections/{name}/schema` | The fields and the block types of a collection, as JSON. The list gives one per readable collection. |
| `genga://documents/{id}`            | The document, as `get_document` gives it.                                                            |

Both need the `read` scope and follow the same access rules as the tools.

## Prompt

`write_article` takes a `collection`, a `topic` and an optional `audience`. It gives the agent
the fields and the block types of the collection, and these steps: find or upload images,
create the draft with blocks, fix the validation errors, give the preview URL to a human, and
publish only when a human asks.

## Security model

- **Authentication.** Every request needs `Authorization: Bearer gga_…`. Without it, or with a
  token that is unknown, revoked, expired or of a disabled user, the answer is `401` with a
  `WWW-Authenticate: Bearer` header. The endpoint never reads the session cookie.
- **Rights.** Scopes ∩ role, checked on each request with the current role (see
  [Create a token](#create-a-token)). Tokens cannot create or revoke tokens: only an admin
  session can, through the admin API.
- **Token storage.** The database keeps the SHA-256 of each token, never the token. The token
  has 256 random bits, so a hash without salt is enough. The `gga_` prefix lets secret
  scanners find a leaked token.
- **Rate limit.** 20 bad tokens from one client address in 15 minutes give a `429` for that
  address. The address comes from `X-Forwarded-For` and `trustedProxies`, as for the login.
  If the address is unknown (no `X-Forwarded-For` behind a proxy that you declared), the
  limit does not apply, because all clients would share one counter. Set `trustedProxies`
  to the real number of proxies.
- **Origin.** A request without an `Origin` header (a CLI, a desktop app, a server) passes. A
  browser request must come from an allowed origin: by default the site origin and
  `allowedOrigins`. `Origin: null` is refused. This protects a local server from DNS
  rebinding, as the MCP specification asks. The endpoint sends no CORS headers, so a web page
  on another origin cannot read its answers. On the headless server, React Router also
  refuses a POST whose `Origin` is not the origin of the server.
- **Audit.** Each write adds an entry to `genga_audit` with `via: "mcp"` and the token id in
  `detail`: `document.create`, `document.update`, `document.publish`, `document.unpublish`,
  `document.restore`, `media.upload` and `media.update`. Token creation and revocation add
  `token.create` and `token.revoke`.
- **Remote media (`upload_media` with `url`).** The server downloads the file with these rules:
  only `http` and `https`, no credentials in the URL; every address of the host must be
  public (private, loopback, link-local, shared, multicast and reserved ranges are refused,
  for IPv4, IPv6 and IPv6 forms that embed an IPv4 address); the socket connects to the
  address that passed the check, so DNS rebinding cannot change it; each redirect is checked
  again, up to 3; the connection of a redirect or an error closes at once; the download
  stops at the upload size limit and after 15 seconds; one token runs 3 downloads at most at
  the same time. A host without a public address gives one error, whatever the reason, so the
  error tells nothing about the internal network. The file
  then goes through the same checks as an upload in the admin: the real type comes from the
  bytes, and only JPEG, PNG, WebP, AVIF, GIF and PDF pass.
- **Limits.** The body of a request is limited to the upload size limit in base64, plus
  64 KiB (at least 2 MB).

Advice:

- Give each client its own token, with the smallest scopes and an expiry. Prefer `read` and
  `write`, and publish from the admin.
- Keep tokens out of files that you commit. Use the secret storage of the client, or an
  environment variable.
- Revoke a token that you do not use any more, or that could have leaked.
- Serve the endpoint over HTTPS only.

## Limits

- No OAuth: the client sends a token that you create in the admin.
- Stateless: no server-to-client notifications, no resumable streams. `GET` and `DELETE`
  answer `405`.
- `list_documents` searches the title and the slug only, and filters `tag` on the draft.
- `list_versions` gives the 100 latest versions.
- Tools cannot delete documents or media. Use the admin.
- The rate limit of bad tokens is in memory, per process.
