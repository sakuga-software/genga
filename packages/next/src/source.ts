import { createRemoteSource as createCoreRemoteSource, type GengaSource, type RemoteSourceOptions } from 'genga/remote';

/** Cached reads expire after this time, also when no webhook arrives. */
export const DEFAULT_MAX_AGE_SECONDS = 60 * 60;

export type NextRemoteSourceOptions = Omit<RemoteSourceOptions, 'fetch'> & {
  /** Seconds before a cached read expires without a webhook. Default: one hour. */
  maxAge?: number;
  /**
   * The origin of the Genga admin in the browser, when the site reads the API at another
   * address (for example a private network address). Default: the origin of `url`.
   */
  adminOrigin?: string;
};

/** A remote source with the origins that the preview needs. */
export type GengaNextSource = GengaSource & {
  /** The origin of the Genga server. */
  readonly url: string;
  /** The origin of the Genga admin. The preview bridge accepts messages only from it. */
  readonly adminOrigin: string;
};

/**
 * The remote source of `genga/remote`, with the cache of Next.js: published reads go to the
 * Data Cache with the Genga cache tags, and preview reads are never cached.
 */
export function createRemoteSource(options: NextRemoteSourceOptions): GengaNextSource {
  const { maxAge = DEFAULT_MAX_AGE_SECONDS, adminOrigin, ...rest } = options;
  if (!Number.isInteger(maxAge) || maxAge < 1) throw new Error('Genga: maxAge must be a positive number of seconds.');
  const source = createCoreRemoteSource({
    ...rest,
    fetch: async (url, init, hints) => {
      const response = await fetch(
        url,
        hints.preview
          ? { ...init, cache: 'no-store' }
          : ({ ...init, next: { tags: hints.tags, revalidate: maxAge } } as RequestInit),
      );
      // WARNING: the fetch of Next.js gives a teed body. A `cancel()` of one branch waits for the
      // other branch, and the source cancels the body of each 401 and 404. A copy of the body
      // does not wait. The answers of the public API are small JSON documents.
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const url = new URL(options.url).origin;
  return Object.assign(source, { url, adminOrigin: adminOrigin ? new URL(adminOrigin).origin : url });
}
