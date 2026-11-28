import { createStaticHandler, isRouteErrorResponse, type StaticHandlerContext } from 'react-router';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server';
import { createUser, request, SITE, useGenga } from './helpers';

const PASSWORD = 'a-long-test-password';

/**
 * The deprecated admin route modules call `genga.admin.*` from their loaders and actions. This test
 * runs them in React Router, next to the admin API of `genga.handle`, on one database.
 */
describe('deprecated admin route modules', () => {
  const ctx = useGenga();

  function handler() {
    const admin = ctx.genga.admin;
    return createStaticHandler([
      {
        id: 'shell',
        path: '/admin',
        ErrorBoundary: () => null,
        children: [
          {
            id: 'login',
            path: 'login',
            loader: ({ request }) => admin.loginLoader(request),
            action: ({ request }) => admin.loginAction(request),
          },
          {
            id: 'app',
            loader: ({ request }) => admin.layout(request),
            children: [
              { id: 'dashboard', index: true, loader: ({ request }) => admin.dashboard(request) },
              {
                id: 'collection',
                path: 'collections/:collection',
                loader: ({ request, params }) => admin.collection(request, params.collection as string),
              },
            ],
          },
        ],
      },
    ]);
  }

  async function signedInUser() {
    const user = await createUser(ctx.genga, 'editor', 'legacy@genga.test');
    await ctx.genga.sql`UPDATE genga_users SET password_hash = ${await hashPassword(PASSWORD)} WHERE id = ${user.id}`;
    return user;
  }

  it('redirects to the login page without a session', async () => {
    const result = await handler().query(request('/admin/collections/journal'));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fcollections%2Fjournal');
  });

  it('logs in with a redirect that carries the cookie, and the cookie works in the admin API', async () => {
    await signedInUser();
    const form = new URLSearchParams({ email: 'legacy@genga.test', password: PASSWORD, next: '/admin/media' });
    const result = await handler().query(
      request('/admin/login', {
        method: 'POST',
        headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/media');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^genga=/);
    const api = await ctx.genga.handle(request('/admin/api/views/layout', { cookie }));
    expect(api?.status).toBe(200);
  });

  it('gives the form error as action data', async () => {
    await signedInUser();
    const form = new URLSearchParams({ email: 'legacy@genga.test', password: 'not-the-password' });
    const result = (await handler().query(
      request('/admin/login', {
        method: 'POST',
        headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
    )) as StaticHandlerContext;
    expect(result.actionData?.login).toEqual({ error: expect.any(String) });
  });

  it('turns a service error into an error response with the message', async () => {
    const user = await signedInUser();
    const cookie = await ctx.genga.auth.createSession(user.id, request('/'));
    const result = (await handler().query(request('/admin/collections/unknown', { cookie }))) as StaticHandlerContext;
    const error = result.errors?.shell;
    expect(isRouteErrorResponse(error)).toBe(true);
    expect(error).toMatchObject({ status: 404, data: { message: 'Collection inconnue.' } });
  });

  it('reads the same data as the admin API', async () => {
    const user = await signedInUser();
    const cookie = await ctx.genga.auth.createSession(user.id, request('/'));
    const result = (await handler().query(request('/admin', { cookie }))) as StaticHandlerContext;
    const api = await (await ctx.genga.handle(request('/admin/api/views/dashboard', { cookie })))?.json();
    expect(result.loaderData.dashboard).toEqual(api);
    const layout = await (await ctx.genga.handle(request('/admin/api/views/layout', { cookie })))?.json();
    expect(JSON.parse(JSON.stringify(result.loaderData.app))).toEqual(layout);
  });
});
