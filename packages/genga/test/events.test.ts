import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signWebhook, tagsFor, verifyWebhook, WebhookVerificationError, type GengaEvent } from '../src';
import { createGenga, webhooksFromEnv, type Genga, type GengaOptions } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, pngFile, SITE, testConfig } from './helpers';

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const OTHER_SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const RECEIVER = 'https://site.example/api/genga/webhook';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** An HMAC computed with node:crypto from the Standard Webhooks rules, not with the code under test. */
function referenceSignature(secret: string, id: string, timestamp: string, body: string) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function webhookRequest(body: string, headers: Record<string, string>) {
  return new Request(RECEIVER, { method: 'POST', body, headers });
}

describe('webhook signatures', () => {
  const id = 'f0a5e6f4-5c4e-4a39-9f3a-0d9a8e1b2c3d';
  const now = Date.UTC(2026, 10, 24, 12);
  const timestamp = String(now / 1000);
  const body = JSON.stringify({ id, type: 'document.published', tags: ['genga:c:journal'] });

  it('signs as the Standard Webhooks reference does', async () => {
    expect(await signWebhook(SECRET, id, Number(timestamp), body)).toBe(
      referenceSignature(SECRET, id, timestamp, body),
    );
  });

  it('accepts a valid signature, also next to an old one', async () => {
    const signature = referenceSignature(SECRET, id, timestamp, body);
    const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp };
    const event = await verifyWebhook(webhookRequest(body, { ...headers, 'webhook-signature': signature }), SECRET, {
      now,
    });
    expect(event.type).toBe('document.published');
    const rotated = `${referenceSignature(OTHER_SECRET, id, timestamp, body)} ${signature}`;
    await expect(
      verifyWebhook(webhookRequest(body, { ...headers, 'webhook-signature': rotated }), SECRET, { now }),
    ).resolves.toMatchObject({ id });
  });

  it('rejects a changed body, another secret, an old timestamp and missing headers', async () => {
    const signature = referenceSignature(SECRET, id, timestamp, body);
    const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature };
    const cases: [Request, string][] = [
      [webhookRequest(body.replace('published', 'deleted'), headers), SECRET],
      [webhookRequest(body, headers), OTHER_SECRET],
      [webhookRequest(body, { ...headers, 'webhook-id': 'another-id' }), SECRET],
      [
        webhookRequest(body, {
          'webhook-id': 'another-id',
          'webhook-timestamp': timestamp,
          'webhook-signature': referenceSignature(SECRET, 'another-id', timestamp, body),
        }),
        SECRET,
      ],
      [webhookRequest(body, { 'webhook-id': id, 'webhook-timestamp': timestamp }), SECRET],
      [webhookRequest(body, { ...headers, 'webhook-signature': signature.replace('v1,', 'v2,') }), SECRET],
    ];
    for (const [request, secret] of cases) {
      await expect(verifyWebhook(request, secret, { now })).rejects.toBeInstanceOf(WebhookVerificationError);
    }
    await expect(verifyWebhook(webhookRequest(body, headers), SECRET, { now: now + 6 * 60_000 })).rejects.toThrow(
      /tolerance/,
    );
    await expect(verifyWebhook(webhookRequest(body, headers), SECRET, { now: now - 6 * 60_000 })).rejects.toThrow(
      /tolerance/,
    );
  });

  it('refuses a secret that is not 24 to 64 bytes of base64', async () => {
    await expect(signWebhook('whsec_c2hvcnQ=', id, 1, body)).rejects.toThrow(/24 to 64 bytes/);
    await expect(signWebhook('whsec_not base64!', id, 1, body)).rejects.toThrow(/base64/);
  });
});

