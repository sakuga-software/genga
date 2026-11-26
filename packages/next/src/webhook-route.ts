import { verifyWebhook, WebhookVerificationError, type GengaEvent } from 'genga/remote';
import { revalidateTag } from 'next/cache';
import { readText } from './body';

/** A Genga event is a small JSON object. A larger body is not one. */
const MAX_BODY_BYTES = 64 * 1024;
const REMEMBERED_IDS = 1000;

export type WebhookRouteOptions = {
  /** The secret of the webhook on the Genga server. Default: `GENGA_WEBHOOK_SECRET`. */
  secret?: string;
  /** Called after the revalidation of each new event. */
  onEvent?: (event: GengaEvent) => void | Promise<void>;
};

/**
 * The receiver of the publish webhooks, `app/api/genga/webhook/route.ts`. It checks the
 * Standard Webhooks signature, then expires each cache tag of the event at once.
 * A bad signature gets 401, and the route logs nothing of the body.
 */
export function webhookRoute(options: WebhookRouteOptions = {}) {
  const handled = new Set<string>();

  function remember(id: string) {
    handled.add(id);
    if (handled.size > REMEMBERED_IDS) handled.delete(handled.values().next().value as string);
  }

  return {
    async POST(request: Request): Promise<Response> {
      const secret = options.secret ?? process.env.GENGA_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[genga] The webhook route has no secret. Set GENGA_WEBHOOK_SECRET.');
        return new Response(null, { status: 500 });
      }
      const body = await readText(request, MAX_BODY_BYTES);
      if (body === null) return new Response(null, { status: 413 });
      let event: GengaEvent;
      try {
        event = await verifyWebhook(
          new Request(request.url, { method: 'POST', headers: request.headers, body }),
          secret,
        );
      } catch (error) {
        if (error instanceof WebhookVerificationError) return new Response(null, { status: 401 });
        // The core throws a plain error for a secret of a bad format. The message names the format, never the value.
        if (error instanceof Error && error.message.startsWith('Genga: a webhook secret')) {
          console.error(`[genga] GENGA_WEBHOOK_SECRET is not valid. ${error.message.slice('Genga: '.length)}`);
          return new Response(null, { status: 500 });
        }
        throw error;
      }
      // Delivery is at least once: a retry of a handled event changes nothing.
      if (!handled.has(event.id)) {
        for (const tag of event.tags) revalidateTag(tag, { expire: 0 });
        await options.onEvent?.(event);
        remember(event.id);
      }
      return new Response(null, { status: 204 });
    },
  };
}
