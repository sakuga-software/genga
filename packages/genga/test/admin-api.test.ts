import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server';
import { createUser, request, SITE, useGenga } from './helpers';

const PASSWORD = 'a-long-test-password';

describe('admin API for the admin app', () => {
  const ctx = useGenga();

  const call = (pathname: string, init: RequestInit & { cookie?: string } = {}) =>
    ctx.genga.handle(request(`/admin/api${pathname}`, init)) as Promise<Response>;

  const post = (pathname: string, body: unknown, init: { cookie?: string; origin?: string } = {}) =>
    call(pathname, {
      method: 'POST',
      cookie: init.cookie,
      headers: { origin: init.origin ?? SITE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function sessionOf(role: 'admin' | 'editor' | 'author') {
    const user = await createUser(ctx.genga, role);
    return { user, cookie: await ctx.genga.auth.createSession(user.id, request('/')) };
  }

  describe('sign-in routes', () => {
    it('describes the login page, with a safe next path only', async () => {
      const empty = await (await call('/session')).json();
      expect(empty).toEqual({ signedIn: false, needsSetup: true, next: '/admin', adminPath: '/admin' });
      await createUser(ctx.genga, 'admin');
      for (const [next, expected] of [
        ['/admin/media', '/admin/media'],
        ['https://evil.example/admin', '/admin'],
        ['//evil.example', '/admin'],
        ['/admin\\@evil', '/admin'],
        ['/administrator', '/admin'],
      ]) {
        const page = await (await call(`/session?next=${encodeURIComponent(next)}`)).json();
        expect(page, next).toMatchObject({ signedIn: false, needsSetup: false, next: expected });
      }
      const { cookie } = await sessionOf('editor');
      expect(await (await call('/session?next=/admin/users', { cookie })).json()).toMatchObject({
        signedIn: true,
        next: '/admin/users',
      });
    });

    it('logs in with the origin check, the password check and a safe location', async () => {
      const user = await createUser(ctx.genga, 'editor', 'login@genga.test');
      await ctx.genga.sql`UPDATE genga_users SET password_hash = ${await hashPassword(PASSWORD)} WHERE id = ${user.id}`;

      const foreign = await post(
        '/session',
        { email: 'login@genga.test', password: PASSWORD },
        { origin: 'https://evil.example' },
      );
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get('set-cookie')).toBeNull();

      const wrong = await post('/session', { email: 'login@genga.test', password: 'not-the-password' });
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect((await wrong.json()).message).toEqual(expect.any(String));
      expect(wrong.headers.get('set-cookie')).toBeNull();

      ctx.genga.auth.resetRateLimits();
      const ok = await post('/session', {
        email: 'login@genga.test',
        password: PASSWORD,
        next: 'https://evil.example',
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ location: '/admin' });
      const cookie = ok.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/^genga=.+HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect((await call('/views/layout', { cookie })).status).toBe(200);
    });

    it('refuses a sign-in body over the form limit', async () => {
      const big = await post('/session', { email: 'x@genga.test', password: 'x'.repeat(20_000) });
      expect(big.status).toBe(413);
    });

    it('describes and accepts a setup link', async () => {
      const token = (await ctx.genga.auth.ensureSetupToken()) as string;
      expect(await (await call('/setup?token=wrong')).json()).toEqual({ valid: false, adminPath: '/admin' });
      expect(await (await call(`/setup?token=${token}`)).json()).toMatchObject({ valid: true, kind: 'setup', token });

      const mismatch = await post('/setup', {
        token,
        name: 'A',
        email: 'a@genga.test',
        password: PASSWORD,
        confirm: 'other',
      });
      expect(mismatch.status).toBe(400);
      expect((await mismatch.json()).message).toBe('Les deux mots de passe diffèrent.');

      const foreign = await post(
        '/setup',
        { token, name: 'A', email: 'a@genga.test', password: PASSWORD, confirm: PASSWORD },
        { origin: 'https://evil.example' },
      );
      expect(foreign.status).toBe(403);

      const ok = await post('/setup', {
        token,
        name: 'A',
        email: 'a@genga.test',
        password: PASSWORD,
        confirm: PASSWORD,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ location: '/admin' });
      expect(ok.headers.get('set-cookie')).toMatch(/^genga=/);
      expect(await (await call(`/setup?token=${token}`)).json()).toMatchObject({ valid: false });
    });
  });

  describe('screen data', () => {
    it('needs a session for every screen', async () => {
      for (const view of ['layout', 'dashboard', 'collection/journal', 'document/x', 'media', 'users', 'tokens']) {
        const response = await call(`/views/${view}`);
        expect(response.status, view).toBe(401);
        expect(response.headers.get('cache-control'), view).toBe('private, no-store');
      }
    });

    it('gives the data of each screen in the shape of the route modules', async () => {
      const { user, cookie } = await sessionOf('admin');
      const created = await ctx.genga.documents.create(user, 'journal', { title: 'Hello', slug: 'hello' });

      expect(await (await call('/views/layout', { cookie })).json()).toMatchObject({
        adminPath: '/admin',
        user: { id: user.id },
        collections: [{ name: 'journal', canCreate: true }],
        canManageUsers: true,
        canDeleteMedia: true,
      });
      expect(await (await call('/views/dashboard', { cookie })).json()).toMatchObject({
        mediaCount: 0,
        recent: [{ id: created.id }],
      });
      const drafts = await (await call('/views/collection/journal?status=draft&q=Hel', { cookie })).json();
      expect(drafts).toMatchObject({ search: 'Hel', status: 'draft', documents: [{ id: created.id }] });
      const published = await (await call('/views/collection/journal?status=published', { cookie })).json();
      expect(published.documents).toEqual([]);
      expect((await (await call('/views/collection/journal?status=bogus', { cookie })).json()).status).toBe('all');
      expect((await call('/views/collection/unknown', { cookie })).status).toBe(404);

      const page = await (await call(`/views/document/${created.id}`, { cookie })).json();
      expect(page).toMatchObject({ document: { id: created.id }, versions: [] });
      expect(page.schema.collections.journal).toBeDefined();

      expect(await (await call('/views/media', { cookie })).json()).toEqual({
        media: [],
        canDelete: true,
        canUpload: true,
      });
      expect((await (await call('/views/users', { cookie })).json()).currentUserId).toBe(user.id);
      expect(await (await call('/views/tokens', { cookie })).json()).toMatchObject({
        tokens: [],
        allTokens: [],
        grants: [],
        allGrants: null,
        mcpUrl: null,
        canPublish: true,
      });
      expect((await call('/views/unknown', { cookie })).status).toBe(404);
    });

    it('keeps the role checks of the route modules', async () => {
      const { cookie } = await sessionOf('author');
      expect((await call('/views/users', { cookie })).status).toBe(403);
      expect(await (await call('/views/layout', { cookie })).json()).toMatchObject({ canManageUsers: false });
      expect(await (await call('/views/tokens', { cookie })).json()).toMatchObject({ allTokens: null });
    });

    it('answers 404 for the consent screen when OAuth is off', async () => {
      const { cookie } = await sessionOf('editor');
      expect((await call('/consent?client_id=x', { cookie })).status).toBe(404);
    });
  });
});
