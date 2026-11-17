import { describe, expect, it } from "vitest";
import type { VaultData } from "./types";
import { packHistory, packVaultData, unpackHistory, unpackVaultData } from "./wire";

const history = [
  { url: "https://a.test/", title: "A", t: 1700000000123 },
  { url: "https://b.test/", title: "", t: 1699999999000 },
];

describe("wire format", () => {
  it("round-trips history through three columns", () => {
    const packed = packHistory(history);
    expect(packed.times).toBeInstanceOf(Float64Array);
    expect(packed.urls).toEqual(["https://a.test/", "https://b.test/"]);
    expect(unpackHistory(packed)).toEqual(history);
  });

  it("keeps millisecond times exactly", () => {
    expect(unpackHistory(packHistory([{ url: "u", title: "t", t: 8.64e15 }]))[0].t).toBe(8.64e15);
  });

  it("round-trips a whole vault and survives a structured clone", () => {
    const data: VaultData = {
      bookmarks: [{ id: "b", title: "T", url: "https://t.test/", parent: null, position: "a" }],
      folders: [],
      history,
      tabs: [],
      windows: [],
      tabGroups: [],
      unreadable: 1,
      incomplete: 2,
    };
    const wire = structuredClone(packVaultData(data));
    expect(unpackVaultData(wire)).toEqual(data);
  });

  it("handles an empty history", () => {
    expect(unpackHistory(packHistory([]))).toEqual([]);
  });
});
