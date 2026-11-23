import { can, isRole } from '../access';
import type { PublicUser } from '../types';
import { isUuid } from '../uuid';
import { audit, toPublicUser, type GengaAuth } from './auth';
import type { GengaContext } from './context';
import { badRequest, forbidden, GengaError, isUniqueViolation, notFound } from './errors';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createUsers(ctx: GengaContext, auth: GengaAuth) {
  const { sql } = ctx;

  function assertManager(user: PublicUser) {
    if (!can(user, 'users.manage')) throw forbidden();
  }

  async function list(user: PublicUser): Promise<PublicUser[]> {
    assertManager(user);
    const rows = await sql<Parameters<typeof toPublicUser>[0][]>`
      SELECT id, email, name, role, created_at, disabled_at FROM genga_users ORDER BY created_at
    `;
    return rows.map(toPublicUser);
  }

  function inviteUrl(token: string) {
    return `${ctx.siteUrl}${ctx.adminPath}/setup?token=${token}`;
  }

  async function invite(user: PublicUser, input: { email?: unknown; name?: unknown; role?: unknown }) {
    assertManager(user);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
    if (!EMAIL_PATTERN.test(email)) throw badRequest('Adresse email invalide.');
    if (!isRole(input.role)) throw badRequest('Rôle inconnu.');
    try {
      const { user: invited, token } = await auth.invite(email, name, input.role);
      await audit(ctx, user.id, 'user.invite', { detail: { userId: invited.id, role: invited.role } });
      return { user: invited, link: inviteUrl(token) };
    } catch (error) {
      if (isUniqueViolation(error)) throw new GengaError(409, 'email_taken', 'Un compte existe déjà avec cet email.');
      throw error;
    }
  }

  /**
   * One transaction locks the target, the actor and all active admins, in id order.
   * Two admins who demote each other at the same time cannot leave zero admins.
   */
  async function update(user: PublicUser, id: string, input: { role?: unknown; disabled?: unknown }) {
    assertManager(user);
    if (!isUuid(id)) throw notFound('Utilisateur introuvable.');
    if (input.role !== undefined && !isRole(input.role)) throw badRequest('Rôle inconnu.');
    const row = await sql.begin(async (tx) => {
      const locked = await tx<{ id: string; role: string; disabled_at: Date | null }[]>`
        SELECT id, role, disabled_at FROM genga_users
        WHERE id = ${id} OR id = ${user.id} OR (role = 'admin' AND disabled_at IS NULL)
        ORDER BY id FOR UPDATE
      `;
      const actor = locked.find((candidate) => candidate.id === user.id);
      if (
        !actor ||
        actor.disabled_at ||
        !isRole(actor.role) ||
        !can({ id: actor.id, role: actor.role }, 'users.manage')
      ) {
        throw forbidden();
      }
      const target = locked.find((candidate) => candidate.id === id);
      if (!target) throw notFound('Utilisateur introuvable.');
      const demotes = input.role !== undefined && input.role !== 'admin' && target.role === 'admin';
      const disables = input.disabled === true && !target.disabled_at;
      if (id === user.id && (demotes || disables)) {
        throw badRequest('Vous ne pouvez pas retirer vos propres droits.');
      }
      const activeAdmins = locked.filter((candidate) => candidate.role === 'admin' && !candidate.disabled_at).length;
      if ((demotes || disables) && target.role === 'admin' && !target.disabled_at && activeAdmins <= 1) {
        throw badRequest('Il faut garder au moins un administrateur actif.');
      }
      if (input.role !== undefined) await tx`UPDATE genga_users SET role = ${input.role as string} WHERE id = ${id}`;
      if (typeof input.disabled === 'boolean') {
        await tx`UPDATE genga_users SET disabled_at = ${input.disabled ? tx`now()` : null} WHERE id = ${id}`;
        if (input.disabled) await tx`DELETE FROM genga_sessions WHERE user_id = ${id}`;
      }
      const [updated] = await tx<Parameters<typeof toPublicUser>[0][]>`
        SELECT id, email, name, role, created_at, disabled_at FROM genga_users WHERE id = ${id}
      `;
      return updated;
    });
    await audit(ctx, user.id, 'user.update', { detail: { userId: id, role: input.role, disabled: input.disabled } });
    return toPublicUser(row);
  }

  async function resetLink(user: PublicUser, id: string) {
    assertManager(user);
    if (!isUuid(id)) throw notFound('Utilisateur introuvable.');
    const [target] = await sql`SELECT id FROM genga_users WHERE id = ${id}`;
    if (!target) throw notFound('Utilisateur introuvable.');
    return { link: inviteUrl(await auth.resetLink(id)) };
  }

  return { list, invite, update, resetLink };
}

export type GengaUsers = ReturnType<typeof createUsers>;