describe('publish events', () => {
  let mediaDir: string;
  let clock = Date.now();
  let calls: { url: string; request: Request }[] = [];
  let reply: () => Response = () => new Response(null, { status: 204 });
  const started: Genga[] = [];

  function start(options: Partial<GengaOptions> = {}) {
    const genga = createGenga(testConfig, {
      databaseUrl: TEST_URL,
      scheduler: false,
      siteUrl: SITE,
      mediaDir,
      secureCookies: false,
      logger: quiet,
      publicApi: { now: () => clock },
      webhooks: [{ url: RECEIVER, secret: SECRET }],
      webhookDelivery: {
        now: () => clock,
        pollMs: 3_600_000,
        fetch: async (input, init) => {
          calls.push({ url: String(input), request: new Request(String(input), init) });
          return reply();
        },
      },
      ...options,
    });
    started.push(genga);
    return genga;
  }

  let genga: Genga;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-events-'));
  });

  beforeEach(async () => {
    clock = Date.now();
    calls = [];
    reply = () => new Response(null, { status: 204 });
    genga = start();
    await genga.ready();
    await genga.sql`TRUNCATE genga_events, genga_media, genga_redirects, genga_versions, genga_documents, genga_users CASCADE`;
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((instance) => instance.close()));
  });

  afterAll(async () => {
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function publishNew(title: string) {
    const user = await createUser(genga, 'admin');
    const created = await genga.documents.create(user, 'journal', { title });
    const published = await genga.documents.publish(user, created.id, 1);
    return { user, id: created.id, slug: created.slug, versionId: published.versionId };
  }

  const outbox = () =>
    genga.sql<{ type: string; event: GengaEvent }[]>`SELECT type, event FROM genga_events ORDER BY seq`;

  it('writes one outbox event per publish and runs the listeners after the commit', async () => {
    const seen: { event: GengaEvent; live: boolean }[] = [];
    genga.events.on('document.published', async (event) => {
      const [row] = await genga.sql`SELECT published_version_id FROM genga_documents WHERE id = ${event.documentId}`;
      seen.push({ event, live: row.published_version_id === event.versionId });
    });
    const all: string[] = [];
    const off = genga.events.on('*', (event) => {
      all.push(event.type);
    });
    const post = await publishNew('Hello events');

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toMatchObject({
      type: 'document.published',
      collection: 'journal',
      documentId: post.id,
      slug: 'hello-events',
      path: '/journal/hello-events',
      previous: null,
      versionId: post.versionId,
      tags: ['genga:c:journal', 'genga:d:journal:hello-events'],
    });
    expect(seen).toEqual([{ event: rows[0].event, live: true }]);
    expect(all).toEqual(['document.published']);
    off();
    await genga.documents.publish(post.user, post.id, 1);
    expect(all).toEqual(['document.published']);
  });

  it('gives the old and the new slug tags on a slug change', async () => {
    const post = await publishNew('First name');
    const saved = await genga.documents.saveDraft(post.user, post.id, { title: 'First name', slug: 'second-name' }, 1);
    await genga.documents.publish(post.user, post.id, saved.draftRev);
    const rows = (await outbox()).slice(1);
    expect(rows.map((row) => row.type)).toEqual(['document.published', 'document.slug_changed']);
    for (const { event } of rows) {
      expect(event.previous).toEqual({ slug: 'first-name', path: '/journal/first-name' });
      expect(event.tags).toEqual(['genga:c:journal', 'genga:d:journal:second-name', 'genga:d:journal:first-name']);
    }
    expect(rows[0].event.id).not.toBe(rows[1].event.id);
  });

  it('writes no event for a draft that was never live, and one for a live document', async () => {
    const user = await createUser(genga, 'admin');
    const draft = await genga.documents.create(user, 'journal', { title: 'Secret draft' });
    await genga.documents.unpublish(user, draft.id);
    await genga.documents.remove(user, draft.id);
    expect(await outbox()).toEqual([]);

    const live = await publishNew('Live one');
    await genga.documents.unpublish(live.user, live.id);
    const other = await publishNew('Live two');
    await genga.documents.remove(other.user, other.id);
    expect((await outbox()).map((row) => `${row.type} ${row.event.slug}`)).toEqual([
      'document.published live-one',
      'document.unpublished live-one',
      'document.published live-two',
      'document.deleted live-two',
    ]);
  });

  it('sends media events with the broad tag', async () => {
    const user = await createUser(genga, 'admin');
    const { media } = await genga.media.upload(user, await pngFile('events.png', { r: 4, g: 5, b: 6 }));
    await genga.media.updateAlt(user, media.id, 'A new alt');
    await genga.media.remove(user, media.id);
    const rows = await outbox();
    expect(rows.map((row) => row.type)).toEqual(['media.updated', 'media.deleted']);
    expect(rows[0].event).toMatchObject({ tags: ['genga'], collection: null, documentId: null });
    expect(JSON.stringify(rows)).not.toContain(media.id);
    expect(tagsFor('journal', 'x')).toContain(rows[0].event.tags[0]);
  });

  it('logs a failed listener and keeps the publish', async () => {
    const errors: unknown[] = [];
    genga = start({ logger: { ...quiet, error: (...args: unknown[]) => errors.push(args) } });
    genga.events.on('*', () => {
      throw new Error('listener down');
    });
    const post = await publishNew('Still published');
    expect((await genga.published.find('journal', post.slug))?.id).toBe(post.id);
    expect(errors).toHaveLength(1);
  });

  it('delivers a signed webhook that a receiver accepts', async () => {
    const post = await publishNew('Signed');
    await genga.deliverWebhooks();
    expect(calls).toHaveLength(1);
    const { request } = calls[0];
    expect(request.headers.get('content-type')).toBe('application/json');
    const body = await request.clone().text();
    expect(request.headers.get('webhook-signature')).toBe(
      referenceSignature(SECRET, request.headers.get('webhook-id')!, request.headers.get('webhook-timestamp')!, body),
    );
    const event = await verifyWebhook(request, SECRET, { now: clock });
    expect(event).toMatchObject({ type: 'document.published', documentId: post.id });
    const [row] = await genga.sql`SELECT attempts, delivered_at, last_status FROM genga_webhook_deliveries`;
    expect(row).toMatchObject({ attempts: 1, last_status: 204 });
    expect(row.delivered_at).toBeInstanceOf(Date);
  });

  it('retries with backoff, the same webhook-id and a fresh timestamp', async () => {
    reply = () => new Response('down', { status: 503 });
    await publishNew('Retry me');
    await genga.deliverWebhooks();
    expect(calls).toHaveLength(1);
    const [failed] =
      await genga.sql`SELECT attempts, next_attempt_at, last_status, delivered_at FROM genga_webhook_deliveries`;
    expect(failed).toMatchObject({ attempts: 1, last_status: 503, delivered_at: null });
    expect(failed.next_attempt_at.getTime() - clock).toBeGreaterThanOrEqual(4_500);

    await genga.deliverWebhooks();
    expect(calls).toHaveLength(1);

    reply = () => new Response(null, { status: 200 });
    clock += 6 * 60_000;
    await genga.deliverWebhooks();
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((call) => call.request.headers);
    expect(second.get('webhook-id')).toBe(first.get('webhook-id'));
    expect(Number(second.get('webhook-timestamp'))).toBeGreaterThan(Number(first.get('webhook-timestamp')));
    await expect(verifyWebhook(calls[1].request, SECRET, { now: clock })).resolves.toMatchObject({
      type: 'document.published',
    });
    const [done] = await genga.sql`SELECT attempts, delivered_at FROM genga_webhook_deliveries`;
    expect(done.attempts).toBe(2);
    expect(done.delivered_at).toBeInstanceOf(Date);
  });

  it('makes a last attempt 24 hours after the event, then stops, and stops at once on 410', async () => {
    reply = () => {
      throw new Error('connection refused');
    };
    await publishNew('Never received');
    const [{ at }] = await genga.sql<{ at: Date }[]>`SELECT at FROM genga_events`;
    await genga.deliverWebhooks();
    const [first] = await genga.sql`SELECT last_error, failed_at FROM genga_webhook_deliveries`;
    expect(first).toMatchObject({ last_error: 'connection refused', failed_at: null });
    clock = at.getTime() + 24 * 3_600_000 - 60_000;
    await genga.deliverWebhooks();
    const [last] = await genga.sql`SELECT next_attempt_at, failed_at FROM genga_webhook_deliveries`;
    expect(last.failed_at).toBeNull();
    expect(last.next_attempt_at.getTime()).toBe(at.getTime() + 24 * 3_600_000);
    clock = at.getTime() + 24 * 3_600_000;
    await genga.deliverWebhooks();
    const [stopped] = await genga.sql`SELECT attempts, failed_at FROM genga_webhook_deliveries`;
    expect(stopped.attempts).toBe(3);
    expect(stopped.failed_at).toBeInstanceOf(Date);

    reply = () => new Response(null, { status: 410 });
    await genga.sql`TRUNCATE genga_events CASCADE`;
    await publishNew('Gone receiver');
    await genga.deliverWebhooks();
    const [gone] = await genga.sql`SELECT attempts, failed_at, last_status FROM genga_webhook_deliveries`;
    expect(gone).toMatchObject({ attempts: 1, last_status: 410 });
    expect(gone.failed_at).toBeInstanceOf(Date);
  });

  it('waits for Retry-After, from the clock of the sender', async () => {
    reply = () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } });
    await publishNew('Slow down');
    await genga.deliverWebhooks();
    const [row] = await genga.sql`SELECT next_attempt_at, last_status FROM genga_webhook_deliveries`;
    expect(row.last_status).toBe(429);
    expect(row.next_attempt_at.getTime() - clock).toBeGreaterThanOrEqual(3_600_000);
  });

  it('leaves the deliveries of a URL that another process configures', async () => {
    await genga.sql`
      INSERT INTO genga_events (id, type, at, event) VALUES (${crypto.randomUUID()}, 'media.updated', now(), '{}')
    `;
    await genga.sql`
      INSERT INTO genga_webhook_deliveries (event_seq, url, next_attempt_at)
      SELECT seq, 'https://other.example/hook', now() - interval '1 minute' FROM genga_events
    `;
    await genga.deliverWebhooks();
    expect(calls).toEqual([]);
    const [row] = await genga.sql`SELECT attempts, failed_at FROM genga_webhook_deliveries`;
    expect(row).toMatchObject({ attempts: 0, failed_at: null });
  });

  it('deletes events after 8 days, also without webhooks', async () => {
    genga = start({ webhooks: [] });
    await genga.ready();
    await genga.sql`
      INSERT INTO genga_events (id, type, at, event)
      VALUES (${crypto.randomUUID()}, 'media.updated', ${new Date(clock - 9 * 86_400_000)}, '{}'),
        (${crypto.randomUUID()}, 'media.updated', ${new Date(clock - 6 * 86_400_000)}, '{}')
    `;
    // The first prune ran at start. The next one waits an hour.
    clock += 2 * 3_600_000;
    await genga.deliverWebhooks();
    const [{ count }] = await genga.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM genga_events`;
    expect(count).toBe(1);
  });

  it('keeps undelivered events across a restart', async () => {
    reply = () => new Response(null, { status: 500 });
    await publishNew('Survives');
    await genga.deliverWebhooks();
    await genga.close();

    reply = () => new Response(null, { status: 204 });
    clock += 60_000;
    genga = start();
    await genga.ready();
    await genga.deliverWebhooks();
    const [row] = await genga.sql`SELECT attempts, delivered_at FROM genga_webhook_deliveries`;
    expect(row.attempts).toBe(2);
    expect(row.delivered_at).toBeInstanceOf(Date);
  });

  it('sends only the event types of a webhook', async () => {
    genga = start({ webhooks: [{ url: RECEIVER, secret: SECRET, events: ['document.deleted'] }] });
    const post = await publishNew('Filtered');
    await genga.documents.remove(post.user, post.id);
    await genga.deliverWebhooks();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(await calls[0].request.text()).type).toBe('document.deleted');
  });

  it('lists recent events after a cursor on /api/v1/events', async () => {
    genga = start({ publicApi: { now: () => clock } });
    const read = async (query = '') => {
      const response = await genga.handle(new Request(`${SITE}/api/v1/events${query}`));
      return { status: response?.status, cache: response?.headers.get('cache-control'), body: await response?.json() };
    };
    expect((await read()).body).toEqual({ events: [], hasMore: false });
    const one = await publishNew('One');
    await publishNew('Two');
    await genga.documents.unpublish(one.user, one.id);

    const all = await read();
    expect(all.cache).toBe('no-store');
    expect(all.body.events.map((event: GengaEvent) => `${event.type} ${event.slug}`)).toEqual([
      'document.published one',
      'document.published two',
      'document.unpublished one',
    ]);
    const page = await read('?limit=2');
    expect(page.body.hasMore).toBe(true);
    const rest = await read(`?after=${page.body.events[1].id}`);
    expect(rest.body).toEqual({ events: [all.body.events[2]], hasMore: false });

    expect((await read(`?after=${crypto.randomUUID()}`)).status).toBe(410);
    expect((await read('?after=nope')).status).toBe(400);
    expect((await read('?limit=0')).status).toBe(400);
  });
});

describe('webhook settings', () => {
  const base = { databaseUrl: TEST_URL, siteUrl: SITE, logger: quiet };
  const preview = 'a-preview-secret-that-is-long-enough-for-hmac';

  it('refuses the preview secret, a bad URL, a duplicate and an unknown event type', () => {
    const cases: Partial<GengaOptions>[] = [
      { previewSecret: preview, webhooks: [{ url: RECEIVER, secret: preview }] },
      { webhooks: [{ url: 'ftp://site.example/hook', secret: SECRET }] },
      { webhooks: [{ url: 'not a url', secret: SECRET }] },
      {
        webhooks: [
          { url: RECEIVER, secret: SECRET },
          { url: RECEIVER, secret: OTHER_SECRET },
        ],
      },
      { webhooks: [{ url: RECEIVER, secret: SECRET, events: ['document.created' as never] }] },
      { webhooks: [{ url: RECEIVER, secret: 'whsec_c2hvcnQ=' }] },
    ];
    for (const options of cases) {
      let message = '';
      try {
        createGenga(testConfig, { ...base, ...options }).close();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^Genga: webhooks\[\d\]/);
      expect(message).not.toContain(SECRET.slice(6, 20));
      expect(message).not.toContain(preview);
    }
  });

  it('reads GENGA_WEBHOOKS without repeating it in errors', () => {
    expect(webhooksFromEnv(JSON.stringify([{ url: RECEIVER, secret: SECRET }]))).toEqual([
      { url: RECEIVER, secret: SECRET },
    ]);
    expect(webhooksFromEnv('')).toEqual([]);
    for (const value of [`{"secret":"${SECRET}"`, `{"url":"x","secret":"${SECRET}"}`, `["${SECRET}"]`]) {
      expect(() => webhooksFromEnv(value)).toThrow(/^Genga: GENGA_WEBHOOKS must be a JSON array/);
      try {
        webhooksFromEnv(value);
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    }
  });
});
