import type { ScheduleAction } from '../types';
import { toPublicUser } from './auth';
import type { GengaContext } from './context';
import type { GengaDocuments } from './documents';
import { GengaError } from './errors';

// Any constant works: all Genga processes must use the same one.
const SCHEDULES_LOCK_ID = 7_310_442_120;
const BATCH = 50;
/** Runs that end on a server error before the runner records the schedule as failed. */
const MAX_ATTEMPTS = 10;

export type SchedulerOptions = {
  /** Milliseconds between two runs. Default: 30 000. */
  intervalMs?: number;
};

type DueRow = {
  document_id: string;
  action: ScheduleAction;
  run_at: Date;
  created_by: string | null;
  attempts: number;
};

/** A refusal (rights, invalid fields, a taken slug) comes again on each run: the runner records it and stops. */
function isRefusal(error: unknown): error is GengaError {
  return error instanceof GengaError && error.status < 500;
}

/**
 * Runs the due scheduled publish and unpublish actions. One process at a time runs them: the
 * others skip the run while a session advisory lock is held. Each action also deletes its own
 * row in its transaction, so an action runs once even if two processes list the same row.
 */
export function createScheduler(
  ctx: GengaContext,
  documents: GengaDocuments,
  options: SchedulerOptions = {},
  maxConnections = 10,
) {
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
        row.run_at,
        'La personne qui a programmé cette action n’a plus de compte actif. Programmez-la à nouveau.',
      );
      return false;
    }
    try {
      return await documents.runScheduled(user, row.document_id, row.action);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      await documents.failSchedule(row.document_id, row.action, row.run_at, error.message);
      return false;
    }
  }

  async function recordAttempt(row: DueRow) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await documents.failSchedule(
        row.document_id,
        row.action,
        row.run_at,
        `L’action a échoué ${MAX_ATTEMPTS} fois sur une erreur du serveur. Programmez-la à nouveau.`,
      );
      return;
    }
    await sql`
      UPDATE genga_schedules SET attempts = attempts + 1
      WHERE document_id = ${row.document_id} AND action = ${row.action}
        AND date_trunc('milliseconds', run_at) = ${row.run_at}
    `;
  }

  async function runLocked(): Promise<number> {
    const due = await sql<DueRow[]>`
      SELECT document_id, action, run_at, created_by, attempts FROM genga_schedules
      WHERE failed_at IS NULL AND run_at <= now()
      ORDER BY run_at, action LIMIT ${BATCH}
    `;
    let done = 0;
    // After a server error, the later actions of the same document wait: an unpublish must not run before its publish.
    const held = new Set<string>();
    for (const row of due) {
      if (stopped) break;
      if (held.has(row.document_id)) continue;
      try {
        if (await runRow(row)) done += 1;
      } catch (error) {
        held.add(row.document_id);
        log.error(`[genga] The scheduled ${row.action} of document ${row.document_id} failed.`, error);
        await recordAttempt(row).catch((recordError) => log.error('[genga] The scheduler failed:', recordError));
      }
    }
    return done;
  }

  async function runOnce(): Promise<number> {
    // The lock holds one connection, and the actions need another one. In a pool of one, the
    // row delete of each action alone keeps it to one run.
    if (maxConnections < 2) return runLocked();
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
