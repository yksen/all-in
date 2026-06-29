/**
 * A per-key async mutex. Used to serialize all money-affecting work for a single
 * user so that e.g. double-clicking a button, or starting two games at once, can't
 * race and double-spend. DB transactions are atomic on their own; this guards the
 * *multi-step* interaction flows (bet -> play -> settle) that span several awaits.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const chained = prev.then(() => current);
    this.tails.set(key, chained);

    await prev; // prev never rejects (it only ever resolves), so this is safe
    try {
      return await fn();
    } finally {
      release();
      // If nobody queued behind us, drop the key so the map can't grow unbounded.
      if (this.tails.get(key) === chained) this.tails.delete(key);
    }
  }

  /** True if there is in-flight work for this key (best-effort, for UX guards). */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
