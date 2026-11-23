import { describe, expect, it } from 'vitest';
import { hashPassword, isAllowedOrigin } from '../src/server';
import { createUser, request, useGenga } from './helpers';

const ALLOWED = ['https://example.com'];

describe('origin check', () => {
  it('lets safe methods through', () => {
    expect(isAllowedOrigin(new Request('https://example.com/admin'), ALLOWED)).toBe(true);
  });

  it('accepts an allowed Origin and rejects another one', () => {
    const post = (headers: Record<string, string>) =>
      new Request('https://example.com/admin/api/x', { method: 'POST', headers });
    expect(isAllowedOrigin(post({ origin: 'https://example.com' }), ALLOWED)).toBe(true);
    expect(isAllowedOrigin(post({ origin: 'https://evil.example' }), ALLOWED)).toBe(false);
    expect(isAllowedOrigin(post({ origin: 'null' }), ALLOWED)).toBe(false);
  });

  it('accepts Sec-Fetch-Site same-origin without Origin, and rejects a request with neither', () => {
    const post = (headers: Record<string, string>) =>
      new Request('https://example.com/admin/api/x', { method: 'POST', headers });
    expect(isAllowedOrigin(post({ 'sec-fetch-site': 'same-origin' }), ALLOWED)).toBe(true);
    expect(isAllowedOrigin(post({ 'sec-fetch-site': 'cross-site' }), ALLOWED)).toBe(false);
    expect(isAllowedOrigin(post({}), ALLOWED)).toBe(false);
  });
});

