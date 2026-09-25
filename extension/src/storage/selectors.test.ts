import { describe, expect, it } from "vitest";
import {
  isPendingTabRestore,
  selectFieldStateGcCandidates,
  selectPendingTabRestores,
  selectRecentHistoryVisits,
  selectStaleDeferredMaterializations,
} from "./selectors";
import type { FieldStateRecord, RemoteObjectRecord } from "./db";

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
    deleted: 0,
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
      historyRecord("deleted", "2026-01-02T00:00:00.000Z", { deleted: 1 }),
      {
        objectId: "tab-1",
        objectType: "tab" as const,
        originDeviceId: "device-b",
        payload: { url: "https://example.com/tab" },
        deleted: 0 as const,
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
    deleted: 0,
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
      tabRecord("a", { deleted: 1 }),
      tabRecord("b"),
      { ...tabRecord("c"), objectType: "window" as const },
    ];
    const result = selectPendingTabRestores(records, new Set());
    expect(result.map((r) => r.objectId)).toEqual(["b"]);
  });
});

describe("isPendingTabRestore (storage/db.ts's countPendingTabRestores)", () => {
  // Guards against `countPendingTabRestores` (which walks records one at a
  // time via a cursor instead of collecting them into an array like
  // `selectPendingTabRestores` does) drifting out of sync with the actual
  // "is this pending" semantics — the per-record predicate is exercised
  // directly here, and cross-checked against `selectPendingTabRestores`
  // below across a mixed batch, so a future edit to one can't silently
  // diverge from the other.
  it("matches selectPendingTabRestores's filtering, record by record", () => {
    const records = [
      tabRecord("a"), // pending
      tabRecord("b", { deleted: 1 }), // tombstoned
      tabRecord("c"), // materialized
      { ...tabRecord("d"), objectType: "window" as const }, // wrong type
      tabRecord("e", { payload: undefined }), // no payload
      tabRecord("f"), // pending
    ];
    const materializedObjectIds = new Set(["c"]);

    const viaPredicate = records.filter((r) => isPendingTabRestore(r, materializedObjectIds)).map((r) => r.objectId);
    const viaSelector = selectPendingTabRestores(records, materializedObjectIds).map((r) => r.objectId);

    expect(viaPredicate).toEqual(["a", "f"]);
    expect(viaPredicate).toEqual(viaSelector);
  });
});

function livenessRecord(
  objectId: string,
  value: "live" | "deleted",
  overrides: Partial<FieldStateRecord> = {},
): FieldStateRecord {
  return {
    key: `${objectId}:liveness`,
    objectId,
    field: "liveness",
    lamportTimestamp: 1,
    deviceId: "device-a",
    operationId: "op-1",
    operationType: value === "deleted" ? "delete" : "create",
    value,
    ...overrides,
  };
}

describe("selectFieldStateGcCandidates (storage/db.ts's gcFieldStates)", () => {
  const NOW = Date.parse("2026-09-15T00:00:00.000Z");
  const THIRTY_ONE_DAYS_AGO = NOW - 31 * 24 * 60 * 60 * 1000;
  const ONE_DAY_AGO = NOW - 24 * 60 * 60 * 1000;

  it("includes an object whose liveness is deleted well past the cutoff", () => {
    const records = [livenessRecord("obj-old", "deleted", { recordedAt: THIRTY_ONE_DAYS_AGO })];
    expect(selectFieldStateGcCandidates(records, NOW - 30 * 24 * 60 * 60 * 1000)).toEqual(["obj-old"]);
  });

  it("excludes an object whose liveness was deleted recently (still within the retention window)", () => {
    const records = [livenessRecord("obj-recent", "deleted", { recordedAt: ONE_DAY_AGO })];
    expect(selectFieldStateGcCandidates(records, NOW - 30 * 24 * 60 * 60 * 1000)).toEqual([]);
  });

  it("never includes a still-live object regardless of age", () => {
    const records = [livenessRecord("obj-live", "live", { recordedAt: THIRTY_ONE_DAYS_AGO })];
    expect(selectFieldStateGcCandidates(records, NOW - 30 * 24 * 60 * 60 * 1000)).toEqual([]);
  });

  it("excludes a deleted record with no recordedAt (pre-existing, unknown age) rather than guessing", () => {
    const records = [livenessRecord("obj-unknown-age", "deleted", { recordedAt: undefined })];
    expect(selectFieldStateGcCandidates(records, NOW)).toEqual([]);
  });

  it("ignores non-liveness fields even if old", () => {
    const records = [
      { ...livenessRecord("obj-title", "deleted", { recordedAt: THIRTY_ONE_DAYS_AGO }), field: "title", value: "Some Title" },
    ];
    expect(selectFieldStateGcCandidates(records, NOW - 30 * 24 * 60 * 60 * 1000)).toEqual([]);
  });

  it("de-duplicates when somehow given multiple eligible rows for the same object", () => {
    const records = [
      livenessRecord("obj-dup", "deleted", { recordedAt: THIRTY_ONE_DAYS_AGO }),
      livenessRecord("obj-dup", "deleted", { recordedAt: THIRTY_ONE_DAYS_AGO, operationId: "op-2" }),
    ];
    expect(selectFieldStateGcCandidates(records, NOW - 30 * 24 * 60 * 60 * 1000)).toEqual(["obj-dup"]);
  });
});

describe("selectStaleDeferredMaterializations (storage/db.ts's pruneDeferredMaterializations, perf fix P8)", () => {
  const NOW = Date.parse("2026-09-15T00:00:00.000Z");
  const CUTOFF = NOW - 30 * 24 * 60 * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("includes rows older than the retention window", () => {
    const records = [{ objectId: "old", createdAt: iso(CUTOFF - 1000) }];
    expect(selectStaleDeferredMaterializations(records, CUTOFF)).toEqual(["old"]);
  });

  it("excludes recent rows", () => {
    const records = [{ objectId: "fresh", createdAt: iso(NOW - 1000) }];
    expect(selectStaleDeferredMaterializations(records, CUTOFF)).toEqual([]);
  });

  it("excludes rows with an unparseable createdAt rather than purging on a guess", () => {
    const records = [{ objectId: "weird", createdAt: "not-a-date" }];
    expect(selectStaleDeferredMaterializations(records, CUTOFF)).toEqual([]);
  });

  it("de-duplicates repeat rows for the same object", () => {
    const records = [
      { objectId: "dup", createdAt: iso(CUTOFF - 2000) },
      { objectId: "dup", createdAt: iso(CUTOFF - 1000) },
    ];
    expect(selectStaleDeferredMaterializations(records, CUTOFF)).toEqual(["dup"]);
  });
});
