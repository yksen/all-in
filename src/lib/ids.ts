/** Short, collision-resistant id for game sessions (fits in a 100-char customId). */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

/** Build a component customId: cid("bj", "hit", sessionId) -> "bj:hit:<id>". */
export function cid(prefix: string, ...parts: (string | number)[]): string {
  return [prefix, ...parts].join(":");
}

export function parseCid(customId: string): { prefix: string; parts: string[] } {
  const [prefix = "", ...parts] = customId.split(":");
  return { prefix, parts };
}
