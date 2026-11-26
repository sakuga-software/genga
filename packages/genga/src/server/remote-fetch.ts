import dns, { type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { GengaError } from './errors';

/** Same contract as `dns.lookup` with `{ all: true }`. Tests give a fake one. */
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

export type RemoteFetchOptions = {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  lookup?: LookupAll;
  /** Default: `isPublicAddress`. */
  isAllowedAddress?: (address: string) => boolean;
  /** Ports that the URL and each redirect can use. Default: `DEFAULT_ALLOWED_PORTS`. */
  allowedPorts?: readonly number[];
};

/** A public host can run other services on other ports, so only the web ports pass by default. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

export type RemoteFile = { body: Buffer; filename: string; contentType: string | null; url: string };

/**
 * Ranges that a server-side fetch must never reach: private, loopback, link-local,
 * shared, documentation, multicast and reserved ranges. IPv6 forms that embed an IPv4
 * address (NAT64, 6to4, Teredo) are blocked too, because they can hide a private address.
 * BlockList checks an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) against the IPv4 rules.
 * `::/96` (IPv4-compatible, with `::` and `::1`) and `::ffff:0:0:0/96` (SIIT) are blocked as a whole.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** True for a unicast address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(ip);
  if (family === 0) return false;
  return !BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** One message for every host that fails, so the error tells nothing about the internal network. */
function blocked(host: string) {
  return new GengaError(
    400,
    'url_blocked',
    `The host ${host} has no public address. Give a public http(s) URL, or send the file as base64.`,
  );
}

function portBlocked(port: number, allowedPorts: readonly number[]) {
  return new GengaError(
    400,
    'url_blocked',
    `The port ${port} is not allowed. Use a URL on port ${allowedPorts.join(' or ')}.`,
  );
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function failed(message: string) {
  return new GengaError(400, 'fetch_failed', message);
}

function tooLarge(maxBytes: number) {
  return new GengaError(413, 'too_large', `The file is larger than ${maxBytes} bytes.`);
}

const systemLookup: LookupAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

function filenameOf(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last) || 'fichier';
  } catch {
    return last || 'fichier';
  }
}

/**
 * Downloads a file for the media library, with SSRF protection:
 * - only `http:` and `https:` URLs without credentials;
 * - the port must be in `allowedPorts`;
 * - every address of the host must be public, and the socket connects to a checked address;
 * - each redirect is checked again, up to `maxRedirects`;
 * - the body stops at `maxBytes`, and the whole download at `timeoutMs`.
 */
export async function fetchRemoteFile(input: string, options: RemoteFetchOptions): Promise<RemoteFile> {
  const lookupAll = options.lookup ?? systemLookup;
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);

  // The socket uses this lookup, so the address that it connects to is the address that passed the check.
  const checkedLookup = (
    hostname: string,
    lookupOptions: { all?: boolean },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    lookupAll(hostname).then(
      (addresses) => {
        if (!addresses.length) return callback(blocked(hostname), []);
        if (addresses.some((entry) => !allowed(entry.address))) return callback(blocked(hostname), []);
        if (lookupOptions.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      },
      () => callback(blocked(hostname), []),
    );
  };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw failed('The URL is not valid.');
  }
  for (let redirects = 0; ; redirects += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failed('Only http and https URLs are allowed.');
    if (url.username || url.password) throw failed('The URL must not contain credentials.');
    if (!allowedPorts.includes(portOf(url))) throw portBlocked(portOf(url), allowedPorts);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !allowed(host)) throw blocked(host);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failed('The download took too long.');

    const response = await get(url, checkedLookup, remaining, options.maxBytes);
    if (response.kind === 'redirect') {
      if (redirects >= maxRedirects) throw failed(`More than ${maxRedirects} redirects.`);
      url = new URL(response.location, url);
      continue;
    }
    return { body: response.body, filename: filenameOf(url), contentType: response.contentType, url: url.href };
  }
}

type GetResult = { kind: 'redirect'; location: string } | { kind: 'body'; body: Buffer; contentType: string | null };

function get(url: URL, lookup: http.RequestOptions['lookup'], timeoutMs: number, maxBytes: number): Promise<GetResult> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      agent: false,
      lookup,
      headers: { 'user-agent': 'Genga-MCP (media upload)', accept: 'image/*, application/pdf;q=0.9' },
    });
    let settled = false;
    const timer = setTimeout(() => request.destroy(failed('The download took too long.')), timeoutMs);
    const finish = (result: GetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(error instanceof GengaError ? error : failed(`The download failed: ${(error as Error).message}.`));
    };
    request.on('error', fail);
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      // A redirect or an error body can be endless: close the connection, do not read it.
      if (status >= 300 && status < 400 && response.headers.location) {
        finish({ kind: 'redirect', location: response.headers.location });
        request.destroy();
        return;
      }
      if (status !== 200) {
        fail(failed(`The server answered HTTP ${status}.`));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        fail(tooLarge(maxBytes));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          fail(tooLarge(maxBytes));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        finish({ kind: 'body', body: Buffer.concat(chunks), contentType: response.headers['content-type'] ?? null });
      });
    });
    request.end();
  });
}
