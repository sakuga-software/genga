import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGenga, s3StorageAdapter, type Genga, type S3StorageOptions } from '../src/server';
import { TEST_URL } from './global-setup';
import { createUser, pngFile, SITE, testConfig } from './helpers';

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

/** A fake bucket that records each request. */
function recorder(answer: (request: Request) => Response = () => new Response(null, { status: 200 })) {
  const requests: Request[] = [];
  const fetch = (async (input: Request) => {
    requests.push(input);
    return answer(input);
  }) as typeof globalThis.fetch;
  return { requests, fetch };
}

describe('s3StorageAdapter without a bucket', () => {
  it('builds path-style URLs for an endpoint, and virtual-hosted URLs for AWS', async () => {
    const minio = recorder();
    await s3StorageAdapter({
      ...CREDENTIALS,
      bucket: 'media',
      endpoint: 'http://minio.test:9000',
      prefix: 'genga/',
      fetch: minio.fetch,
    }).put('abc.png', new Uint8Array([1]), 'image/png');
    expect(minio.requests[0].url).toBe('http://minio.test:9000/media/genga/abc.png');
    expect(minio.requests[0].method).toBe('PUT');
    expect(minio.requests[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(minio.requests[0].headers.get('content-type')).toBe('image/png');

    const aws = recorder();
    await s3StorageAdapter({ ...CREDENTIALS, bucket: 'media', region: 'eu-west-3', fetch: aws.fetch }).delete(
      'abc.png',
    );
    expect(aws.requests[0].url).toBe('https://media.s3.eu-west-3.amazonaws.com/abc.png');
    expect(aws.requests[0].headers.get('authorization')).toContain('/eu-west-3/s3/aws4_request');
  });

  it('returns null on 404 only, and throws on another error without the secret', async () => {
    const missing = recorder(() => new Response('<Error/>', { status: 404 }));
    const adapter = s3StorageAdapter({ ...CREDENTIALS, bucket: 'b', endpoint: 'http://s3.test', fetch: missing.fetch });
    expect(await adapter.get('abc.png')).toBeNull();
    await expect(adapter.delete('abc.png')).resolves.toBeUndefined();

    const denied = recorder(() => new Response('<Error>AccessDenied</Error>', { status: 403 }));
    const refused = s3StorageAdapter({ ...CREDENTIALS, bucket: 'b', endpoint: 'http://s3.test', fetch: denied.fetch });
    const error = await refused.get('abc.png').catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).not.toContain(CREDENTIALS.secretAccessKey);
    await expect(refused.put('abc.png', new Uint8Array([1]), 'image/png')).rejects.toThrow('403');
    expect(denied.requests).toHaveLength(2);
  });

  it('refuses an unsafe key, and names only the bad options', async () => {
    const adapter = s3StorageAdapter({
      ...CREDENTIALS,
      bucket: 'b',
      endpoint: 'http://s3.test',
      fetch: recorder().fetch,
    });
    await expect(adapter.get('../secret')).rejects.toThrow('Unsafe media key');
    for (const options of [
      { bucket: '' },
      { delivery: 'public' as const },
      { delivery: 'cdn' as never },
      { endpoint: 'http://s3.test/path' },
      { signedUrlExpiresIn: 10 },
      { secretAccessKey: '' },
    ]) {
      const make = () => s3StorageAdapter({ ...CREDENTIALS, bucket: 'b', ...options } as S3StorageOptions);
      expect(make).toThrow('S3 storage options are not valid');
      try {
        make();
      } catch (error) {
        expect((error as Error).message).not.toContain(CREDENTIALS.secretAccessKey);
      }
    }
  });

  it('gives a public base URL or a presigned URL, depending on the delivery', async () => {
    const options = { ...CREDENTIALS, bucket: 'b', endpoint: 'http://s3.test', fetch: recorder().fetch };
    expect(s3StorageAdapter(options).publicBaseUrl).toBeUndefined();
    expect(s3StorageAdapter(options).signedUrl).toBeUndefined();
    expect(
      s3StorageAdapter({ ...options, delivery: 'public', publicUrl: 'https://cdn.example.com/genga/' }).publicBaseUrl,
    ).toBe('https://cdn.example.com/genga');
    const signed = await s3StorageAdapter({ ...options, delivery: 'signed', signedUrlExpiresIn: 600 }).signedUrl?.(
      'abc.pdf',
      { contentDisposition: 'attachment; filename="a.pdf"' },
    );
    const url = new URL(signed?.url ?? '');
    expect(url.origin + url.pathname).toBe('http://s3.test/b/abc.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="a.pdf"');
    expect(signed?.expiresIn).toBe(600);
  });
});

const ENDPOINT = process.env.GENGA_TEST_S3_ENDPOINT;
const ACCESS_KEY = process.env.GENGA_TEST_S3_ACCESS_KEY ?? '';
const SECRET_KEY = process.env.GENGA_TEST_S3_SECRET_KEY ?? '';

describe('s3StorageAdapter against MinIO', () => {
  it('has a MinIO endpoint in CI', () => {
    // A skip in CI would give a green run with no S3 test.
    if (process.env.CI) expect(ENDPOINT, 'GENGA_TEST_S3_ENDPOINT').toBeTruthy();
  });

  describe.skipIf(!ENDPOINT)('with a bucket', () => {
    const bucket = `genga-test-${Date.now()}`;
    const admin = new AwsClient({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      service: 's3',
      region: 'us-east-1',
    });
    const started: Genga[] = [];
    let mediaDir: string;

    async function startWith(options: Partial<S3StorageOptions>) {
      const genga = createGenga(testConfig, {
        databaseUrl: TEST_URL,
        siteUrl: SITE,
        mediaDir,
        storage: s3StorageAdapter({
          bucket,
          endpoint: ENDPOINT,
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
          prefix: 'genga',
          ...options,
        }),
        logger: { info: () => {}, warn: () => {}, error: console.error },
      });
      started.push(genga);
      await genga.ready();
      await genga.sql`TRUNCATE genga_media, genga_users CASCADE`;
      return genga;
    }

    beforeAll(async () => {
      mediaDir = await mkdtemp(path.join(tmpdir(), 'genga-s3-'));
      const created = await admin.fetch(`${ENDPOINT}/${bucket}`, { method: 'PUT' });
      expect(created.status).toBe(200);
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucket}/genga/public/*`],
          },
        ],
      };
      const policySet = await admin.fetch(`${ENDPOINT}/${bucket}?policy=`, {
        method: 'PUT',
        body: JSON.stringify(policy),
      });
      expect(policySet.status).toBeLessThan(300);
    });

    afterAll(async () => {
      for (const genga of started) await genga.close();
      await rm(mediaDir, { recursive: true, force: true });
    });

    async function bytesOf(response: Response) {
      return Buffer.from(await response.arrayBuffer());
    }

    it('proxy: uploads to the bucket, serves the bytes through Genga, and deletes them', async () => {
      const genga = await startWith({});
      const user = await createUser(genga, 'editor');
      const file = await pngFile('proxy.png');
      const { media } = await genga.media.upload(user, file, 'Proxy');
      expect(media.url).toMatch(/^\/media\/[0-9a-f]{64}\.png$/);
      const key = media.url.replace('/media/', '');
      const served = await genga.media.serve(key);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/png');
      const original = await bytesOf(served);
      expect(original.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

      const direct = await admin.fetch(`${ENDPOINT}/${bucket}/genga/${key}`);
      expect(direct.headers.get('cache-control')).toContain('immutable');
      expect((await bytesOf(direct)).equals(original)).toBe(true);
      const anonymous = await fetch(`${ENDPOINT}/${bucket}/genga/${key}`);
      expect(anonymous.status).toBe(403);

      await genga.media.remove(user, media.id);
      expect((await admin.fetch(`${ENDPOINT}/${bucket}/genga/${key}`)).status).toBe(404);
      expect((await genga.media.serve(key)).status).toBe(404);
    });

    it('public: media URLs point to the public URL, which serves the same bytes', async () => {
      const genga = await startWith({
        prefix: 'genga/public',
        delivery: 'public',
        publicUrl: `${ENDPOINT}/${bucket}/genga/public`,
      });
      const user = await createUser(genga, 'editor');
      const { media } = await genga.media.upload(user, await pngFile('public.png', { r: 10, g: 20, b: 30 }), 'Public');
      expect(media.url.startsWith(`${ENDPOINT}/${bucket}/genga/public/`)).toBe(true);
      expect(media.sizes.every((size) => size.url.startsWith(`${ENDPOINT}/`))).toBe(true);
      const response = await fetch(media.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      const key = media.url.split('/').pop() as string;
      expect((await bytesOf(response)).equals(await bytesOf(await genga.media.serve(key)))).toBe(true);
    });

    it('signed: Genga redirects to a presigned URL of the private bucket', async () => {
      const genga = await startWith({ delivery: 'signed', signedUrlExpiresIn: 600 });
      const user = await createUser(genga, 'editor');
      const { media } = await genga.media.upload(user, await pngFile('signed.png', { r: 200, g: 0, b: 0 }), 'Signed');
      expect(media.url).toMatch(/^\/media\//);
      const key = media.url.replace('/media/', '');
      const redirect = await genga.media.serve(key);
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('cache-control')).toBe('public, max-age=150');
      const location = redirect.headers.get('location') as string;
      expect(location).toContain('X-Amz-Signature=');
      const response = await fetch(location);
      expect(response.status).toBe(200);
      expect((await bytesOf(response)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect((await fetch(`${ENDPOINT}/${bucket}/genga/${key}`)).status).toBe(403);
      expect((await genga.media.serve(`${'f'.repeat(64)}.png`)).status).toBe(404);
    });
  });
});
