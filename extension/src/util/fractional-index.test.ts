import { describe, expect, it } from "vitest";
import { keyBetween } from "./fractional-index";

describe("keyBetween", () => {
  it("returns a start key when both bounds are open", () => {
    const k = keyBetween(null, null);
    expect(typeof k).toBe("string");
    expect(k.length).toBeGreaterThan(0);
  });

  it("returns a key after lo when hi is open", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(b > a).toBe(true);
  });

  it("returns a key before hi when lo is open", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(null, a);
    expect(b < a).toBe(true);
  });

  it("returns a key strictly between two adjacent single-char keys", () => {
    const a = "a";
    const b = "b";
    const mid = keyBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  it("throws when lo >= hi", () => {
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a", "a")).toThrow();
  });

  it("supports many sequential appends at the end without collisions", () => {
    let prev: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(prev, null);
      if (prev !== null) expect(k > prev).toBe(true);
      keys.push(k);
      prev = k;
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("supports many sequential prepends at the start without collisions", () => {
    let next: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(null, next);
      if (next !== null) expect(k < next).toBe(true);
      keys.push(k);
      next = k;
    }
    const sorted = [...keys].sort().reverse();
    expect(keys).toEqual(sorted);
  });

  it("supports repeated bisection between two fixed bounds without collision", () => {
    let lo = "a";
    let hi = "b";
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo).toBe(true);
      expect(k < hi).toBe(true);
      keys.push(k);
      hi = k; // keep bisecting the lower half, the hardest case (shrinking gap)
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("supports random interleaved insertions maintaining strict order", () => {
    let sequence: string[] = [keyBetween(null, null)];
    for (let i = 0; i < 500; i++) {
      const idx = Math.floor(Math.random() * (sequence.length + 1));
      const lo = idx === 0 ? null : sequence[idx - 1];
      const hi = idx === sequence.length ? null : sequence[idx];
      const k = keyBetween(lo, hi);
      if (lo !== null) expect(k > lo).toBe(true);
      if (hi !== null) expect(k < hi).toBe(true);
      sequence = [...sequence.slice(0, idx), k, ...sequence.slice(idx)];
    }
    const sorted = [...sequence].sort();
    expect(sequence).toEqual(sorted);
    expect(new Set(sequence).size).toBe(sequence.length);
  });
});
