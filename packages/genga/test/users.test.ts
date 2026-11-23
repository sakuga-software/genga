import { describe, expect, it } from 'vitest';
import { createUser, useGenga } from './helpers';

describe('users', () => {
  const ctx = useGenga();

  it('keeps one active admin when two admins demote each other at the same time', async () => {
    for (let run = 0; run < 10; run += 1) {
      await ctx.genga.sql`TRUNCATE genga_users CASCADE`;
      const a = await createUser(ctx.genga, 'admin');
      const b = await createUser(ctx.genga, 'admin');
      const results = await Promise.allSettled([
        ctx.genga.users.update(a, b.id, { role: 'editor' }),
        ctx.genga.users.update(b, a.id, { disabled: true }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const [{ count }] = await ctx.genga.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM genga_users WHERE role = 'admin' AND disabled_at IS NULL
      `;
      expect(count).toBe(1);
    }
  });

  it('answers 404 for a user id that is not a UUID', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    await expect(ctx.genga.users.update(admin, 'x', { role: 'editor' })).rejects.toMatchObject({ status: 404 });
    await expect(ctx.genga.users.resetLink(admin, 'x')).rejects.toMatchObject({ status: 404 });
  });
});
