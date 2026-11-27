import { describe, expect, it, vi } from 'vitest';
import { createGenga } from '../src/server';
import type { PublicUser } from '../src/types';
import { TEST_URL } from './global-setup';
import { createUser, SITE, testConfig, useGenga } from './helpers';

describe('scheduled publish and unpublish', () => {
  const ctx = useGenga();
  const HOUR = 3_600_000;

  async function draftDocument(user: PublicUser, title = 'Programmé') {
    const { id } = await ctx.genga.documents.create(user, 'journal', { title });
    return id;
  }

  /** Moves the schedule of a document into the past, as if its date had come. */
  async function makeDue(id: string, action: 'publish' | 'unpublish') {
    await ctx.genga.sql`
      UPDATE genga_schedules SET run_at = now() - interval '1 second' WHERE document_id = ${id} AND action = ${action}
    `;
  }

  async function auditActions(id: string) {
    const rows = await ctx.genga.sql<{ action: string; user_id: string | null; detail: Record<string, unknown> }[]>`
      SELECT action, user_id, detail FROM genga_audit WHERE document_id = ${id} ORDER BY id
    `;
    return rows;
  }

  async function eventTypes(id: string) {
    const rows = await ctx.genga.sql<{ type: string }[]>`
      SELECT type FROM genga_events WHERE event->>'documentId' = ${id} ORDER BY seq
    `;
    return rows.map((row) => row.type);
  }

  it('saves, reads and clears the dates of a schedule', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    const publishAt = new Date(Date.now() + HOUR).toISOString();
    const unpublishAt = new Date(Date.now() + 2 * HOUR).toISOString();

    const saved = await ctx.genga.documents.schedule(editor, id, { publishAt, unpublishAt });
    expect(saved.schedule).toEqual({
      publish: { at: publishAt, failedAt: null, error: null },
      unpublish: { at: unpublishAt, failedAt: null, error: null },
    });
    expect((await ctx.genga.documents.get(editor, id)).schedule).toEqual(saved.schedule);

    const cleared = await ctx.genga.documents.schedule(editor, id, { unpublishAt: null });
    expect(cleared.schedule).toEqual({ publish: saved.schedule.publish, unpublish: null });
    expect((await auditActions(id)).map((row) => row.action)).toEqual([
      'document.create',
      'document.schedule',
      'document.schedule',
    ]);
  });

  it('refuses a past date, an unpublish before the publish, a bad date and a user who cannot publish', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const author = await createUser(ctx.genga, 'author');
    const id = await draftDocument(author);
    const soon = new Date(Date.now() + HOUR).toISOString();
    const schedule = ctx.genga.documents.schedule;
    await expect(schedule(editor, id, { publishAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      schedule(editor, id, { publishAt: soon, unpublishAt: new Date(Date.now() + HOUR / 2).toISOString() }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(schedule(editor, id, { publishAt: 'tomorrow' })).rejects.toMatchObject({ status: 400 });
    await expect(schedule(author, id, { publishAt: soon })).rejects.toMatchObject({ status: 403 });
    expect((await ctx.genga.documents.get(editor, id)).schedule).toEqual({ publish: null, unpublish: null });
  });

  it('publishes the draft of the moment at the date, with the event, the audit entry and the cache', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor, 'Avant');
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    const doc = await ctx.genga.documents.get(editor, id);
    await ctx.genga.documents.saveDraft(editor, id, { ...doc.draft, title: 'Après' }, doc.draftRev);

    expect(await ctx.genga.runSchedules()).toBe(0);
    expect(await ctx.genga.getDocument('journal', doc.slug)).toBeNull();

    await makeDue(id, 'publish');
    expect(await ctx.genga.runSchedules()).toBe(1);
    const live = await ctx.genga.documents.get(editor, id);
    expect(live.status).toBe('published');
    expect(live.schedule.publish).toBeNull();
    expect((await ctx.genga.getDocument('journal', doc.slug))?.data).toMatchObject({ title: 'Après' });
    expect(await eventTypes(id)).toEqual(['document.published']);
    const publishAudit = (await auditActions(id)).find((row) => row.action === 'document.publish');
    expect(publishAudit).toMatchObject({ user_id: editor.id, detail: { scheduled: true } });

    expect(await ctx.genga.runSchedules()).toBe(0);
  });

  it('unpublishes at the date', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    const doc = await ctx.genga.documents.get(editor, id);
    await ctx.genga.documents.publish(editor, id, doc.draftRev);
    await ctx.genga.documents.schedule(editor, id, { unpublishAt: new Date(Date.now() + HOUR).toISOString() });
    await makeDue(id, 'unpublish');

    expect(await ctx.genga.runSchedules()).toBe(1);
    expect((await ctx.genga.documents.get(editor, id)).status).toBe('draft');
    expect(await eventTypes(id)).toEqual(['document.published', 'document.unpublished']);
    expect((await auditActions(id)).at(-1)).toMatchObject({
      action: 'document.unpublish',
      detail: { scheduled: true },
    });
  });

  it('runs a due publish then a due unpublish in date order', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, {
      publishAt: new Date(Date.now() + HOUR).toISOString(),
      unpublishAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    await ctx.genga.sql`
      UPDATE genga_schedules SET run_at = now() - CASE action WHEN 'publish' THEN interval '2 minutes' ELSE interval '1 minute' END
      WHERE document_id = ${id}
    `;
    expect(await ctx.genga.runSchedules()).toBe(2);
    expect(await eventTypes(id)).toEqual(['document.published', 'document.unpublished']);
  });

  it('runs each action once with two instances on one database', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const ids = await Promise.all([1, 2, 3].map((n) => draftDocument(editor, `Réplique ${n}`)));
    for (const id of ids) {
      await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
      await makeDue(id, 'publish');
    }
    const other = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      scheduler: false,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    try {
      await other.ready();
      const [first, second] = await Promise.all([ctx.genga.runSchedules(), other.runSchedules()]);
      expect(first + second).toBe(3);
      // Without the lock, the row check alone keeps each action to one run.
      await ctx.genga.documents.schedule(editor, ids[0], { unpublishAt: new Date(Date.now() + HOUR).toISOString() });
      await makeDue(ids[0], 'unpublish');
      const runs = await Promise.all([
        ctx.genga.documents.runScheduled(editor, ids[0], 'unpublish'),
        other.documents.runScheduled(editor, ids[0], 'unpublish'),
      ]);
      expect(runs.filter(Boolean)).toHaveLength(1);
    } finally {
      await other.close();
    }
    for (const id of ids) {
      expect((await eventTypes(id)).filter((type) => type === 'document.published')).toHaveLength(1);
      expect((await auditActions(id)).filter((row) => row.action === 'document.publish')).toHaveLength(1);
      const [{ count }] = await ctx.genga.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM genga_versions WHERE document_id = ${id} AND kind = 'published'
      `;
      expect(count).toBe(1);
    }
  });

  it('does nothing when the schedule was cleared or moved after the runner listed it', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    expect(await ctx.genga.documents.runScheduled(editor, id, 'publish')).toBe(false);
    await makeDue(id, 'publish');
    await ctx.genga.documents.schedule(editor, id, { publishAt: null });
    expect(await ctx.genga.documents.runScheduled(editor, id, 'publish')).toBe(false);
    expect((await ctx.genga.documents.get(editor, id)).status).toBe('draft');
    expect(await eventTypes(id)).toEqual([]);
  });

  it('clears the schedule of a manual publish, a manual unpublish and a delete', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    const later = new Date(Date.now() + HOUR).toISOString();
    const evenLater = new Date(Date.now() + 2 * HOUR).toISOString();
    await ctx.genga.documents.schedule(editor, id, { publishAt: later, unpublishAt: evenLater });
    const doc = await ctx.genga.documents.get(editor, id);
    await ctx.genga.documents.publish(editor, id, doc.draftRev);
    expect((await ctx.genga.documents.get(editor, id)).schedule).toMatchObject({
      publish: null,
      unpublish: { at: evenLater },
    });
    await ctx.genga.documents.unpublish(editor, id);
    expect((await ctx.genga.documents.get(editor, id)).schedule).toEqual({ publish: null, unpublish: null });

    await ctx.genga.documents.schedule(editor, id, { publishAt: later, unpublishAt: evenLater });
    await ctx.genga.documents.remove(editor, id);
    const [{ count }] = await ctx.genga.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM genga_schedules WHERE document_id = ${id}
    `;
    expect(count).toBe(0);
  });

  it('records a refusal: invalid fields, a disabled or a deleted user. Saving again clears it', async () => {
    const admin = await createUser(ctx.genga, 'admin');
    const editor = await createUser(ctx.genga, 'editor');
    const gone = await createUser(ctx.genga, 'editor');
    const invalid = await draftDocument(admin, 'Invalide');
    const disabled = await draftDocument(admin, 'Compte désactivé');
    const deleted = await draftDocument(admin, 'Compte supprimé');
    const soon = new Date(Date.now() + HOUR).toISOString();

    const doc = await ctx.genga.documents.get(admin, invalid);
    await ctx.genga.documents.saveDraft(admin, invalid, { ...doc.draft, title: '' }, doc.draftRev);
    await ctx.genga.documents.schedule(admin, invalid, { publishAt: soon });
    await ctx.genga.documents.schedule(editor, disabled, { publishAt: soon });
    await ctx.genga.documents.schedule(gone, deleted, { publishAt: soon });
    for (const id of [invalid, disabled, deleted]) await makeDue(id, 'publish');
    await ctx.genga.users.update(admin, editor.id, { disabled: true });
    await ctx.genga.sql`DELETE FROM genga_users WHERE id = ${gone.id}`;

    expect(await ctx.genga.runSchedules()).toBe(0);
    for (const id of [invalid, disabled, deleted]) {
      const { schedule, status } = await ctx.genga.documents.get(admin, id);
      expect(status).toBe('draft');
      expect(schedule.publish?.failedAt).not.toBeNull();
      expect(schedule.publish?.error).toBeTruthy();
    }
    expect((await ctx.genga.documents.get(admin, invalid)).schedule.publish?.error).toContain('Corrigez');
    expect((await auditActions(invalid)).at(-1)).toMatchObject({
      action: 'document.schedule_failed',
      user_id: admin.id,
      detail: { action: 'publish' },
    });
    expect(await ctx.genga.runSchedules()).toBe(0);

    await ctx.genga.documents.schedule(admin, deleted, { publishAt: soon });
    expect((await ctx.genga.documents.get(admin, deleted)).schedule.publish).toEqual({
      at: soon,
      failedAt: null,
      error: null,
    });
  });

  it('runs on its timer after ready(), and close() stops it', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    await makeDue(id, 'publish');
    const timed = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      scheduler: { intervalMs: 50 },
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    try {
      await timed.ready();
      await expect
        .poll(async () => (await ctx.genga.documents.get(editor, id)).status, { timeout: 5000 })
        .toBe('published');
    } finally {
      await timed.close();
    }
  });

  it('runs with a pool of one connection', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    await makeDue(id, 'publish');
    const single = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      siteUrl: SITE,
      maxConnections: 1,
      scheduler: false,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    try {
      await single.ready();
      expect(await single.runSchedules()).toBe(1);
    } finally {
      await single.close();
    }
  }, 10_000);

  it('refuses a date without a time zone', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    for (const publishAt of ['2099-12-01T10:00', '2099-12-01']) {
      await expect(ctx.genga.documents.schedule(editor, id, { publishAt })).rejects.toMatchObject({ status: 400 });
    }
    const saved = await ctx.genga.documents.schedule(editor, id, { publishAt: '2099-12-01T10:00:00+01:00' });
    expect(saved.schedule.publish?.at).toBe('2099-12-01T09:00:00.000Z');
  });

  it('stops the scheduled publish when a user who cannot publish changes the draft', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const author = await createUser(ctx.genga, 'author');
    const id = await draftDocument(author);
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    const doc = await ctx.genga.documents.get(editor, id);
    const saved = await ctx.genga.documents.saveDraft(
      editor,
      id,
      { ...doc.draft, title: 'Par l’éditeur' },
      doc.draftRev,
    );
    expect((await ctx.genga.documents.get(editor, id)).schedule.publish?.failedAt).toBeNull();

    await ctx.genga.documents.saveDraft(author, id, { ...doc.draft, title: 'Par l’auteur' }, saved.draftRev);
    await makeDue(id, 'publish');
    expect(await ctx.genga.runSchedules()).toBe(0);
    const after = await ctx.genga.documents.get(editor, id);
    expect(after.status).toBe('draft');
    expect(after.schedule.publish?.error).toContain('ne peut pas publier');
  });

  it('does not mark a schedule saved again after the listing as failed', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    await makeDue(id, 'publish');
    const [listed] = await ctx.genga.sql<
      { run_at: Date }[]
    >`SELECT run_at FROM genga_schedules WHERE document_id = ${id}`;
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    await ctx.genga.documents.failSchedule(id, 'publish', listed.run_at, 'Ancienne erreur');
    expect((await ctx.genga.documents.get(editor, id)).schedule.publish).toMatchObject({ failedAt: null, error: null });
  });

  it('keeps a due unpublish behind a due publish of the same document after a server error', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, {
      publishAt: new Date(Date.now() + HOUR).toISOString(),
      unpublishAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    await ctx.genga.sql`
      UPDATE genga_schedules SET run_at = now() - CASE action WHEN 'publish' THEN interval '2 minutes' ELSE interval '1 minute' END
      WHERE document_id = ${id}
    `;
    expect(await ctx.genga.documents.runScheduled(editor, id, 'unpublish')).toBe(false);
    const real = ctx.genga.documents.runScheduled;
    const spy = vi.spyOn(ctx.genga.documents, 'runScheduled').mockImplementation(async (user, docId, action) => {
      if (action === 'publish') throw new Error('database unreachable');
      return real(user, docId, action);
    });
    try {
      expect(await ctx.genga.runSchedules()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const after = await ctx.genga.documents.get(editor, id);
    expect(after.schedule.unpublish).toMatchObject({ failedAt: null });
    expect(after.schedule.publish).toMatchObject({ failedAt: null });
    expect(await ctx.genga.runSchedules()).toBe(2);
    expect(await eventTypes(id)).toEqual(['document.published', 'document.unpublished']);
  });

  it('records the schedule as failed after 10 server errors', async () => {
    const editor = await createUser(ctx.genga, 'editor');
    const id = await draftDocument(editor);
    await ctx.genga.documents.schedule(editor, id, { publishAt: new Date(Date.now() + HOUR).toISOString() });
    await makeDue(id, 'publish');
    await ctx.genga.sql`UPDATE genga_schedules SET attempts = 8 WHERE document_id = ${id}`;
    const spy = vi.spyOn(ctx.genga.documents, 'runScheduled').mockRejectedValue(new Error('database unreachable'));
    try {
      await ctx.genga.runSchedules();
      expect((await ctx.genga.documents.get(editor, id)).schedule.publish?.failedAt).toBeNull();
      await ctx.genga.runSchedules();
    } finally {
      spy.mockRestore();
    }
    expect((await ctx.genga.documents.get(editor, id)).schedule.publish?.error).toContain('10 fois');
  });
});
