import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchRemoteFile, isPublicAddress, type LookupAll } from '../src/server/remote-fetch';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A fake DNS: no test reaches a real resolver. */
const fakeDns =
  (table: Record<string, string[]>): LookupAll =>
  async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

let server: http.Server;
let port: number;
let openResponses = 0;

function streamForever(res: http.ServerResponse) {
  res.write('x');
  const timer = setInterval(() => res.write('x'.repeat(1000)), 20);
  res.on('close', () => clearInterval(timer));
}

/** The test server stands for a public host: only its exact address is let through. */
const LOOPBACK_AS_PUBLIC = (address: string) => address === '127.0.0.1' || isPublicAddress(address);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    openResponses += 1;
    res.on('close', () => (openResponses -= 1));
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/image.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
      res.end();
    } else if (url.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (url.pathname === '/endless-redirect') {
      res.writeHead(302, { location: '/endless-error' });
      streamForever(res);
    } else if (url.pathname === '/endless-error') {
      res.writeHead(500);
      streamForever(res);
    } else if (url.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.alloc(600));
      res.end(Buffer.alloc(600));
    } else if (url.pathname === '/big-declared') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5000' });
      res.end(Buffer.alloc(5000));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '::ffff:0:7f00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%en0',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('fetchRemoteFile', () => {
  const options = { maxBytes: 1000, lookup: fakeDns({}) };

  it.each([
    'http://127.0.0.1/image.png',
    'http://10.0.0.8/image.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/image.png',
    'http://[::ffff:127.0.0.1]/image.png',
    'http://2130706433/image.png',
    'http://0x7f.1/image.png',
  ])('blocks the address in %s before any connection', async (url) => {
    await expect(fetchRemoteFile(url, options)).rejects.toMatchObject({ status: 400, code: 'url_blocked' });
  });

  it('blocks a name that resolves to a private address', async () => {
    const lookup = fakeDns({ 'internal.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] });
    await expect(fetchRemoteFile('http://internal.example/a.png', { maxBytes: 1000, lookup })).rejects.toMatchObject({
      code: 'url_blocked',
    });
    await expect(fetchRemoteFile('https://mixed.example/a.png', { maxBytes: 1000, lookup })).rejects.toMatchObject({
      code: 'url_blocked',
    });
  });

  it('gives one error for a private, an unknown or an empty host', async () => {
    const lookup: LookupAll = async (hostname) => {
      if (hostname === 'empty.example') return [];
      if (hostname === 'internal.example') return [{ address: '10.0.0.5', family: 4 }];
      throw new Error('ENOTFOUND');
    };
    const messages = new Set<string>();
    for (const host of ['internal.example', 'missing.example', 'empty.example']) {
      const error = await fetchRemoteFile(`http://${host}/a.png`, { maxBytes: 1000, lookup }).catch((caught) => caught);
      messages.add(`${error.code} ${error.message.replace(host, '<host>')}`);
    }
    expect([...messages]).toHaveLength(1);
  });

  it('closes the connection of a redirect or an error, even if the body never ends', async () => {
    await expect(
      fetchRemoteFile(`http://files.example:${port}/endless-redirect`, {
        maxBytes: 1000,
        timeoutMs: 2000,
        lookup: fakeDns({ 'files.example': ['127.0.0.1'] }),
        isAllowedAddress: LOOPBACK_AS_PUBLIC,
      }),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(openResponses).toBe(0);
  });

  it('refuses other schemes and credentials', async () => {
    await expect(fetchRemoteFile('file:///etc/passwd', options)).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(fetchRemoteFile('ftp://example.com/a.png', options)).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(fetchRemoteFile('http://user:pass@files.example/a.png', options)).rejects.toMatchObject({
      code: 'fetch_failed',
    });
  });

  it('downloads from an allowed host', async () => {
    const file = await fetchRemoteFile(`http://files.example:${port}/image.png`, {
      maxBytes: 1000,
      lookup: fakeDns({ 'files.example': ['127.0.0.1'] }),
      isAllowedAddress: LOOPBACK_AS_PUBLIC,
    });
    expect(file.body.equals(PNG)).toBe(true);
    expect(file.filename).toBe('image.png');
  });

  it('checks each redirect again: a redirect to a private address is blocked', async () => {
    const lookup = fakeDns({ 'files.example': ['127.0.0.1'], 'internal.example': ['10.0.0.5'] });
    const base = `http://files.example:${port}/redirect?to=`;
    for (const target of [
      'http://169.254.169.254/latest/meta-data/',
      'http://internal.example/a.png',
      'http://[::1]/',
    ]) {
      await expect(
        fetchRemoteFile(base + encodeURIComponent(target), {
          maxBytes: 1000,
          lookup,
          isAllowedAddress: LOOPBACK_AS_PUBLIC,
        }),
      ).rejects.toMatchObject({ code: 'url_blocked' });
    }
  });

  it('follows a redirect to an allowed host, and stops a redirect loop', async () => {
    const lookup = fakeDns({ 'files.example': ['127.0.0.1'] });
    const allowed = { maxBytes: 1000, lookup, isAllowedAddress: LOOPBACK_AS_PUBLIC };
    const file = await fetchRemoteFile(`http://files.example:${port}/redirect?to=/image.png`, allowed);
    expect(file.body.equals(PNG)).toBe(true);
    await expect(fetchRemoteFile(`http://files.example:${port}/loop`, allowed)).rejects.toMatchObject({
      code: 'fetch_failed',
    });
  });

  it('stops a body larger than maxBytes, with or without Content-Length', async () => {
    const allowed = {
      maxBytes: 1000,
      lookup: fakeDns({ 'files.example': ['127.0.0.1'] }),
      isAllowedAddress: LOOPBACK_AS_PUBLIC,
    };
    await expect(fetchRemoteFile(`http://files.example:${port}/big`, allowed)).rejects.toMatchObject({ status: 413 });
    await expect(fetchRemoteFile(`http://files.example:${port}/big-declared`, allowed)).rejects.toMatchObject({
      status: 413,
    });
  });
});
