# Publish events and webhooks

Genga tells the sites that read it when published content changes, so that they invalidate
their caches. Each change gives one event, with the cache tags to invalidate. The events go
to listeners in the same process and to signed webhooks. A public endpoint lists the recent
events, so a site that missed a webhook can catch up.

## Events

| Type                    | When                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `document.published`    | A publish                                                   |
| `document.slug_changed` | A publish that changes the slug, after `document.published` |
| `document.unpublished`  | An unpublish of a live document                             |
| `document.deleted`      | A delete of a live document                                 |
| `media.updated`         | A change of the alt text of a media item                    |
| `media.deleted`         | A delete of a media item                                    |

A document that was never live gives no event: the events endpoint is public, and a draft
slug stays private.

```json
{
  "id": "0b8a5c1e-3f9d-4d2a-8f7b-2a6c1e9d4f00",
  "type": "document.published",
  "at": "2026-11-24T10:00:00.000Z",
  "collection": "posts",
  "documentId": "8d2f…",
  "slug": "second-name",
  "path": "/blog/second-name",
  "previous": { "slug": "first-name", "path": "/blog/first-name" },
  "versionId": "4c1e…",
  "tags": ["genga:c:posts", "genga:d:posts:second-name", "genga:d:posts:first-name"]
}
```

Media events have `collection`, `documentId`, `slug` and `path` at `null`. They do not name the
media item: the events endpoint is public, and the item can be in drafts only.

## Cache tags

| Tag                           | Means                                      | Invalidated by                             |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ |
| `genga`                       | Everything                                 | `media.updated`, `media.deleted`           |
| `genga:c:<collection>`        | Lists of a collection, its sitemap entries | every document event of the collection     |
| `genga:d:<collection>:<slug>` | One document by slug                       | events of that document (old and new slug) |

Tag your cached reads with `tagsFor(collection, slug?)` from `genga`. It gives the tags that
the events invalidate, so a read and its invalidation always agree.

## In process

```ts
genga.events.on('document.published', async (event) => {
  for (const tag of event.tags) revalidateTag(tag);
});
genga.events.on('*', (event) => console.info(event.type)); // every type
```

Listeners run after the transaction commits, in the request that made the change. An error in
a listener is logged and does not fail the change. `on` returns the function that removes the
listener.

## Webhooks

```ts
createGenga(config, {
  // …
  webhooks: [{ url: 'https://www.example.com/api/genga/webhook', secret: process.env.GENGA_WEBHOOK_SECRET! }],
});
```

On the server image, set `GENGA_WEBHOOKS` to a JSON array of the same objects:

```sh
GENGA_WEBHOOKS='[{"url":"https://www.example.com/api/genga/webhook","secret":"whsec_…","events":["document.published"]}]'
```

- `secret` is a [Standard Webhooks](https://www.standardwebhooks.com/) secret: `whsec_`
  followed by 24 to 64 random bytes in base64. Make one with
  `echo "whsec_$(openssl rand -base64 32)"`. Use one secret per receiver.
- The webhook secret must not be `GENGA_SECRET`. Genga refuses to start if it is: the site
  holds the webhook secret, and with the preview secret it could sign a preview token for any
  draft.
- `events` lists the types to send. Default: all of them.

### Delivery

- The body is the event as JSON. The headers are `webhook-id` (the event id),
  `webhook-timestamp` (seconds, new at each attempt) and
  `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`.
- **Outbox.** The transaction of the change also writes the event to the `genga_events`
  table. A sender in the Genga process delivers from it, so a restart loses nothing. The
  transactions that write events take one advisory lock, so that the order of the events is
  the order of the commits. Two publishes therefore commit one after the other.
- **Retries.** A `2xx` answer is a success. Other answers, a redirect, a timeout (10 s) or a
  network error schedule a retry after about 5 s, 5 min, 30 min, 2 h, 5 h and 10 h, then a
  last attempt 24 hours after the event. `Retry-After` is respected within these 24 hours.
  `410 Gone` stops at once.
- **At least once, in any order.** A receiver can get one event twice, and a retry can come
  after a newer event. Ignore a `webhook-id` that you already handled. The tags make the order
  unimportant: an invalidation is the same in any order.
- **One sender per URL list.** A Genga process delivers only to the URLs of its own
  `webhooks` option. In a rolling deploy, a delivery for a new URL waits for a process that
  knows it.

### Receive a webhook

`verifyWebhook` runs on Node and on edge runtimes (WebCrypto only):

```ts
import { verifyWebhook, WebhookVerificationError } from 'genga';

export async function POST(request: Request) {
  try {
    const event = await verifyWebhook(request, process.env.GENGA_WEBHOOK_SECRET!);
    for (const tag of event.tags) revalidateTag(tag);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw error;
  }
}
```

It rejects a missing header, a bad signature, and a timestamp more than 5 minutes from now.
Log nothing of the body of a rejected request.

## Catch up: `GET /api/v1/events`

When the [public API](./api.md#get-apiv1events) is on, this endpoint lists the events of the
last 7 days, oldest first. A site calls it at start and every 5 minutes, so a missed webhook
still invalidates its cache.

```sh
curl 'https://cms.example.com/api/v1/events?after=0b8a5c1e-3f9d-4d2a-8f7b-2a6c1e9d4f00'
# { "events": [ … ], "hasMore": false }
```

- `after`: the id of the last event that you handled. Without it, the list starts 7 days ago.
- `limit`: 1 to 500. Default 500. While `hasMore` is true, call again with the id of the last
  event.
- An `after` that is unknown or older than 7 days answers `410` with `cursor_expired`.
  Invalidate the tag `genga`, then read again without `after`.

Genga deletes events after 8 days, with or without webhooks. Keep a safety TTL on your caches (one hour, for example),
never "forever".
