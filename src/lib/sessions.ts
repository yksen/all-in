export interface SessionBase {
  id: string;
  userId: string;
}

/**
 * In-memory store for interactive game sessions, with an idle TTL. Each game keeps
 * its own store; the authoritative money state lives in the DB, so losing a session
 * on restart only abandons an in-progress hand (chips already escrowed are handled
 * per game). `touch()` resets the timer on every player action.
 */
export class SessionStore<T extends SessionBase> {
  private map = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly onExpire?: (value: T) => void,
  ) {}

  create(value: T): T {
    this.delete(value.id);
    this.arm(value);
    return value;
  }

  get(id: string): T | undefined {
    return this.map.get(id)?.value;
  }

  touch(id: string): void {
    const entry = this.map.get(id);
    if (entry) this.arm(entry.value);
  }

  delete(id: string): void {
    const entry = this.map.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.map.delete(id);
    }
  }

  private arm(value: T): void {
    const existing = this.map.get(value.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.map.delete(value.id);
      this.onExpire?.(value);
    }, this.ttlMs);
    // Don't keep the process alive just for a pending session timeout.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.map.set(value.id, { value, timer });
  }
}
