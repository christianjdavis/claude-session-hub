import type { KeyValueStore } from './reviewed-store';

const KEY = 'sessionHub.pins';

/** A repo or folder row the user promoted into the Focus view. */
export interface Pin {
  path: string;
  kind: 'repo' | 'folder';
}

/** Result of a mutation: whether anything changed, and the storage write to await if needed. */
export interface PinChange {
  changed: boolean;
  saved: Promise<void>;
}
const NONE: PinChange = { changed: false, saved: Promise.resolve() };

/** Ordered, persisted list of pins; order is the order shown in Focus. Mutations apply in memory at once. */
export class PinStore {
  private pins: Pin[];

  constructor(private readonly storage: KeyValueStore) {
    const raw = storage.get<Pin[]>(KEY) ?? [];
    this.pins = raw.filter(p => p && typeof p.path === 'string' && (p.kind === 'repo' || p.kind === 'folder'));
  }

  list(): Pin[] {
    return [...this.pins];
  }

  has(path: string): boolean {
    return this.pins.some(p => p.path === path);
  }

  paths(): ReadonlySet<string> {
    return new Set(this.pins.map(p => p.path));
  }

  /** Appends; `changed` is false when the path is already pinned. */
  add(pin: Pin): PinChange {
    if (this.has(pin.path)) return NONE;
    this.pins.push({ path: pin.path, kind: pin.kind });
    return this.flush();
  }

  remove(path: string): PinChange {
    const i = this.indexOf(path);
    if (i < 0) return NONE;
    this.pins.splice(i, 1);
    return this.flush();
  }

  /** Swap with the previous (-1) or next (+1) pin; no-op at the edges. */
  move(path: string, delta: -1 | 1): PinChange {
    const i = this.indexOf(path);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.pins.length) return NONE;
    const a = this.pins[i] as Pin;
    this.pins[i] = this.pins[j] as Pin;
    this.pins[j] = a;
    return this.flush();
  }

  /** Drag-reorder: place `path` immediately before `before`, or at the end when `before` is null. */
  moveBefore(path: string, before: string | null): PinChange {
    const i = this.indexOf(path);
    if (i < 0 || path === before) return NONE;
    const [moved] = this.pins.splice(i, 1) as [Pin];
    const j = before === null ? this.pins.length : this.indexOf(before);
    if (j < 0) {
      this.pins.splice(i, 0, moved);
      return NONE;
    }
    this.pins.splice(j, 0, moved);
    return this.flush();
  }

  private indexOf(path: string): number {
    return this.pins.findIndex(p => p.path === path);
  }

  private flush(): PinChange {
    return { changed: true, saved: Promise.resolve(this.storage.update(KEY, [...this.pins])) };
  }
}
