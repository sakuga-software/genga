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

`/admin` sends `X-Robots-Tag: noindex`, `Content-Security-Policy: frame-ancestors 'self'` and
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

Drafts render only for a signed-in user who can read the collection, and only on the route of
the document. Preview responses are never cached by a shared cache.