describe('sessions', () => {
  const ctx = useGenga();

  async function userWithPassword(role: 'admin' | 'author' = 'admin') {
    const email = `${crypto.randomUUID()}@genga.test`;
    const user = await createUser(ctx.genga, role, email);
    await ctx.genga
      .sql`UPDATE genga_users SET password_hash = ${await hashPassword('un-mot-de-passe-long')} WHERE id = ${user.id}`;
    return { user, email };
  }

  it('logs in with the right password only', async () => {
    const { email } = await userWithPassword();
    await expect(ctx.genga.auth.login(request('/admin/login'), email, 'mauvais-mot-de-passe')).rejects.toMatchObject({
      status: 401,
    });
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email.toUpperCase(), 'un-mot-de-passe-long');
    expect(cookie).toMatch(/^genga=[\w-]+; Path=\/; HttpOnly; SameSite=Lax/);
    const user = await ctx.genga.auth.getUser(request('/admin', { cookie }));
    expect(user?.email).toBe(email);
  });

  it('stores only the hash of the session token', async () => {
    const { email } = await userWithPassword();
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    const token = cookie.split(';')[0].split('=')[1];
    const [row] = await ctx.genga.sql<{ token_hash: string }[]>`SELECT token_hash FROM genga_sessions`;
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an expired session', async () => {
    const { email } = await userWithPassword();
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    await ctx.genga.sql`UPDATE genga_sessions SET expires_at = now() - interval '1 minute'`;
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie }))).toBeNull();
  });

  it('extends a session that is in use (sliding expiry)', async () => {
    const { email } = await userWithPassword();
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    await ctx.genga
      .sql`UPDATE genga_sessions SET expires_at = now() + interval '1 day', refreshed_at = now() - interval '2 hours'`;
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie }))).not.toBeNull();
    const [row] = await ctx.genga.sql<
      { days: number }[]
    >`SELECT extract(day FROM expires_at - now())::int AS days FROM genga_sessions`;
    expect(row.days).toBeGreaterThanOrEqual(29);
  });

  it('revokes the sessions of a disabled user', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    const { user, email } = await userWithPassword('author');
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    await ctx.genga.users.update(admin, user.id, { disabled: true });
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie }))).toBeNull();
    const [{ count }] = await ctx.genga.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_sessions`;
    expect(count).toBe(0);
    await expect(ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long')).rejects.toMatchObject({
      status: 401,
    });
  });

  function from(ip: string) {
    return request('/admin/login', { headers: { 'x-forwarded-for': ip } });
  }

  it('limits the failures of one email from one address', async () => {
    const { email } = await userWithPassword();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(ctx.genga.auth.login(from('6.6.6.6'), email, 'faux')).rejects.toMatchObject({ status: 401 });
    }
    await expect(ctx.genga.auth.login(from('6.6.6.6'), email, 'un-mot-de-passe-long')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('lets the right password in after failures from other addresses', async () => {
    const { email } = await userWithPassword();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await ctx.genga.auth.login(from(`6.6.6.${attempt}`), email, 'faux').catch(() => {});
    }
    const { cookie } = await ctx.genga.auth.login(from('1.1.1.1'), email, 'un-mot-de-passe-long');
    expect(cookie).toMatch(/^genga=/);
  });

  it('counts parallel attempts before the password check', async () => {
    const { email } = await userWithPassword();
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.genga.auth.login(from('7.7.7.7'), email, 'faux').then(
          () => 200,
          (error: { status: number }) => error.status,
        ),
      ),
    );
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  });

  it('takes the client address after the trusted proxies, not from the first X-Forwarded-For value', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(
        ctx.genga.auth.login(from(`${attempt}.0.0.1, 8.8.8.8`), `nobody-${attempt}@genga.test`, 'faux'),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(ctx.genga.auth.login(from('99.0.0.1, 8.8.8.8'), 'other@genga.test', 'faux')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('reads a malformed cookie without an error', async () => {
    const { email } = await userWithPassword();
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    const token = cookie.split(';')[0];
    const user = await ctx.genga.auth.getUser(request('/admin', { headers: { cookie: `promo=50%; ${token}` } }));
    expect(user?.email).toBe(email);
  });

  it('deletes the previous session of the browser at login', async () => {
    const { email } = await userWithPassword();
    const first = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    const second = await ctx.genga.auth.login(
      request('/admin/login', { cookie: first.cookie }),
      email,
      'un-mot-de-passe-long',
    );
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie: first.cookie }))).toBeNull();
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie: second.cookie }))).not.toBeNull();
    const [{ count }] = await ctx.genga.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_sessions`;
    expect(count).toBe(1);
  });

  it('closes the other sessions when a reset link sets a new password', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    const { user, email } = await userWithPassword('author');
    const { cookie } = await ctx.genga.auth.login(request('/admin/login'), email, 'un-mot-de-passe-long');
    const { link } = await ctx.genga.users.resetLink(admin, user.id);
    const token = new URL(link).searchParams.get('token')!;
    const accepted = await ctx.genga.auth.acceptToken(request('/admin/setup'), token, {
      password: 'un-nouveau-mot-de-passe',
    });
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie }))).toBeNull();
    expect(await ctx.genga.auth.getUser(request('/admin', { cookie: accepted.cookie }))).not.toBeNull();
  });

  it('refuses an unknown token without an account change', async () => {
    await expect(
      ctx.genga.auth.acceptToken(request('/admin/setup'), 'not-a-token', { password: 'un-mot-de-passe-long' }),
    ).rejects.toMatchObject({ status: 410 });
    const [{ count }] = await ctx.genga.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_users`;
    expect(count).toBe(0);
  });

  it('limits the attempts on the setup form per address', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await ctx.genga.auth
        .acceptToken(from('5.5.5.5'), `wrong-${attempt}`, { password: 'un-mot-de-passe-long' })
        .catch((error: { status: number }) => statuses.push(error.status));
    }
    expect(statuses.slice(0, 10).every((status) => status === 410)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('creates the first admin from the one-time setup token', async () => {
    const token = await ctx.genga.auth.ensureSetupToken();
    expect(token).toBeTruthy();
    const { cookie } = await ctx.genga.auth.acceptToken(request('/admin/setup'), token!, {
      name: 'Mathieu',
      email: 'admin@genga.test',
      password: 'un-mot-de-passe-long',
    });
    expect((await ctx.genga.auth.getUser(request('/admin', { cookie })))?.role).toBe('admin');
    await expect(
      ctx.genga.auth.acceptToken(request('/admin/setup'), token!, {
        email: 'x@genga.test',
        password: 'un-mot-de-passe-long',
      }),
    ).rejects.toMatchObject({ status: 410 });
    expect(await ctx.genga.auth.ensureSetupToken()).toBeNull();
  });

  it('creates the first admin when only a disabled user exists', async () => {
    const seedUser = await createUser(ctx.genga, 'editor', 'seed@genga.invalid');
    await ctx.genga.sql`UPDATE genga_users SET disabled_at = now() WHERE id = ${seedUser.id}`;
    const token = await ctx.genga.auth.ensureSetupToken();
    expect(token).toBeTruthy();
    const { cookie } = await ctx.genga.auth.acceptToken(request('/admin/setup'), token!, {
      email: 'admin@genga.test',
      password: 'un-mot-de-passe-long',
    });
    expect((await ctx.genga.auth.getUser(request('/admin', { cookie })))?.role).toBe('admin');
  });

  it('rejects API writes from another origin', async () => {
    const response = await ctx.genga.api(
      new Request('http://genga.test/admin/api/documents', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      }),
      'documents',
    );
    expect(response.status).toBe(403);
  });
});
