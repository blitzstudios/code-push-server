export interface MicrocacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class Microcache<T> {
  private readonly ttlMs: number;
  private readonly store: Map<string, MicrocacheEntry<T>>;

  constructor(ttlMs: number) {
    this.ttlMs = Math.max(0, ttlMs || 0);
    this.store = new Map<string, MicrocacheEntry<T>>();
  }

  public get(key: string): T | null {
    if (this.ttlMs <= 0) return null;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
    }

  public set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    this.store.set(key, { expiresAt: Date.now() + this.ttlMs, value });
  }

  public delete(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }
}
