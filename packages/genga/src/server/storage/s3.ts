import { AwsClient } from 'aws4fetch';
import type { StorageAdapter } from './adapter';

const SAFE_KEY = /^[a-z0-9][a-z0-9.-]*$/;
const SAFE_PREFIX = /^[A-Za-z0-9!_.*'()/-]*$/;

/**
 * How browsers get the files:
 * - `proxy`: Genga streams each file at `<mediaPath>/<key>`, with its security headers;
 * - `public`: media URLs point to `publicUrl` (a public bucket or a CDN), and Genga serves no byte;
 * - `signed`: `<mediaPath>/<key>` redirects to a presigned URL of a private bucket.
 */
export type S3Delivery = 'proxy' | 'public' | 'signed';

export type S3StorageOptions = {
  bucket: string;
  /** Default: `us-east-1`. */
  region?: string;
  /** For a provider other than AWS, for example `https://s3.fr-par.scw.cloud` or a MinIO URL. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Put every file under this prefix, for example `genga/`. */
  prefix?: string;
  /** Path-style URLs (`<endpoint>/<bucket>/<key>`). Default: true with an `endpoint`, false on AWS. */
  forcePathStyle?: boolean;
  /** Default: `proxy`. */
  delivery?: S3Delivery;
  /** For `public`: the URL that serves the files, without a trailing slash. */
  publicUrl?: string;
  /** For `signed`: seconds that a presigned URL stays valid. Default: 3600. */
  signedUrlExpiresIn?: number;
  /** Milliseconds for one request to the bucket. Default: 30 000. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
};

function trimSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

function checkOptions(options: S3StorageOptions) {
  const problems: string[] = [];
  if (!options.bucket) problems.push('bucket is required');
  if (!options.accessKeyId || !options.secretAccessKey) problems.push('accessKeyId and secretAccessKey are required');
  if (options.prefix && !SAFE_PREFIX.test(options.prefix))
    problems.push('prefix has characters that S3 keys must not have');
  if (options.endpoint && !/^https?:\/\/[^/]+\/?$/.test(options.endpoint)) {
    problems.push('endpoint must be an origin, for example https://s3.fr-par.scw.cloud');
  }
  const delivery = options.delivery ?? 'proxy';
  if (!['proxy', 'public', 'signed'].includes(delivery)) problems.push('delivery must be proxy, public or signed');
  if (delivery === 'public' && !/^https?:\/\/./.test(options.publicUrl ?? '')) {
    problems.push('publicUrl is required with delivery: public, for example https://media.example.com');
  }
  const ttl = options.signedUrlExpiresIn;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 604_800)) {
    problems.push('signedUrlExpiresIn must be an integer from 60 to 604800 seconds');
  }
  // The messages name the options only: never a key or a secret.
  if (problems.length) throw new Error(`Genga: the S3 storage options are not valid: ${problems.join('; ')}.`);
}

/** A `StorageAdapter` for an S3-compatible bucket: AWS S3, Scaleway Object Storage, MinIO. */
export function s3StorageAdapter(options: S3StorageOptions): StorageAdapter {
  checkOptions(options);
  const region = options.region || 'us-east-1';
  const delivery = options.delivery ?? 'proxy';
  const send = options.fetch ?? ((input: Request) => fetch(input));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const expiresIn = options.signedUrlExpiresIn ?? 3600;
  const prefix = options.prefix ? `${trimSlashes(options.prefix)}/` : '';
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    service: 's3',
    region,
    retries: 0,
  });
  const pathStyle = options.forcePathStyle ?? Boolean(options.endpoint);
  const endpoint = new URL(options.endpoint ?? `https://s3.${region}.amazonaws.com`);
  const base = pathStyle
    ? `${endpoint.origin}/${encodeURIComponent(options.bucket)}`
    : `${endpoint.protocol}//${options.bucket}.${endpoint.host}`;

  function objectUrl(key: string) {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe media key: ${key}`);
    return `${base}/${prefix}${key}`;
  }

  /** The timeout stops at the response headers: a slow client can take longer to read a large body. */
  async function call(method: string, key: string, init: RequestInit = {}) {
    const signed = await client.sign(objectUrl(key), { ...init, method });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`The S3 ${method} of ${key} took too long.`)), timeoutMs);
    try {
      return await send(new Request(signed, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function failure(method: string, key: string, status: number) {
    return new Error(`Genga: the S3 ${method} of ${key} answered HTTP ${status}.`);
  }

  const adapter: StorageAdapter = {
    async put(key, body, contentType, extra = {}) {
      const headers: Record<string, string> = {
        'content-type': contentType,
        'cache-control': 'public, max-age=31536000, immutable',
      };
      if (extra.contentDisposition) headers['content-disposition'] = extra.contentDisposition;
      const response = await call('PUT', key, { body: new Uint8Array(body), headers });
      await response.body?.cancel();
      if (!response.ok) throw failure('PUT', key, response.status);
    },
    async get(key) {
      const response = await call('GET', key);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw failure('GET', key, response.status);
      }
      return { body: response.body, size: Number(response.headers.get('content-length') ?? 0) };
    },
    async delete(key) {
      const response = await call('DELETE', key);
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw failure('DELETE', key, response.status);
    },
  };

  if (delivery === 'public') adapter.publicBaseUrl = trimSlashes(options.publicUrl as string);
  if (delivery === 'signed') {
    adapter.deliveryOrigins = [new URL(objectUrl('x')).origin];
    adapter.signedUrl = async (key, extra = {}) => {
      const url = new URL(objectUrl(key));
      url.searchParams.set('X-Amz-Expires', String(expiresIn));
      // A query space becomes `+`, which some providers read literally in a signed URL. RFC 6266
      // allows the header without the space, and the cleaned filename has none.
      const disposition = extra.contentDisposition?.replace(/;\s+/g, ';');
      if (disposition) url.searchParams.set('response-content-disposition', disposition);
      const signed = await client.sign(url.href, { method: 'GET', aws: { signQuery: true } });
      return { url: signed.url, expiresIn };
    };
  }
  return adapter;
}
