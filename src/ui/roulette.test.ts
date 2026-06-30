import { expect, test } from "bun:test";
import { renderGrid, renderReel } from "./roulette.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("grid: pocket colour survives as a shape with ANSI stripped (mobile-safe)", () => {
  const g = strip(renderGrid(17));
  expect(g).toContain("●"); // red pockets
  expect(g).toContain("○"); // black pockets
  expect(g).toContain("0◆"); // zero is green
});

test("reel: shapes present, focused pocket bracketed, pointer aligned, cells 5-wide", () => {
  const out = strip(renderReel([3, 26, 0, 32, 15, 19, 4], 3));
  expect(out).toContain("[32●]"); // 32 is red and focused
  const lines = out.split("\n"); // ["```ansi", pointer, cells, "```"]
  expect(lines[1]!.indexOf("▼")).toBe(3 * 5 + 2); // pointer sits over the focused cell
  expect(lines[2]!.length).toBe(7 * 5); // 7 cells × 5 visible chars — alignment holds
});
