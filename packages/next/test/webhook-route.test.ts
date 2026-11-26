import { signWebhook, type GengaEvent } from 'genga';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextState } from './next-state';
import { webhookRoute } from '../src/webhook-route';

const SECRET = `whsec_${btoa('a-webhook-secret-of-32-bytes-ok!')}`;

const event: GengaEvent = {
  id: '6f1c2b0e-2b1d-4f0e-8a51-0d2c4e6f8a10',
  type: 'document.published',
  at: '2026-11-26T10:00:00.000Z',
  collection: 'posts',
  documentId: 'doc',
  slug: 'hello',
  path: '/blog/hello',
  previous: null,
  versionId: 'v1',
  tags: ['genga:c:posts', 'genga:d:posts:hello'],
};

async function delivery(body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000)) {
  return new Request('https://www.example.com/api/genga/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': event.id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signWebhook(SECRET, event.id, timestamp, body),
    },
    body,
  });
}

beforeEach(() => nextState.reset());

describe('webhookRoute', () => {
  it('expires each tag of a signed event at once', async () => {
    const onEvent = vi.fn();
    const response = await webhookRoute({ secret: SECRET, onEvent }).POST(await delivery());
    expect(response.status).toBe(204);
    expect(nextState.revalidated).toEqual([
      { tag: 'genga:c:posts', profile: { expire: 0 } },
      { tag: 'genga:d:posts:hello', profile: { expire: 0 } },
    ]);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('handles a retry of the same event one time', async () => {
    const route = webhookRoute({ secret: SECRET });
    await route.POST(await delivery());
    const response = await route.POST(await delivery());
    expect(response.status).toBe(204);
    expect(nextState.revalidated).toHaveLength(2);
  });

  it('answers 401 for a bad signature', async () => {
    const request = await delivery();
    request.headers.set('webhook-signature', 'v1,AAAA');
    const response = await webhookRoute({ secret: SECRET }).POST(request);
    expect(response.status).toBe(401);
    expect(nextState.revalidated).toHaveLength(0);
  });

  it('answers 401 for an old timestamp', async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const response = await webhookRoute({ secret: SECRET }).POST(await delivery(undefined, old));
    expect(response.status).toBe(401);
  });

  it('answers 413 for a large body', async () => {
    const body = JSON.stringify({ ...event, padding: 'x'.repeat(70_000) });
    const response = await webhookRoute({ secret: SECRET }).POST(await delivery(body));
    expect(response.status).toBe(413);
  });

  it('reads the secret from GENGA_WEBHOOK_SECRET', async () => {
    vi.stubEnv('GENGA_WEBHOOK_SECRET', SECRET);
    const response = await webhookRoute().POST(await delivery());
    vi.unstubAllEnvs();
    expect(response.status).toBe(204);
  });
});
