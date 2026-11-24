import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createUser, request, useGenga } from './helpers';

function bearer(token: string, ip = '203.0.113.9') {
  return request('/mcp', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip } });
}

describe('API tokens', () => {
  const ctx = useGenga();

  it('stores only the sha256 of a gga_ token and shows the token once', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { token, item } = await ctx.genga.tokens.create(editor, { name: 'Claude', scopes: ['write', 'read'] });
    expect(token).toMatch(/^gga_[A-Za-z0-9_-]{43}$/);
    expect(item).toMatchObject({ name: 'Claude', scopes: ['read', 'write'], lastUsedAt: null, expiresAt: null });
    const rows = await ctx.genga.sql<{ token_hash: string }[]>`SELECT token_hash FROM genga_api_tokens`;
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex') }]);
    expect(JSON.stringify(await ctx.genga.tokens.list(editor))).not.toContain(token);
    const [entry] = await ctx.genga.sql<{ action: string; detail: Record<string, unknown> }[]>`
      SELECT action, detail FROM genga_audit WHERE action = 'token.create'
    `;
    expect(entry.detail).toMatchObject({ tokenId: item.id, scopes: ['read', 'write'] });
  });

  it('authenticates a valid token as its user and records the last use', async () => {
    const author = await createUser(ctx.genga, 'author');
    const { token, item } = await ctx.genga.tokens.create(author, { name: 'Cursor', scopes: ['read'] });
    const auth = await ctx.genga.tokens.authenticate(bearer(token));
    expect(auth?.user).toMatchObject({ id: author.id, role: 'author' });
    expect(auth?.token).toMatchObject({ id: item.id, scopes: ['read'] });
    const [listed] = await ctx.genga.tokens.list(author);
    expect(listed.lastUsedAt).not.toBeNull();
  });

  it('refuses bad input', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    await expect(ctx.genga.tokens.create(editor, { name: '', scopes: ['read'] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(ctx.genga.tokens.create(editor, { name: 'x', scopes: [] })).rejects.toMatchObject({ status: 400 });
    await expect(ctx.genga.tokens.create(editor, { name: 'x', scopes: ['admin'] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      ctx.genga.tokens.create(editor, { name: 'x', scopes: ['read'], expiresAt: '2001-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses unknown, malformed, revoked and expired tokens', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { token, item } = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
    await expect(ctx.genga.tokens.authenticate(bearer(`gga_${'A'.repeat(43)}`))).resolves.toBeNull();
    await expect(ctx.genga.tokens.authenticate(bearer('not-a-token'))).resolves.toBeNull();
    await expect(ctx.genga.tokens.authenticate(request('/mcp'))).resolves.toBeNull();

    await ctx.genga.tokens.revoke(editor, item.id);
    await expect(ctx.genga.tokens.authenticate(bearer(token))).resolves.toBeNull();
    expect(await ctx.genga.tokens.list(editor)).toEqual([]);

    const soon = await ctx.genga.tokens.create(editor, {
      name: 'b',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(ctx.genga.tokens.authenticate(bearer(soon.token))).resolves.not.toBeNull();
    await ctx.genga
      .sql`UPDATE genga_api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${soon.item.id}`;
    await expect(ctx.genga.tokens.authenticate(bearer(soon.token))).resolves.toBeNull();
    expect((await ctx.genga.tokens.list(editor))[0]).toMatchObject({ id: soon.item.id, expired: true });
  });

  it('revokes the tokens of a disabled user, also after the user is enabled again', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    const editor = await createUser(ctx.genga, 'editor');
    const { token } = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
    await ctx.genga.users.update(admin, editor.id, { disabled: true });
    await expect(ctx.genga.tokens.authenticate(bearer(token))).resolves.toBeNull();
    await ctx.genga.users.update(admin, editor.id, { disabled: false });
    await expect(ctx.genga.tokens.authenticate(bearer(token))).resolves.toBeNull();
  });

  it('refuses the token of a disabled user even before the revoke', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { token } = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
    await ctx.genga.sql`UPDATE genga_users SET disabled_at = now() WHERE id = ${editor.id}`;
    await expect(ctx.genga.tokens.authenticate(bearer(token))).resolves.toBeNull();
  });

  it('deletes the tokens of a deleted user', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
    await ctx.genga.sql`DELETE FROM genga_users WHERE id = ${editor.id}`;
    const [{ count }] = await ctx.genga.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_api_tokens`;
    expect(count).toBe(0);
  });

  it('lets a user revoke only its own tokens, and an admin revoke any token', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    const first = await createUser(ctx.genga, 'editor');
    const second = await createUser(ctx.genga, 'editor');
    const { item } = await ctx.genga.tokens.create(first, { name: 'a', scopes: ['read'] });
    await expect(ctx.genga.tokens.revoke(second, item.id)).rejects.toMatchObject({ status: 404 });
    expect(await ctx.genga.tokens.list(second, { all: true })).toEqual([]);
    expect(await ctx.genga.tokens.list(admin, { all: true })).toHaveLength(1);
    await ctx.genga.tokens.revoke(admin, item.id);
    expect(await ctx.genga.tokens.list(first)).toEqual([]);
    const [entry] = await ctx.genga.sql<{ user_id: string; detail: Record<string, unknown> }[]>`
      SELECT user_id, detail FROM genga_audit WHERE action = 'token.revoke'
    `;
    expect(entry).toMatchObject({ user_id: admin.id, detail: { tokenId: item.id, ownerId: first.id } });
  });

  it('answers 429 after 20 bad tokens from one address, and still accepts other addresses', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { token } = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await ctx.genga.tokens.authenticate(bearer(`gga_${'B'.repeat(43)}`, '198.51.100.20'));
    }
    await expect(ctx.genga.tokens.authenticate(bearer(token, '198.51.100.20'))).rejects.toMatchObject({
      status: 429,
    });
    await expect(ctx.genga.tokens.authenticate(bearer(token, '198.51.100.21'))).resolves.not.toBeNull();
  });

  it('does not lock out valid tokens when the client address is unknown', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { token } = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read'] });
    const noAddress = (value: string) => request('/mcp', { headers: { authorization: `Bearer ${value}` } });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await ctx.genga.tokens.authenticate(noAddress(`gga_${'C'.repeat(43)}`));
    }
    await expect(ctx.genga.tokens.authenticate(noAddress(token))).resolves.not.toBeNull();
  });

  it('serves the token routes of the admin API to a session only', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const { token } = await ctx.genga.tokens.create(editor, { name: 'a', scopes: ['read', 'write', 'publish'] });
    const response = await ctx.genga.api(
      request('/admin/api/tokens', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, origin: 'http://genga.test', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'b', scopes: ['read'] }),
      }),
      'tokens',
    );
    expect(response.status).toBe(401);
  });
});
