import { isGengaEventType, type GengaEvent } from './events';

const SECRET_PREFIX = 'whsec_';
const MIN_KEY_BYTES = 24;
const MAX_KEY_BYTES = 64;
/** Receivers reject a `webhook-timestamp` older or newer than this. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decodes a Standard Webhooks secret: `whsec_` followed by 24 to 64 random bytes in base64.
 * The prefix is optional. Throws on another format.
 */
export function webhookKey(secret: string): Uint8Array {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  let key: Uint8Array;
  try {
    key = base64ToBytes(encoded);
  } catch {
    throw new Error(
      'Genga: a webhook secret must be "whsec_" followed by base64. Try: whsec_$(openssl rand -base64 32)',
    );
  }
  if (key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
    throw new Error(
      `Genga: a webhook secret must hold ${MIN_KEY_BYTES} to ${MAX_KEY_BYTES} bytes. Try: whsec_$(openssl rand -base64 32)`,
    );
  }
  return key;
}

async function hmac(key: Uint8Array, content: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(content));
  return bytesToBase64(new Uint8Array(signature));
}

/** The `webhook-signature` value of a body: `v1,<base64 HMAC-SHA256 of id.timestamp.body>`. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  return `v1,${await hmac(webhookKey(secret), `${id}.${timestamp}.${body}`)}`;
}

/** The three Standard Webhooks headers of one delivery attempt. */
export async function webhookHeaders(
  secret: string,
  id: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': await signWebhook(secret, id, timestamp, body),
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export type VerifyWebhookOptions = {
  /** The current time in milliseconds. For tests. */
  now?: number;
  /** Default: 300 seconds. */
  toleranceSeconds?: number;
};

/**
 * Checks a Genga webhook with the Standard Webhooks rules and returns its event.
 * It reads the body of the request. It runs on Node and on edge runtimes (WebCrypto only).
 * On a bad signature or an old timestamp it throws a `WebhookVerificationError`: answer 401.
 * Receivers must ignore an event whose `webhook-id` they already handled.
 */
export async function verifyWebhook(
  request: Request,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<GengaEvent> {
  const id = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  const signatures = request.headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('Missing webhook headers.');
  if (!/^\d{1,12}$/.test(timestamp)) throw new WebhookVerificationError('Invalid webhook timestamp.');
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    throw new WebhookVerificationError('The webhook timestamp is outside the tolerance.');
  }
  const body = await request.text();
  const expected = await hmac(webhookKey(secret), `${id}.${timestamp}.${body}`);
  const matches = signatures
    .split(' ')
    .some((entry) => entry.startsWith('v1,') && constantTimeEqual(entry.slice(3), expected));
  if (!matches) throw new WebhookVerificationError('Invalid webhook signature.');
  let event: GengaEvent;
  try {
    event = JSON.parse(body) as GengaEvent;
  } catch {
    throw new WebhookVerificationError('The webhook body is not JSON.');
  }
  if (!event || event.id !== id || !isGengaEventType(event.type) || !Array.isArray(event.tags)) {
    throw new WebhookVerificationError('The webhook body is not a Genga event.');
  }
  return event;
}
