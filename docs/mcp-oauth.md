# MCP OAuth: design note

This note records how Genga implements the authorization of the
[MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
and why. The user documentation is in [mcp.md](./mcp.md#connect-with-oauth).

## Goal

An MCP client (Claude, Cursor, VS Code) connects to the endpoint with its URL only. The client
opens a Genga page in the browser, the person approves, and the client gets its tokens. Nobody
copies a token. The rights stay the same as for a personal token: the scopes of the grant and
the role of the user, both, checked on each request with the current role.

## Roles

- **Resource server**: the MCP endpoint (`<mcp.path>`). Its resource identifier is the origin of
  `siteUrl` plus the MCP path, for example `https://cms.example.com/mcp`.
- **Authorization server**: Genga itself, on the same origin. The issuer is the origin of
  `siteUrl`. Genga builds every URL from `siteUrl`, never from the `Host` header.

## Endpoints

| Path                                             | Standard | Notes                                            |
| ------------------------------------------------ | -------- | ------------------------------------------------ |
| `/.well-known/oauth-protected-resource<mcpPath>` | RFC 9728 | Also at `/.well-known/oauth-protected-resource`. |
| `/.well-known/oauth-authorization-server`        | RFC 8414 | No OpenID Connect discovery.                     |
| `<adminPath>/oauth/authorize`                    | RFC 6749 | The consent page, an admin route.                |
| `<adminPath>/api/oauth/token`                    | RFC 6749 | `authorization_code` and `refresh_token`.        |
| `<adminPath>/api/oauth/register`                 | RFC 7591 | Dynamic client registration.                     |
| `<adminPath>/api/oauth/revoke`                   | RFC 7009 | Revokes the whole grant.                         |

The token, registration and revocation endpoints are under `<adminPath>/api` because every app
already routes that path to `genga.handle`. `genga.handle` answers them before the admin API,
without the session and the origin check of the admin API. They send
`Access-Control-Allow-Origin: *` and no cookies, because browser clients (the MCP Inspector)
call them. The metadata documents do the same.

The authorization server metadata shows the admin path. The consent page must be in the admin,
because it uses the admin session, so this does not hide anything that a person who signs in
does not see.

## Client registration

The specification prefers client ID metadata documents (CIMD) and keeps dynamic client
registration (DCR) as deprecated. Genga supports both, because the clients use both today:

- Claude Code identifies itself with a metadata document.
- claude.ai and Cursor register with DCR. Cursor sends `cursor://…`, `https://…` and
  `http://localhost:8787/…` redirect URIs.

**CIMD.** A `client_id` that is an `https` URL with a path is a metadata document. Genga
downloads it with the SSRF rules of `upload_media` (public addresses only, no redirect, 16 KiB,
5 seconds), checks that its `client_id` is its URL, that it has `client_name` and 1 to 10 valid
`redirect_uris`, and that `token_endpoint_auth_method` is `none` or absent. Genga keeps the
document 1 hour in `genga_oauth_clients`, then downloads it again. It does not read the cache
headers of the document.

**DCR.** The endpoint is open, as MCP clients expect. To limit abuse: 30 registrations per
client address per hour, 10 redirect URIs at most, 2000 characters per URI, and a registered
client that never starts an authorization request is deleted after 24 hours. A client can ask
for `none`, `client_secret_basic` or `client_secret_post`. Genga stores the hash of the secret.

**Redirect URIs.** Allowed: `https`, `http` on `localhost`, `127.0.0.1` or `[::1]`, and
private-use schemes for native apps (RFC 8252), except schemes that run code or read files
(`javascript`, `data`, `file`, `vbscript`, `blob`, `about`, `ftp`, `ws`, `wss`). No fragment, no
credentials. The match is exact, except the port of a loopback `http` URI (RFC 8252, 7.3).

## Authorization request

The consent page checks the request when it shows the page and again when it receives the
answer. It never trusts its own form: the form posts the original query string back.

1. An unknown client, a missing redirect URI with more than one registered URI, or a redirect
   URI of another client shows an error page. Genga never redirects to an unchecked URI.
2. Every other error goes back to the client with `error`, `state` and `iss`:
   `response_type` other than `code`, no PKCE or a method other than `S256`, a `resource` other
   than the MCP endpoint, a `scope` with no known scope.
3. Without a session, the page sends the person to the login page, with the request in `next`.
4. The page shows the client name, the URL of its metadata document or « registered
   automatically », the host of `client_uri`, the scheme and host of the redirect URI, and a
   warning when the redirect URI is on the computer (loopback or private-use scheme). It does
   not load `logo_uri`.
5. The page lists the three scopes and checks the scopes of the request. Without a `scope`
   parameter, the request asks `read write`. The person can remove a scope or add `publish`.
   The protected resource metadata gives `read write` as `scopes_supported`: the minimal set,
   as the specification asks, so a client does not ask for `publish` by default.
6. The form posts with a full page load (`reloadDocument`), so the browser follows the `302` to
   the client, also to a private-use scheme. The post passes the origin check of the admin. The
   page cannot be in a frame (`frame-ancestors 'none'`).

The code is single-use, valid 5 minutes, and bound to the client, the redirect URI, the PKCE
challenge, the scopes and the resource. The answer carries `iss` (RFC 9207).

## Tokens

| Token   | Prefix | Lifetime                     | Storage |
| ------- | ------ | ---------------------------- | ------- |
| Access  | `ggo_` | 1 hour                       | SHA-256 |
| Refresh | `ggr_` | 30 days, renewed on rotation | SHA-256 |

- A **grant** is one approval of one person for one client. It holds the scopes and the
  resource. It is the unit that the tokens page lists and revokes.
- The code exchange creates the grant. A second use of a code revokes the grant of the first use.
- Each refresh gives a new refresh token and marks the old one as used. A used refresh token
  that comes back revokes the grant (OAuth 2.1, 4.3.1). A refresh cannot add scopes.
- The MCP endpoint takes an access token only if its grant is active, its user is enabled, and
  its resource is this endpoint (audience check, RFC 8707).
- Bad OAuth tokens count in the same rate limit as bad personal tokens.

## Revocation

- The tokens page lists the active grants of the person (« Applications connectées »). An
  administrator also sees the grants of the others. **Déconnecter** revokes the grant and
  deletes its tokens at once.
- The revocation endpoint of the client revokes the grant of the token.
- Disabling a user revokes its grants, as it revokes its personal tokens.
- The audit log has `oauth.grant` and `oauth.revoke`, and each write of the MCP endpoint has
  `via: "mcp"` with `grantId` and `clientId`.

## Personal tokens

`gga_` tokens keep working on the same endpoint. The endpoint chooses the check from the prefix
of the bearer token. Without OAuth (`mcp.oauth: false`, or the deprecated `genga.mcp` without
the `mcp` option), the `401` stays `Bearer realm="genga"`.

## Choices against a SHOULD of the specification

- **Insufficient scope.** The specification asks for a `403` with `error="insufficient_scope"`
  when a token lacks a scope. Genga keeps a tool result with `isError: true`, as for personal
  tokens: the agent reads which scope is missing and tells the person, and the client does not
  open a browser in the middle of a tool call. The message asks the person to connect the client
  again with the scope.
- **Cache headers of metadata documents.** Genga keeps a document 1 hour, whatever its headers.
- **HTTPS.** The specification requires HTTPS for the authorization server. Genga does not
  refuse `http`, so that local development works. Serve the endpoint over HTTPS in production.

## Storage

Migration `0005_oauth` adds `genga_oauth_clients`, `genga_oauth_grants`, `genga_oauth_codes`
and `genga_oauth_tokens`. The database keeps the hash of every code, token and client secret.
