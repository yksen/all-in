export interface StakeOption {
  amt: number;
  label: string;
}

/**
 * The replay/rematch stake choices — base (1×), half, and double — clamped to [min, max]
 * and DE-DUPLICATED by amount. At the minimum bet `half` collapses onto the base, and at
 * the maximum `double` does; emitting two buttons with the same amount would collide on
 * customId, and Discord rejects any message whose action row has duplicate customIds (so
 * the whole edit silently fails). `baseLabel` is the verb for the 1× button, e.g. "Replay".
 */
export function replayStakes(base: number, min: number, max: number, baseLabel: string): StakeOption[] {
  const half = Math.max(min, Math.floor(base / 2));
  const dbl = Math.min(max, base * 2);
  const raw: StakeOption[] = [
    { amt: base, label: `${baseLabel} (${base})` },
    { amt: half, label: `½ (${half})` },
    { amt: dbl, label: `2× (${dbl})` },
  ];
  const seen = new Set<number>();
  return raw.filter((o) => {
    if (seen.has(o.amt)) return false;
    seen.add(o.amt);
    return true;
  });
}
