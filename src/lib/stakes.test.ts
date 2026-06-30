import { expect, test } from "bun:test";
import { replayStakes } from "./stakes.ts";

const allUnique = (o: { amt: number }[]) => new Set(o.map((x) => x.amt)).size === o.length;

test("mid-range bet: three distinct stakes", () => {
  const s = replayStakes(100, 10, 5000, "Replay");
  expect(s.map((o) => o.amt)).toEqual([100, 50, 200]);
  expect(allUnique(s)).toBe(true);
});

test("at the minimum: half collapses onto base and is dropped (unique customIds)", () => {
  const s = replayStakes(10, 10, 5000, "Replay");
  expect(s.map((o) => o.amt)).toEqual([10, 20]);
  expect(allUnique(s)).toBe(true);
});

test("at the maximum: double collapses onto base and is dropped (unique customIds)", () => {
  const s = replayStakes(5000, 10, 5000, "Replay");
  expect(s.map((o) => o.amt)).toEqual([5000, 2500]);
  expect(allUnique(s)).toBe(true);
});

test("labels carry the factor and the (clamped) amount", () => {
  const s = replayStakes(100, 10, 5000, "Rematch");
  expect(s.map((o) => o.label)).toEqual(["Rematch (100)", "½ (50)", "2× (200)"]);
});
