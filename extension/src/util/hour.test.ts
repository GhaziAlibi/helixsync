import { describe, expect, it } from "vitest";
import { hourKey } from "./hour";

describe("hourKey", () => {
  it("aligns down to the containing UTC hour", () => {
    expect(hourKey(Date.UTC(2026, 8, 23, 9, 47, 12, 345))).toBe("2026-09-23T09:00:00.000Z");
  });

  it("leaves an already-aligned hour unchanged", () => {
    expect(hourKey(Date.UTC(2026, 8, 23, 9, 0, 0, 0))).toBe("2026-09-23T09:00:00.000Z");
  });

  it("does not round up near the next hour boundary", () => {
    expect(hourKey(Date.UTC(2026, 8, 23, 9, 59, 59, 999))).toBe("2026-09-23T09:00:00.000Z");
  });

  it("handles the UTC day/hour rollover", () => {
    expect(hourKey(Date.UTC(2026, 8, 23, 23, 30, 0, 0))).toBe("2026-09-23T23:00:00.000Z");
    expect(hourKey(Date.UTC(2026, 8, 24, 0, 15, 0, 0))).toBe("2026-09-24T00:00:00.000Z");
  });

  it("two timestamps in the same hour produce the same key", () => {
    const a = hourKey(Date.UTC(2026, 8, 23, 9, 1, 0, 0));
    const b = hourKey(Date.UTC(2026, 8, 23, 9, 58, 0, 0));
    expect(a).toBe(b);
  });
});
