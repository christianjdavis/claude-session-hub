/** Minimal subset of vscode.Memento so the store is testable without VS Code. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'sessionHub.reviewed';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Persisted set of review keys (`${sessionId}:${turnTs}`) the user has already looked at. */
export class ReviewedStore {
  private map: Record<string, number>;

  constructor(private readonly storage: KeyValueStore, private readonly now: () => number = Date.now) {
    this.map = { ...(storage.get<Record<string, number>>(KEY) ?? {}) };
    this.prune();
  }

  has(key: string): boolean {
    return key in this.map;
  }

  keys(): string[] {
    return Object.keys(this.map);
  }

  async add(...keys: string[]): Promise<void> {
    let changed = false;
    for (const k of keys) {
      if (!(k in this.map)) {
        this.map[k] = this.now();
        changed = true;
      }
    }
    if (changed) await this.flush();
  }

  async remove(key: string): Promise<void> {
    if (key in this.map) {
      delete this.map[key];
      await this.flush();
    }
  }

  private prune(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [k, t] of Object.entries(this.map)) if (t < cutoff) delete this.map[k];
  }

  private flush(): Thenable<void> {
    this.prune();
    return this.storage.update(KEY, this.map);
  }
}

export class MemoryStore implements KeyValueStore {
  private readonly m = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.m.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.m.set(key, value);
    return Promise.resolve();
  }
}
