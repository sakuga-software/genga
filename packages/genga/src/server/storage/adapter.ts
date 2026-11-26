/**
 * Where media files live: the local adapter, or an S3-compatible bucket (`s3StorageAdapter`).
 * Several server replicas need a storage that they share.
 */
export interface StorageAdapter {
  put(key: string, body: Uint8Array, contentType: string, options?: { contentDisposition?: string }): Promise<void>;
  /** Returns `null` when the key does not exist. */
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  delete(key: string): Promise<void>;
  /** When set, media URLs are `<publicBaseUrl>/<key>` instead of `<mediaPath>/<key>`. */
  publicBaseUrl?: string;
  /** When set, `<mediaPath>/<key>` redirects to this URL instead of streaming the file. */
  signedUrl?(key: string, options?: { contentDisposition?: string }): Promise<{ url: string; expiresIn: number }>;
}
