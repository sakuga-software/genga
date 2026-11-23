type Bucket = { tokens: number; at: number };

/**
 * One token bucket per key, in memory. A bucket holds `capacity` tokens and gets
 * `capacity` new tokens per minute. The map keeps the `maxKeys` most recent keys.
 */
export class TokenBuckets {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Takes one token. Returns 0 when the request can go, else the seconds to wait. */
  take(key: string): number {
    const now = this.now();
    const ratePerMs = this.capacity / 60_000;
    const previous = this.buckets.get(key);
    const tokens = previous
      ? Math.min(this.capacity, previous.tokens + (now - previous.at) * ratePerMs)
      : this.capacity;
    this.buckets.delete(key);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return Math.max(1, Math.ceil((1 - tokens) / ratePerMs / 1000));
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
    return 0;
  }
}
