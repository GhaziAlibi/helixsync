import { describe, expect, it } from "vitest";
import { selectPendingTabRestores, selectRecentHistoryVisits } from "./selectors";
import type { RemoteObjectRecord } from "./db";

function historyRecord(
  objectId: string,
  visitedAt: string,
  overrides: Partial<RemoteObjectRecord> = {},
): RemoteObjectRecord {
  return {
    objectId,
    objectType: "historyVisit",
    originDeviceId: "device-b",
    payload: { url: `https://example.com/${objectId}`, title: `Page ${objectId}`, visitedAt },
    deleted: false,
    updatedAt: visitedAt,
    ...overrides,
  };
}

describe("selectRecentHistoryVisits (README.md 'Synced history from other devices')", () => {
  it("sorts newest visit first", () => {
    const records = [
      historyRecord("a", "2026-01-01T00:00:00.000Z"),
      historyRecord("b", "2026-06-01T00:00:00.000Z"),
      historyRecord("c", "2026-03-01T00:00:00.000Z"),
    ];
    const result = selectRecentHistoryVisits(records);
    expect(result.map((v) => v.url)).toEqual([
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/a",
    ]);
  });

  it("respects the limit", () => {
    const records = [
      historyRecord("a", "2026-01-01T00:00:00.000Z"),
      historyRecord("b", "2026-01-02T00:00:00.000Z"),
      historyRecord("c", "2026-01-03T00:00:00.000Z"),
    ];
    expect(selectRecentHistoryVisits(records, 2)).toHaveLength(2);
  });

  it("excludes other object types and tombstoned records", () => {
    const records = [
      historyRecord("a", "2026-01-01T00:00:00.000Z"),
      historyRecord("deleted", "2026-01-02T00:00:00.000Z", { deleted: true }),
      {
        objectId: "tab-1",
        objectType: "tab" as const,
        originDeviceId: "device-b",
        payload: { url: "https://example.com/tab" },
        deleted: false,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    const result = selectRecentHistoryVisits(records);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/a");
  });
});

function tabRecord(objectId: string, overrides: Partial<RemoteObjectRecord> = {}): RemoteObjectRecord {
  return {
    objectId,
    objectType: "tab",
    originDeviceId: "device-b",
    payload: { url: `https://example.com/${objectId}`, title: `Tab ${objectId}`, pinned: false, index: 0, windowObjectId: "w1", active: false },
    deleted: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectPendingTabRestores (README.md 'ask' restore policy)", () => {
  it("returns tabs with no local mapping yet", () => {
    const records = [tabRecord("a"), tabRecord("b")];
    const result = selectPendingTabRestores(records, new Set());
    expect(result.map((r) => r.objectId)).toEqual(["a", "b"]);
  });

  it("excludes tabs that already have a local Chromium mapping", () => {
    const records = [tabRecord("a"), tabRecord("b")];
    const result = selectPendingTabRestores(records, new Set(["a"]));
    expect(result.map((r) => r.objectId)).toEqual(["b"]);
  });

  it("excludes closed (tombstoned) and non-tab records", () => {
    const records = [
      tabRecord("a", { deleted: true }),
      tabRecord("b"),
      { ...tabRecord("c"), objectType: "window" as const },
    ];
    const result = selectPendingTabRestores(records, new Set());
    expect(result.map((r) => r.objectId)).toEqual(["b"]);
  });
});
