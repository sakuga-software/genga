# Security model

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Sessions

- Passwords: scrypt. Minimum length: `MIN_PASSWORD_LENGTH`.
- The session token is opaque and random. The database stores its sha256 only.
- Cookie `__Host-genga` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`) in production, and
  `genga` in development.
- 30-day sliding expiry. A new token at each login. Disabling a user closes all its sessions.
- Setup, invite and password links are one-time tokens, stored hashed, with an expiry.

## CSRF

Every non-GET request must carry an `Origin` header from the allowed origins, or
`Sec-Fetch-Site: same-origin`. A request with neither is refused. The allowed origins are the
origin of `siteUrl` plus `allowedOrigins`.

## Login limits

In memory, per process:

- Per address: 20 attempts in 15 minutes.
- Per email and address: 5 failures in 15 minutes.
- Per email from all addresses: after 5 failures, each attempt waits (up to 4 s), and 1,000
  failures in one hour give a 429. A correct password is never refused because of failures
  from other addresses.
- The setup form: 10 attempts per address in 15 minutes.

The client address is the one that the last trusted proxy added to `X-Forwarded-For`. Set
`trustedProxies` to the real number of proxies, or an attacker can choose its address.

## Admin responses

The admin (`/admin` by default) sends `X-Robots-Tag: noindex`, `Content-Security-Policy: frame-ancestors 'self'` and
`Cache-Control: private, no-store`.

## Content

- Every write is validated by the config schema (zod).
- Rich text is sanitized at write time and rendered from an allowlist. See [blocks](./blocks.md).
- `url` fields and links accept only `http`, `https`, `mailto`, `tel` and relative URLs.
  The check removes control characters first, so `java\tscript:` is refused.

## Media

- The server sniffs the real type of the file. SVG is refused.
- sharp limits the input pixels and drops the metadata.
- `/media/*` answers only for keys that match `^[a-f0-9]{64}(-w\d+)?\.[a-z0-9]+$` and have a
  database row. It sends `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'`. PDF files download as attachments.

## Preview

On the same origin, drafts render only for a signed-in user who can read the collection, and
only on the route of the document. Preview responses are never cached by a shared cache.

On another origin:

- The preview URL carries a token: an HMAC-SHA256 of the document id and an expiry, signed
  with `GENGA_SECRET`. It is valid 10 minutes and for one document. The comparison is in
  constant time.
- `GET /api/v1/preview/:id` answers `Cache-Control: no-store`, with CORS for the preview
  origins only, and needs no cookie.
- The editor sends `postMessage` to the exact origin of the preview URL and accepts messages
  only from that origin and that window. The frame does the same with the admin origin.
- Genga refuses to start if a `previewUrl` has an origin outside the preview origins, or if
  the secret is missing or shorter than 32 characters.
- The preview origins and the CORS origins never get write access: the CSRF check uses
  only the allowed origins.

## API tokens and MCP

Personal access tokens (`gga_…`) authenticate the [MCP endpoint](./mcp.md). The database
stores their SHA-256 only. Their rights are their scopes and the role of their user, both.
Disabling a user revokes its tokens. Only a signed-in session of the admin can create or revoke a token, never a token.
Writes through MCP add `via: "mcp"` and the token id to the audit entry. `upload_media`
downloads a URL only from public addresses, and checks each redirect again. See
[the security model of the MCP server](./mcp.md#security-model).

## Public API

The [headless server](./headless-server.md) serves published content only. It limits each
client address with a token bucket (`GENGA_RATE_LIMIT` per minute) and sends CORS headers
only to `GENGA_CORS_ORIGINS`. Media files of the server send
`Cross-Origin-Resource-Policy: cross-origin`, so that other origins can show them.

## Webhooks

[Publish webhooks](./events.md) are signed with HMAC-SHA256 in the Standard Webhooks format,
with a secret per receiver. Genga refuses to start if a webhook secret is `GENGA_SECRET`: the
receiver holds its secret, and the preview secret would let it sign a preview token for any
draft. The secret stays out of logs and error messages. Receivers reject a timestamp more than
5 minutes away, answer `401` on a bad signature, and ignore a `webhook-id` that they already
handled. The events endpoint and the webhooks carry only content that was live: a draft that
was never published gives no event.
