/**
 * Where media files live. v1 ships the local adapter. An S3-compatible adapter
 * implements the same interface.
 */
export interface StorageAdapter {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Returns `null` when the key does not exist. */
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  delete(key: string): Promise<void>;
}
