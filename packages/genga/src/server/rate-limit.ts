type Bucket = { count: number; resetAt: number };

/**
 * Fixed window counters per key, in memory. The map keeps at most `maxKeys` keys:
 * a hit moves its key to the end, and the first key (the least recent) goes out.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  count(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
  }

  isLimited(key: string): boolean {
    return this.count(key) >= this.limit;
  }

  hit(key: string) {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    this.buckets.delete(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      bucket.count += 1;
      this.buckets.set(key, bucket);
    }
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
  }

  /** Takes back one hit, for an attempt that turned out valid. */
  release(key: string) {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.count > 0) bucket.count -= 1;
  }

  reset(key: string) {
    this.buckets.delete(key);
  }

  clear() {
    this.buckets.clear();
  }
}
