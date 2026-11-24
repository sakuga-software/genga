import type { Sql, TransactionSql } from 'postgres';
import {
  ALL_TAG,
  documentEventTags,
  GENGA_EVENT_TYPES,
  isGengaEventType,
  type GengaEvent,
  type GengaEventType,
} from '../events';
import { webhookHeaders, webhookKey } from '../webhooks';
import type { GengaLogger } from './context';

export type WebhookConfig = {
  /** The receiver. Genga sends a POST with the event as JSON. */
  url: string;
  /** A Standard Webhooks secret: `whsec_` and 24 to 64 random bytes in base64. Not the preview secret. */
  secret: string;
  /** The event types to send. Default: all of them. */
  events?: (GengaEventType | '*')[];
};

export type WebhookDeliveryOptions = {
  /** The `fetch` of the sender. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** The clock of the sender, in milliseconds. For tests. */
  now?: () => number;
  /** How often the sender looks for due deliveries. Default: 5 seconds. */
  pollMs?: number;
  /** The timeout of one delivery attempt. Default: 10 seconds. */
  timeoutMs?: number;
};

export type GengaEventListener = (event: GengaEvent) => void | Promise<void>;

export type GengaEvents = {
  /**
   * Calls `listener` after each event of this type (or `'*'`), after the transaction commits,
   * in the request that made the change. An error in a listener is logged and changes nothing.
   * Returns the function that removes the listener.
   */
  on(type: GengaEventType | '*', listener: GengaEventListener): () => void;
};

export const EVENT_RETENTION_DAYS = 7;
export const DELIVERY_WINDOW_MS = 24 * 60 * 60_000;
const PRUNE_AFTER_DAYS = EVENT_RETENTION_DAYS + 1;
const PRUNE_EVERY_MS = 60 * 60_000;
const BATCH = 20;
const LEASE_MS = 60_000;
const MAX_ERROR_LENGTH = 300;
/** Delays after the first, second, … failed attempt. The last attempt is 24 hours after the event. */
const RETRY_DELAYS_MS = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000];
// Any constant works: all Genga processes must use the same one. It differs from the migration lock.
const EVENTS_LOCK_ID = 7_310_442_119;

type Queryable = Sql | TransactionSql;

/** A document event, with the path from the collection and the tags of the old and new slug. */
export function documentEvent(
  type: Extract<GengaEventType, `document.${string}`>,
  input: {
    collection: string;
    documentId: string;
    slug: string;
    path: (slug: string) => string;
    previousSlug?: string | null;
    versionId?: string | null;
    at: string;
  },
): GengaEvent {
  const previousSlug = input.previousSlug && input.previousSlug !== input.slug ? input.previousSlug : null;
  return {
    id: crypto.randomUUID(),
    type,
    at: input.at,
    collection: input.collection,
    documentId: input.documentId,
    slug: input.slug,
    path: input.path(input.slug),
    previous: previousSlug ? { slug: previousSlug, path: input.path(previousSlug) } : null,
    versionId: input.versionId ?? null,
    tags: documentEventTags(input.collection, input.slug, previousSlug),
  };
}

/** A media event. It names no media: the events endpoint is public, and a media item can be in drafts only. */
export function mediaEvent(type: 'media.updated' | 'media.deleted', at: string): GengaEvent {
  return {
    id: crypto.randomUUID(),
    type,
    at,
    collection: null,
    documentId: null,
    slug: null,
    path: null,
    previous: null,
    versionId: null,
    tags: [ALL_TAG],
  };
}

