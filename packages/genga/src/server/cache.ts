type Entry = { value: unknown; at: number };

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
// Unknown slugs are cached as null in their own map, so random URLs cannot push out the real entries.
const MAX_NEGATIVE_ENTRIES = 500;

/**
 * In-process cache of published content. Publish, unpublish and delete clear the
 * entries of their collection. If the database fails, a stale entry answers.
 * This works because Genga runs as one replica.
 */
export class PublishedCache {
  private entries = new Map<string, Entry>();
  private negative = new Map<string, Entry>();
  private generations = new Map<string, number>();
  private epoch = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async get<T>(collection: string, key: string, load: () => Promise<T>): Promise<T> {
    const id = `${collection}\u0000${key}`;
    const entry = this.entries.get(id) ?? this.negative.get(id);
    if (entry && this.now() - entry.at < TTL_MS) return entry.value as T;
    // An invalidation during the load means the loaded value can be older than the database.
    const generation = this.generation(collection);
    try {
      const value = await load();
      if (this.generation(collection) === generation) this.store(id, value);
      return value;
    } catch (error) {
      if (entry && this.generation(collection) === generation) return entry.value as T;
      throw error;
    }
  }

  invalidate(collection: string) {
    this.generations.set(collection, (this.generations.get(collection) ?? 0) + 1);
    const prefix = `${collection}\u0000`;
    for (const map of [this.entries, this.negative]) {
      for (const id of map.keys()) {
        if (id.startsWith(prefix)) map.delete(id);
      }
    }
  }

  clear() {
    this.epoch += 1;
    this.entries.clear();
    this.negative.clear();
  }

  private generation(collection: string): string {
    return `${this.epoch}.${this.generations.get(collection) ?? 0}`;
  }

  private store(id: string, value: unknown) {
    const map = value === null ? this.negative : this.entries;
    const max = value === null ? MAX_NEGATIVE_ENTRIES : MAX_ENTRIES;
    this.entries.delete(id);
    this.negative.delete(id);
    if (map.size >= max) map.delete(map.keys().next().value as string);
    map.set(id, { value, at: this.now() });
  }
}
