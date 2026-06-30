import { expect, test } from "bun:test";
import { comeOutOutcome, fieldReturn, lineReturn, pointOutcome, rollPair } from "./craps.ts";

test("comeOutOutcome: naturals, craps, bar-12, and points", () => {
  expect(comeOutOutcome(7)).toEqual({ type: "pass" });
  expect(comeOutOutcome(11)).toEqual({ type: "pass" });
  expect(comeOutOutcome(2)).toEqual({ type: "dontpass" });
  expect(comeOutOutcome(3)).toEqual({ type: "dontpass" });
  expect(comeOutOutcome(12)).toEqual({ type: "push" });
  for (const p of [4, 5, 6, 8, 9, 10]) expect(comeOutOutcome(p)).toEqual({ type: "point", point: p });
});

test("pointOutcome: hit the point wins Pass, seven-out wins Don't, else keep rolling", () => {
  expect(pointOutcome(6, 6)).toEqual({ type: "pass" });
  expect(pointOutcome(7, 6)).toEqual({ type: "dontpass" });
  expect(pointOutcome(5, 6)).toBeNull();
});

test("lineReturn: even money, with bar-12 pushing Don't Pass", () => {
  expect(lineReturn("pass", 100, { type: "pass" })).toBe(200);
  expect(lineReturn("pass", 100, { type: "dontpass" })).toBe(0);
  expect(lineReturn("dontpass", 100, { type: "dontpass" })).toBe(200);
  expect(lineReturn("dontpass", 100, { type: "pass" })).toBe(0);
  // bar 12: Pass loses, Don't Pass gets its stake back (push).
  expect(lineReturn("pass", 100, { type: "push" })).toBe(0);
  expect(lineReturn("dontpass", 100, { type: "push" })).toBe(100);
});

test("fieldReturn: 2 pays 2:1, 12 pays 3:1, 3/4/9/10/11 pay 1:1, 5-8 lose", () => {
  expect(fieldReturn(100, 2)).toBe(300);
  expect(fieldReturn(100, 12)).toBe(400);
  for (const s of [3, 4, 9, 10, 11]) expect(fieldReturn(100, s)).toBe(200);
  for (const s of [5, 6, 7, 8]) expect(fieldReturn(100, s)).toBe(0);
});

test("rollPair: two dice each in 1..6", () => {
  for (let i = 0; i < 200; i++) {
    const [a, b] = rollPair();
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(6);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(6);
  }
});
