export interface SessionStoreOptions {
  maxSessions: number;
  idleTtlMs: number;
  /** Injectable for tests; defaults to wall-clock. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  lastSeen: number;
}

/**
 * Bounded, idle-expiring map of live MCP sessions.
 *
 * Both limits matter. The TTL exists because `onsessionclosed` fires only on an explicit
 * DELETE and clients frequently vanish without sending one. The cap exists because in `none`
 * mode anything that can reach the port can `initialize` indefinitely, which is a
 * denial-of-service surface rather than merely a leak.
 */
export class SessionStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? ((): number => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns the session and marks it as recently used. */
  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    entry.lastSeen = this.now();
    return entry.value;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Returns false when the store is full, so the caller can refuse the request. */
  set(id: string, value: T): boolean {
    if (!this.entries.has(id) && this.entries.size >= this.options.maxSessions) return false;
    this.entries.set(id, { value, lastSeen: this.now() });
    return true;
  }

  delete(id: string): T | undefined {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return entry?.value;
  }

  /** Removes everything idle for longer than the TTL and returns what was removed. */
  sweep(): { id: string; value: T }[] {
    const cutoff = this.now() - this.options.idleTtlMs;
    const expired: { id: string; value: T }[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.lastSeen <= cutoff) {
        expired.push({ id, value: entry.value });
        this.entries.delete(id);
      }
    }

    return expired;
  }

  drain(): { id: string; value: T }[] {
    const all = [...this.entries].map(([id, entry]) => ({ id, value: entry.value }));
    this.entries.clear();
    return all;
  }
}
