import type { ScheduleAction } from '../types';
import { toPublicUser } from './auth';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { GengaError } from './errors';

// Any constant works: all Genga processes must use the same one.
const SCHEDULES_LOCK_ID = 7_310_442_120;
const BATCH = 50;

export type SchedulerOptions = {
  /** Milliseconds between two runs. Default: 30 000. */
  intervalMs?: number;
};

type DueRow = { document_id: string; action: ScheduleAction; created_by: string | null };

/** A refusal (rights, invalid fields, a taken slug) comes again on each run: the runner records it and stops. */
function isRefusal(error: unknown): error is GengaError {
  return error instanceof GengaError && error.status < 500;
}

/**
 * Runs the due scheduled publish and unpublish actions. One process at a time runs them: the
 * others skip the run while a session advisory lock is held. Each action also deletes its own
 * row in its transaction, so an action runs once even if two processes list the same row.
 */
export function createScheduler(ctx: GengaContext, documents: GengaDocuments, options: SchedulerOptions = {}) {
  const { sql, log } = ctx;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<number> | null = null;
  let stopped = false;

  async function schedulerOf(row: DueRow) {
    if (!row.created_by) return null;
    const [user] = await sql<Parameters<typeof toPublicUser>[0][]>`
      SELECT id, email, name, role, created_at, disabled_at FROM genga_users WHERE id = ${row.created_by}
    `;
    return user && !user.disabled_at ? toPublicUser(user) : null;
  }

  async function runRow(row: DueRow): Promise<boolean> {
    const user = await schedulerOf(row);
    if (!user) {
      await documents.failSchedule(
        row.document_id,
        row.action,
        'La personne qui a programmé cette action n’a plus de compte actif. Programmez-la à nouveau.',
      );
      return false;
    }
    try {
      return await documents.runScheduled(user, row.document_id, row.action);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      await documents.failSchedule(row.document_id, row.action, error.message);
      return false;
    }
  }

  async function runLocked(): Promise<number> {
    const due = await sql<DueRow[]>`
      SELECT document_id, action, created_by FROM genga_schedules
      WHERE failed_at IS NULL AND run_at <= now()
      ORDER BY run_at, action LIMIT ${BATCH}
    `;
    let done = 0;
    for (const row of due) {
      if (stopped) break;
      try {
        if (await runRow(row)) done += 1;
      } catch (error) {
        log.error(
          `[genga] The scheduled ${row.action} of document ${row.document_id} failed. It runs again later.`,
          error,
        );
      }
    }
    return done;
  }

  async function runOnce(): Promise<number> {
    // A session lock belongs to one connection: reserve it, so the unlock goes to the same one.
    const connection = await sql.reserve();
    try {
      const [{ locked }] = await connection<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_lock(${SCHEDULES_LOCK_ID}) AS locked`;
      if (!locked) return 0;
      try {
        return await runLocked();
      } finally {
        await connection`SELECT pg_advisory_unlock(${SCHEDULES_LOCK_ID})`;
      }
    } finally {
      connection.release();
    }
  }

  /**
   * Runs the due actions now, and returns how many ran. It returns 0 at once when another
   * process runs them.
   */
  function run(): Promise<number> {
    running ??= runOnce().finally(() => {
      running = null;
    });
    return running;
  }

  function tick() {
    if (stopped) return;
    run().catch((error) => log.error('[genga] The scheduler failed:', error));
  }

  return {
    run,
    start() {
      if (timer || stopped) return;
      timer = setInterval(tick, options.intervalMs ?? 30_000);
      timer.unref?.();
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}

export type GengaScheduler = ReturnType<typeof createScheduler>;