/** Checks the webhook settings at start. The messages never contain a URL or a secret. */
export function checkWebhooks(webhooks: WebhookConfig[], previewSecret: string | null): WebhookConfig[] {
  const seen = new Set<string>();
  return webhooks.map((hook, index) => {
    const name = `webhooks[${index}]`;
    let url: URL;
    try {
      url = new URL(hook.url);
    } catch {
      throw new Error(`Genga: ${name}.url is not a URL.`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error(`Genga: ${name}.url must be http or https.`);
    if (seen.has(url.href)) throw new Error(`Genga: ${name}.url is in the list twice.`);
    seen.add(url.href);
    if (typeof hook.secret !== 'string' || !hook.secret) throw new Error(`Genga: ${name}.secret is required.`);
    try {
      webhookKey(hook.secret);
    } catch (error) {
      throw new Error(`Genga: ${name}.secret: ${(error as Error).message.replace(/^Genga: /, '')}`);
    }
    // The receiver holds the webhook secret. With the preview secret, it could sign a preview token for any draft.
    if (previewSecret && (hook.secret === previewSecret || hook.secret.replace(/^whsec_/, '') === previewSecret)) {
      throw new Error(`Genga: ${name}.secret must not be the preview secret (GENGA_SECRET).`);
    }
    const events = hook.events ?? ['*'];
    if (!Array.isArray(events) || !events.length || events.some((type) => type !== '*' && !isGengaEventType(type))) {
      throw new Error(`Genga: ${name}.events must list event types: ${GENGA_EVENT_TYPES.join(', ')} or *.`);
    }
    return { url: url.href, secret: hook.secret, events };
  });
}

function wants(hook: WebhookConfig, type: GengaEventType) {
  return (hook.events ?? ['*']).some((item) => item === '*' || item === type);
}

function retryAfterMs(response: Response, now: number): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

type ClaimedRow = { event_seq: string; url: string; attempts: number; id: string; at: Date; event: GengaEvent };

/** The event bus, the outbox and the webhook sender of one Genga instance. */
export function createEventBus(
  sql: Sql,
  log: GengaLogger,
  webhooks: WebhookConfig[],
  delivery: WebhookDeliveryOptions = {},
) {
  const listeners = new Map<GengaEventType | '*', Set<GengaEventListener>>();
  const now = delivery.now ?? Date.now;
  const send = delivery.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let prunedAt = 0;

  function on(type: GengaEventType | '*', listener: GengaEventListener) {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
    return () => {
      set.delete(listener);
    };
  }

  /** Writes events to the outbox. Call it inside the transaction of the change. */
  async function record(tx: TransactionSql, events: GengaEvent[]) {
    if (!events.length) return;
    // One writer at a time: `seq` then grows in commit order, so a reader that follows it skips nothing.
    await tx`SELECT pg_advisory_xact_lock(${EVENTS_LOCK_ID})`;
    for (const event of events) {
      const [row] = await tx<{ seq: string }[]>`
        INSERT INTO genga_events (id, type, at, event)
        VALUES (${event.id}, ${event.type}, ${event.at}, ${tx.json(event as never)})
        RETURNING seq
      `;
      for (const hook of webhooks) {
        if (!wants(hook, event.type)) continue;
        await tx`
          INSERT INTO genga_webhook_deliveries (event_seq, url, next_attempt_at)
          VALUES (${row.seq}, ${hook.url}, ${new Date(now())})
        `;
      }
    }
  }

  /** Runs the listeners, then wakes the sender. Call it after the transaction commits. */
  async function dispatch(events: GengaEvent[]) {
    for (const event of events) {
      for (const listener of [...(listeners.get(event.type) ?? []), ...(listeners.get('*') ?? [])]) {
        try {
          await listener(event);
        } catch (error) {
          log.error(`[genga] An event listener of ${event.type} failed:`, error);
        }
      }
    }
    if (events.length) wake();
  }

  const urls = webhooks.map((hook) => hook.url);

  /** Claims the due deliveries of the configured URLs. Another process can own other URLs. */
  async function claim(): Promise<ClaimedRow[]> {
    const at = new Date(now());
    return sql<ClaimedRow[]>`
      UPDATE genga_webhook_deliveries d
      SET attempts = d.attempts + 1, next_attempt_at = ${new Date(at.getTime() + LEASE_MS)}
      FROM genga_events e
      WHERE e.seq = d.event_seq AND (d.event_seq, d.url) IN (
        SELECT event_seq, url FROM genga_webhook_deliveries
        WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ${at} AND url = ANY(${urls}::text[])
        ORDER BY event_seq LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.event_seq, d.url, d.attempts, e.id, e.at, e.event
    `;
  }

  async function finish(row: ClaimedRow, result: { status: number | null; error: string | null; retryAfter: number }) {
    const at = now();
    const key = sql`event_seq = ${row.event_seq} AND url = ${row.url}`;
    if (result.status !== null && result.status >= 200 && result.status < 300) {
      await sql`
        UPDATE genga_webhook_deliveries SET delivered_at = ${new Date(at)}, last_status = ${result.status}, last_error = NULL
        WHERE ${key}`;
      return;
    }
    const deadline = row.at.getTime() + DELIVERY_WINDOW_MS;
    const base = RETRY_DELAYS_MS[Math.min(row.attempts, RETRY_DELAYS_MS.length) - 1];
    const jitter = 0.9 + Math.random() * 0.2;
    const next = Math.min(at + Math.max(Math.round(base * jitter), result.retryAfter), deadline);
    const gone = result.status === 410 || at >= deadline;
    const error = result.error?.slice(0, MAX_ERROR_LENGTH) ?? null;
    if (gone) {
      log.warn(`[genga] Webhook delivery of event ${row.id} stopped after ${row.attempts} attempts.`);
      await sql`
        UPDATE genga_webhook_deliveries
        SET failed_at = ${new Date(at)}, last_status = ${result.status}, last_error = ${error}
        WHERE ${key}`;
      return;
    }
    await sql`
      UPDATE genga_webhook_deliveries
      SET next_attempt_at = ${new Date(next)}, last_status = ${result.status}, last_error = ${error}
      WHERE ${key}`;
  }

  async function deliver(row: ClaimedRow) {
    const hook = webhooks.find((item) => item.url === row.url) as WebhookConfig;
    const body = JSON.stringify(row.event);
    try {
      const headers = await webhookHeaders(hook.secret, row.id, body, Math.floor(now() / 1000));
      const response = await send(hook.url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'genga-webhooks', ...headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(delivery.timeoutMs ?? 10_000),
      });
      await response.body?.cancel().catch(() => {});
      await finish(row, { status: response.status, error: null, retryAfter: retryAfterMs(response, now()) });
    } catch (error) {
      await finish(row, { status: null, error: error instanceof Error ? error.message : String(error), retryAfter: 0 });
    }
  }

  async function prune() {
    if (now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now();
    await sql`DELETE FROM genga_events WHERE at < ${new Date(now() - PRUNE_AFTER_DAYS * 86_400_000)}`;
  }

  async function drainOnce() {
    await prune();
    while (urls.length && !stopped) {
      const rows = await claim();
      if (!rows.length) return;
      for (const result of await Promise.allSettled(rows.map(deliver))) {
        if (result.status === 'rejected') log.error('[genga] A webhook delivery failed:', result.reason);
      }
      if (rows.length < BATCH) return;
    }
  }

  /**
   * Deletes the events older than 8 days, then sends the due webhook deliveries and waits for
   * them. The sender also runs it on a timer and after each change.
   */
  function drain(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !stopped);
    })()
      .catch((error) => log.error('[genga] Webhook sender failed:', error))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function wake() {
    if (!stopped) void drain();
  }

  return {
    on,
    record,
    dispatch,
    drain,
    start() {
      if (timer || stopped) return;
      timer = setInterval(wake, urls.length ? (delivery.pollMs ?? 5_000) : PRUNE_EVERY_MS);
      timer.unref?.();
      wake();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
    /** The events after `after` (an event id), oldest first, from the last 7 days. */
    async list(after: string | null, limit: number, db: Queryable = sql) {
      const since = new Date(now() - EVENT_RETENTION_DAYS * 86_400_000);
      let from = 0n;
      if (after) {
        const [row] = await db<{ seq: string }[]>`SELECT seq FROM genga_events WHERE id = ${after} AND at >= ${since}`;
        if (!row) return null;
        from = BigInt(row.seq);
      }
      const rows = await db<{ event: GengaEvent }[]>`
        SELECT event FROM genga_events WHERE seq > ${from.toString()} AND at >= ${since}
        ORDER BY seq LIMIT ${limit + 1}
      `;
      return { events: rows.slice(0, limit).map((row) => row.event), hasMore: rows.length > limit };
    },
  };
}

export type GengaEventBus = ReturnType<typeof createEventBus>;
