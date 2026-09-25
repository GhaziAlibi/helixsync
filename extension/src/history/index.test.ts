import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOperationAad,
  encryptBytesWithSdek,
  encryptWithSdek,
  getSdek,
  UnsupportedEnvelopeVersionError,
} from "../crypto";

// Fixture objectId for tests that construct a bulk container by hand
// (no real BulkChunkOperation, so no real deterministic objectId). Encrypt
// and decrypt sides must agree on it, since it's part of the AEAD's AAD.
const TEST_BULK_OBJECT_ID = "test-bulk-object";
const testBulkAad = buildOperationAad("historyVisit", TEST_BULK_OBJECT_ID, "bulkImport");
import type { DeviceRecord } from "../storage/db";
import type { BulkHistoryContainer, BulkVisit, LocalOperation, OperationOut } from "../sync/types";
import { hourKey } from "../util/hour";

// Chunked history import (historyVisit / bulkImport, docs/protocol.md
// §8.3): backfillExisting sends old history as one or more bulkImport ops —
// one per BULK_CHUNK_TARGET_BYTES-sized chunk, uploaded as it's ready rather
// than accumulating the whole import in memory (see bulk.ts's doc comments
// for why: an unbounded single op risked OOMing the service worker on a
// real profile). These tests reuse the search/getVisits fakes from the
// legacy backfill suite (same Chromium behavior: endTime excludes items not
// strictly less than it, maxResults truncates) to exercise collect/segment/
// expand, chunk splitting, peer truncation, idempotent re-apply, disconnect
// abort, and deterministic IDs.

let device: DeviceRecord | undefined;
let retention: string = "unlimited";
let syncHistory: boolean | undefined = undefined;
const uploadOperationsMock = vi.fn<
  (ops: LocalOperation[], timeoutMs?: number) => Promise<{
    accepted: string[];
    duplicate: string[];
    rejected: Array<{ operationId: string; reason: string }>;
    serverCursor: number;
  }>
>();
let seqCounter = 0;

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ historyRetention: retention, syncHistory })),
  uploadOperations: (ops: LocalOperation[], timeoutMs?: number) => uploadOperationsMock(ops, timeoutMs),
}));

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => device),
  putDevice: vi.fn(async (record: DeviceRecord) => {
    device = record;
  }),
  reserveSequenceBatch: vi.fn(async (count: number) => {
    const start = seqCounter;
    seqCounter += count;
    return { startDeviceSequence: start, startLamport: start };
  }),
}));

type BatchApplier = (items: Array<{ op: OperationOut; payload: unknown }>) => Promise<void>;
const batchAppliers = new Map<string, BatchApplier>();
const singleAppliers = new Map<string, (op: OperationOut, payload: unknown) => Promise<void>>();

vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: vi.fn(async () => []),
  registerApplier: vi.fn((type: string, fn: unknown) => {
    singleAppliers.set(type, fn as (op: OperationOut, payload: unknown) => Promise<void>);
  }),
  registerBatchApplier: vi.fn((type: string, fn: unknown) => {
    batchAppliers.set(type, fn as BatchApplier);
  }),
  scheduleLocalSync: vi.fn(),
  // bulk.ts drains the local queue before claiming each chunk's sequence
  // number (see flushChunk's doc comment) — `false` means "nothing to
  // drain", the steady state for these tests since nothing else in this
  // suite enqueues local operations.
  uploadPending: vi.fn(async () => false),
}));

const { backfillExisting } = await import("./index");
const {
  collectHistoryBulk,
  deterministicBulkIds,
  forEachBulkVisit,
  isBulkContainer,
  BULK_SEGMENT_VISITS,
  BULK_CHUNK_TARGET_VISITS,
  setBulkChunkUploadDelayMsForTesting,
  setBulkSegmentVisitsForTesting,
  setBulkChunkTargetVisitsForTesting,
  setBulkSearchPageSizeForTesting,
  resetDeflateSupportForTesting,
} = await import("./bulk");
const { setCpuPaceTargetForTesting } = await import("../util/pace");
// Real between-chunk throttle (see bulk.ts) has no place burning real
// wall-clock time in a unit test.
setBulkChunkUploadDelayMsForTesting(0);
// Same for the per-page/per-segment CPU pacer (see util/pace.ts).
setCpuPaceTargetForTesting(1);

interface FakeHistoryItem {
  url: string;
  lastVisitTime: number;
  visitTimes: number[];
}

// Practically-unbounded end time for tests that don't care about fix A's
// window's upper edge — comfortably beyond any real Date.now() at test-run
// time and any synthetic small timestamp fixtures use.
const FAR_FUTURE_END_MS = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;

/** Every visit of a bulk container, newest first: what a peer's replay reads. */
async function expandBulk(container: BulkHistoryContainer, objectId: string): Promise<BulkVisit[]> {
  const visits: Array<BulkVisit & { t: number }> = [];
  await forEachBulkVisit(
    container,
    device!.accountKey,
    (url, timeMs, title) => visits.push({ url, title, visitedAt: new Date(timeMs).toISOString(), t: timeMs }),
    async () => false,
    objectId,
  );
  visits.sort((a, b) => b.t - a.t);
  return visits.map(({ t: _t, ...visit }) => visit);
}

function historyApi(): { addUrl: ReturnType<typeof vi.fn>; getVisits: ReturnType<typeof vi.fn> } {
  return (
    globalThis as unknown as { chrome: { history: { addUrl: ReturnType<typeof vi.fn>; getVisits: ReturnType<typeof vi.fn> } } }
  ).chrome.history;
}

/** A peer browser with no history of its own: every URL is new to it. */
function emptyPeerHistory(): void {
  historyApi().getVisits.mockImplementation(async () => []);
}

function addedUrls(): string[] {
  return historyApi().addUrl.mock.calls.map((call: unknown[]) => (call[0] as { url: string }).url);
}

function baseDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "device-1",
    userId: "user-1",
    email: "user@example.test",
    accessToken: "token",
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: "refresh",
    accountKey: "a".repeat(44),
    accountKeyVersion: 1,
    ...overrides,
  };
}

/** Real Chromium `chrome.history.search` semantics (fix.md §2, fix B):
 * a URL is returned once, at its *newest visit inside* `[startTime,
 * endTime)` (not its overall last visit), ordered by that in-window match
 * time descending, truncated to `maxResults`. `lastVisitTime` in the result
 * is the URL's newest visit *overall* — which can be outside the query
 * window entirely — never the matching visit; the paging-cursor fix (bulk.ts
 * fix B) depends on callers never treating it as such. The `lastVisitTime`
 * field on `FakeHistoryItem` is accepted for fixtures with no visits at all
 * (there are none in this suite) but is otherwise derived from `visitTimes`,
 * so fixtures can't accidentally describe an inconsistent item. */
function installFakeChromeHistory(items: FakeHistoryItem[]): void {
  // Map lookup, not items.find: some fixtures (e.g. the multi-chunk v2 test
  // below) use tens of thousands of distinct URLs, where an O(n) find per
  // getVisits call would make the fixture itself the bottleneck.
  const byUrl = new Map(items.map((i) => [i.url, i]));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    history: {
      search: vi.fn(async (query: { startTime?: number; endTime?: number; maxResults?: number }) => {
        const start = query.startTime ?? 0;
        const end = query.endTime;
        const rows: Array<{ url: string; matchTime: number; overallLastVisitTime: number }> = [];
        for (const item of items) {
          const inWindow = item.visitTimes.filter((t) => t >= start && (end === undefined || t < end));
          if (inWindow.length === 0) continue;
          rows.push({
            url: item.url,
            matchTime: Math.max(...inWindow),
            overallLastVisitTime: item.visitTimes.length > 0 ? Math.max(...item.visitTimes) : item.lastVisitTime,
          });
        }
        rows.sort((a, b) => b.matchTime - a.matchTime);
        const page = query.maxResults === undefined ? rows : rows.slice(0, query.maxResults);
        return page.map((r) => ({
          id: r.url,
          url: r.url,
          title: `title:${r.url}`,
          lastVisitTime: r.overallLastVisitTime,
        }));
      }),
      getVisits: vi.fn(async ({ url }: { url: string }) => {
        const item = byUrl.get(url);
        return (item?.visitTimes ?? []).map((visitTime) => ({
          id: url,
          visitId: String(visitTime),
          referringVisitId: "0",
          visitTime,
          transition: "link",
        }));
      }),
      addUrl: vi.fn(async () => {}),
    },
  };
}

function lastUploadOp(): LocalOperation {
  expect(uploadOperationsMock).toHaveBeenCalledTimes(1);
  const ops = uploadOperationsMock.mock.calls[0][0] as LocalOperation[];
  expect(ops).toHaveLength(1);
  return ops[0];
}

/** Test fixtures are always tiny (well under BULK_CHUNK_TARGET_BYTES), so
 * collectHistoryBulk always produces exactly one chunk — this captures it
 * via the streaming callback instead of every test having to. */
async function collectSingleChunk(cutoffMs: number, endMs: number = FAR_FUTURE_END_MS): Promise<LocalOperation | null> {
  const ops: LocalOperation[] = [];
  const result = await collectHistoryBulk(cutoffMs, endMs, async (op) => {
    ops.push(op);
  });
  expect(ops.length).toBeLessThanOrEqual(1);
  expect(result.chunkCount).toBe(ops.length);
  return ops[0] ?? null;
}

beforeEach(() => {
  device = baseDevice();
  retention = "unlimited";
  syncHistory = undefined;
  seqCounter = 0;
  uploadOperationsMock.mockReset();
  uploadOperationsMock.mockImplementation(async (ops) => ({
    accepted: ops.map((o) => o.operationId),
    duplicate: [],
    rejected: [],
    serverCursor: 1,
  }));
});

describe("bulk backfill: chunked import", () => {
  it("uploads all visits as one bulkImport op with deterministic IDs", async () => {
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000, 2900] },
      { url: "https://b.test", lastVisitTime: 2000, visitTimes: [2000] },
    ]);

    await backfillExisting();

    const op = lastUploadOp();
    expect(op.objectType).toBe("historyVisit");
    expect(op.operationType).toBe("bulkImport");
    expect(op.visitCount).toBe(3);
    const payload = op.payload as { v: number; bulkVersion: number; visitCount: number; segments: unknown[] };
    expect(payload.v).toBe(1);
    expect(payload.bulkVersion).toBe(2); // grouped container shape, spec §C
    expect(payload.visitCount).toBe(3);
    expect(payload.segments.length).toBeGreaterThanOrEqual(1);
    // Deterministic IDs: same scope + chunk index re-mints the same IDs.
    const ids = await deterministicBulkIds("device-1", device!.historyBulkCutoffMs ?? 0, 0);
    expect(op.operationId).toBe(ids.operationId);
    expect(op.objectId).toBe(ids.objectId);
  });

  it("Change 3: chunk visitHours buckets the visits by hour and sums to visitCount", async () => {
    const hourA = Date.UTC(2026, 8, 23, 9, 0, 0, 0);
    const hourB = Date.UTC(2026, 8, 23, 10, 0, 0, 0);
    installFakeChromeHistory([
      // Two visits in hour A (9:00 and 9:47), one in hour B (10:15).
      { url: "https://a.test", lastVisitTime: hourA + 47 * 60_000, visitTimes: [hourA, hourA + 47 * 60_000] },
      { url: "https://b.test", lastVisitTime: hourB + 15 * 60_000, visitTimes: [hourB + 15 * 60_000] },
    ]);

    await backfillExisting();

    const op = lastUploadOp();
    expect(op.visitCount).toBe(3);
    expect(op.visitHours).toEqual({
      [hourKey(hourA)]: 2,
      [hourKey(hourB)]: 1,
    });
    const sum = Object.values(op.visitHours ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBe(op.visitCount);
  });

  it("collect/segment/expand round-trips visits", async () => {
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000, 2500] },
      { url: "https://b.test", lastVisitTime: 2000, visitTimes: [2000] },
    ]);

    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    const container = op!.payload as { visitCount: number; segments: unknown[] };
    expect(container.visitCount).toBe(3);

    const expanded = await expandBulk(container as never, op!.objectId);
    expect(expanded).toHaveLength(3);
    const urls = expanded.map((v) => v.url).sort();
    expect(urls).toEqual(["https://a.test", "https://a.test", "https://b.test"]);
  });

  it("splits a large import across multiple chunk ops instead of one unbounded op", async () => {
    // Under the v2 grouped + compressed container (spec §C/§D), a single
    // hot URL revisited many times no longer scales chunk *byte* size —
    // pushGroup stores its url/title at most once per segment it straddles,
    // not once per visit, and deflate-raw crushes the resulting highly
    // repetitive plaintext further still. What forces a flush regardless of
    // compressibility is BULK_CHUNK_TARGET_VISITS (spec §D's second, visit-
    // count-based ceiling — see its doc comment in bulk.ts): one hot URL
    // with enough visits to cross it twice proves chunks are still uploaded
    // incrementally rather than held until one final unbounded op.
    const now = Date.now();
    const visitCount = BULK_CHUNK_TARGET_VISITS + 1_000;
    installFakeChromeHistory([
      { url: "https://hot.test", lastVisitTime: now, visitTimes: Array.from({ length: visitCount }, (_, i) => now - i) },
    ]);

    await backfillExisting();

    expect(uploadOperationsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of uploadOperationsMock.mock.calls) {
      // Each chunk still uploads as its own single-op batch.
      expect(call[0]).toHaveLength(1);
    }
    const uploadedOps = uploadOperationsMock.mock.calls.map((call) => (call[0] as LocalOperation[])[0]);
    const totalVisits = uploadedOps.reduce((sum, op) => sum + (op.visitCount ?? 0), 0);
    expect(totalVisits).toBe(visitCount);
    // Distinct chunks get distinct IDs — no collisions, no data clobbered.
    expect(new Set(uploadedOps.map((op) => op.objectId)).size).toBe(uploadedOps.length);
    expect(new Set(uploadedOps.map((op) => op.operationId)).size).toBe(uploadedOps.length);
  });

  it("logs a payload byte count close to the real payload size without re-serializing it", async () => {
    // Multi-URL chunk (spec §B; sizable but single-chunk is enough — this
    // test only checks the logged number, not chunk-splitting, which
    // "splits a large import..." above already covers): the logged size
    // must come from the ciphertext lengths flushChunk already tracked, not
    // a fresh JSON.stringify(operation.payload) — verified indirectly here
    // by checking the logged number tracks the real size, and directly in
    // uploadHistoryBulk's source (no JSON.stringify(operation.payload) call
    // remains).
    const now = Date.now();
    const urlCount = 500;
    installFakeChromeHistory(
      Array.from({ length: urlCount }, (_, i) => ({
        url: `https://big.test/${i}/${"x".repeat(200)}`,
        lastVisitTime: now - i,
        visitTimes: [now - i, now - i - 1],
      })),
    );

    const logSpy = vi.spyOn(console, "log");
    await backfillExisting();

    const uploadedOps = uploadOperationsMock.mock.calls.map((call) => (call[0] as LocalOperation[])[0]);
    expect(uploadedOps.length).toBeGreaterThanOrEqual(1);

    const startLogs = logSpy.mock.calls.filter((call) => call[0] === "HelixSync: bulk history upload starting");
    expect(startLogs).toHaveLength(uploadedOps.length);

    for (let i = 0; i < uploadedOps.length; i++) {
      const loggedBytes = (startLogs[i][1] as { payloadBytes: number }).payloadBytes;
      const realBytes = JSON.stringify(uploadedOps[i].payload).length;
      // Ciphertext-length sum vs full-payload JSON length: close (same
      // segments dominate both), not identical (base64 ciphertext vs JSON
      // wrapper/field-name overhead differ) — a sane delta, not equality.
      expect(loggedBytes).toBeGreaterThan(0);
      expect(Math.abs(loggedBytes - realBytes) / realBytes).toBeLessThan(0.25);
    }
    logSpy.mockRestore();
  });

  it("skips upload when nothing is in scope", async () => {
    installFakeChromeHistory([]);
    await backfillExisting();
    expect(uploadOperationsMock).not.toHaveBeenCalled();
  });

  it("surfaces narrow-retention guidance on payload_too_large (stays single-op)", async () => {
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] }]);
    uploadOperationsMock.mockImplementationOnce(async (ops) => ({
      accepted: [],
      duplicate: [],
      rejected: [{ operationId: ops[0].operationId, reason: "payload_too_large" }],
      serverCursor: 0,
    }));
    await expect(backfillExisting()).rejects.toThrow(/narrow.*retention/i);
  });

  it("treats server duplicate as success (relogin same scope)", async () => {
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] }]);
    uploadOperationsMock.mockImplementationOnce(async (ops) => ({
      accepted: [],
      duplicate: ops.map((o) => o.operationId),
      rejected: [],
      serverCursor: 5,
    }));
    await backfillExisting();
    expect(uploadOperationsMock).toHaveBeenCalledTimes(1);
  });
});

describe("bulk container versions (spec §C: bulkVersion 2)", () => {
  it("v2 collect round-trips urls, titles, and timestamps through the bulk reader", async () => {
    const now = Date.now();
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: now, visitTimes: [now, now - 5000] },
      { url: "https://b.test", lastVisitTime: now - 1000, visitTimes: [now - 1000] },
    ]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    expect((op!.payload as { bulkVersion: number }).bulkVersion).toBe(2);

    const expanded = await expandBulk(op!.payload as never, op!.objectId);
    expect(expanded).toHaveLength(3);
    expect(expanded[0]).toEqual({
      url: "https://a.test",
      title: "title:https://a.test",
      visitedAt: new Date(now).toISOString(),
    });
    expect(expanded[1]).toEqual({
      url: "https://b.test",
      title: "title:https://b.test",
      visitedAt: new Date(now - 1000).toISOString(),
    });
    expect(expanded[2]).toEqual({
      url: "https://a.test",
      title: "title:https://a.test",
      visitedAt: new Date(now - 5000).toISOString(),
    });
  });

  it("a stored v1 container still expands correctly (regression, constructed explicitly)", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const visits: BulkVisit[] = [
      { url: "https://old.test/a", title: "Old A", visitedAt: new Date(1000).toISOString() },
      { url: "https://old.test/b", visitedAt: new Date(2000).toISOString() },
    ];
    const envelope = encryptWithSdek({ v: 1, visits }, sdek, device!.accountKeyVersion, testBulkAad);
    const container = { v: 1, bulkVersion: 1, visitCount: visits.length, segments: [envelope] };

    expect(isBulkContainer(container)).toBe(true);
    const expanded = await expandBulk(container as never, TEST_BULK_OBJECT_ID);
    expect(expanded).toHaveLength(2);
    // Newest first.
    expect(expanded[0].url).toBe("https://old.test/b");
    expect(expanded[0].title).toBeUndefined();
    expect(expanded[0].visitedAt).toBe(new Date(2000).toISOString());
    expect(expanded[1].url).toBe("https://old.test/a");
    expect(expanded[1].title).toBe("Old A");
    expect(expanded[1].visitedAt).toBe(new Date(1000).toISOString());
  });

  it("stamps every segment it produces with envelope version 2", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const envelope = encryptWithSdek({ v: 2, groups: [] }, sdek, device!.accountKeyVersion, testBulkAad);
    // The envelope's `v` is the encryption format; the plaintext and the
    // container each carry their own, unrelated layout versions.
    expect(envelope.v).toBe(2);
  });

  it("throws, instead of silently dropping the segment, when a segment's envelope version is unsupported", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const envelope = encryptWithSdek(
      { v: 1, visits: [{ url: "https://x.test", visitedAt: new Date(1000).toISOString() }] },
      sdek,
      device!.accountKeyVersion,
      testBulkAad,
    );
    for (const version of [1, 3]) {
      const container = { v: 1, bulkVersion: 1, visitCount: 1, segments: [{ ...envelope, v: version }] };
      await expect(
        expandBulk(container as never, TEST_BULK_OBJECT_ID),
      ).rejects.toBeInstanceOf(UnsupportedEnvelopeVersionError);
    }
  });

  it("[SEC-13] drops a segment with no ciphertext (server-supplied plaintext) instead of decoding it, leaving other segments intact", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const goodVisits: BulkVisit[] = [{ url: "https://real.test", visitedAt: new Date(2000).toISOString() }];
    const goodEnvelope = encryptWithSdek({ v: 1, visits: goodVisits }, sdek, device!.accountKeyVersion, testBulkAad);
    // Shaped like a legitimate v1 segment but with no `ciphertext` — what a
    // compromised server would send to smuggle unauthenticated history
    // entries into the synced list.
    const forgedSegment = { v: 1, visits: [{ url: "https://forged.test", visitedAt: new Date(1000).toISOString() }] };
    const container = {
      v: 1,
      bulkVersion: 1,
      visitCount: 2,
      segments: [goodEnvelope, forgedSegment],
    };

    const expanded = await expandBulk(container as never, TEST_BULK_OBJECT_ID);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].url).toBe("https://real.test");
  });

  it("applies a mixed batch of one v1 and one v2 bulk op — both land", async () => {
    // v1 container, constructed explicitly (device-2, so it's a "peer" op).
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const v1Visits: BulkVisit[] = [{ url: "https://legacy.test", visitedAt: new Date(1000).toISOString() }];
    const v1Envelope = encryptWithSdek(
      { v: 1, visits: v1Visits },
      sdek,
      device!.accountKeyVersion,
      buildOperationAad("historyVisit", "object-v1", "bulkImport"),
    );
    const v1Container = { v: 1, bulkVersion: 1, visitCount: v1Visits.length, segments: [v1Envelope] };
    const v1Op: OperationOut = {
      operationId: "op-v1",
      deviceId: "device-2",
      deviceSequence: 1,
      lamportTimestamp: 1,
      objectType: "historyVisit",
      objectId: "object-v1",
      operationType: "bulkImport",
      encryptionVersion: 1,
      payload: v1Container,
      serverCursor: 1,
      createdAt: new Date().toISOString(),
    };

    // v2 container, from the real producer.
    installFakeChromeHistory([{ url: "https://fresh.test", lastVisitTime: 5000, visitTimes: [5000] }]);
    const v2LocalOp = await collectSingleChunk(0);
    expect(v2LocalOp).not.toBeNull();
    const v2Op: OperationOut = {
      operationId: v2LocalOp!.operationId,
      deviceId: "device-2",
      deviceSequence: 2,
      lamportTimestamp: 2,
      objectType: "historyVisit",
      objectId: v2LocalOp!.objectId,
      operationType: "bulkImport",
      encryptionVersion: 1,
      payload: v2LocalOp!.payload,
      serverCursor: 2,
      createdAt: new Date().toISOString(),
    };

    emptyPeerHistory();
    const batch = batchAppliers.get("historyVisit");
    expect(batch).toBeDefined();
    await batch!([
      { op: v1Op, payload: v1Container },
      { op: v2Op, payload: v2LocalOp!.payload },
    ]);

    // Both wire versions are read; the older visit goes in first.
    expect(addedUrls()).toEqual(["https://legacy.test", "https://fresh.test"]);
  });

  it("isBulkContainer accepts bulkVersion 1 and 2, rejects unknown versions and malformed payloads", () => {
    expect(isBulkContainer({ v: 1, bulkVersion: 1, visitCount: 0, segments: [] })).toBe(true);
    expect(isBulkContainer({ v: 1, bulkVersion: 2, visitCount: 0, segments: [] })).toBe(true);
    expect(isBulkContainer({ v: 1, bulkVersion: 3, visitCount: 0, segments: [] })).toBe(false);
    expect(isBulkContainer({ v: 1, bulkVersion: 1, visitCount: "0", segments: [] })).toBe(false);
    expect(isBulkContainer({ v: 1, bulkVersion: 1, visitCount: 0, segments: "not-an-array" })).toBe(false);
    expect(isBulkContainer(null)).toBe(false);
    expect(isBulkContainer(undefined)).toBe(false);
    expect(isBulkContainer("a string")).toBe(false);
    expect(isBulkContainer({})).toBe(false);
  });

  it("splits a single hot URL's visits across segments and round-trips all of them, no loss or duplication", async () => {
    const now = Date.now();
    const count = BULK_SEGMENT_VISITS + 500;
    installFakeChromeHistory([
      { url: "https://hot.test", lastVisitTime: now, visitTimes: Array.from({ length: count }, (_, i) => now - i) },
    ]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    const container = op!.payload as { visitCount: number; segments: unknown[] };
    expect(container.visitCount).toBe(count);
    // Must have split: one segment alone would exceed BULK_SEGMENT_VISITS.
    expect(container.segments.length).toBeGreaterThanOrEqual(2);

    const expanded = await expandBulk(op!.payload as never, op!.objectId);
    expect(expanded).toHaveLength(count);
    expect(new Set(expanded.map((v) => v.visitedAt)).size).toBe(count); // no duplicates
    expect(expanded[0].visitedAt).toBe(new Date(now).toISOString());
    expect(expanded[count - 1].visitedAt).toBe(new Date(now - (count - 1)).toISOString());
  });

  it("reads every visit of a large container, with no cap", async () => {
    const now = Date.now();
    const count = 2300;
    installFakeChromeHistory([
      {
        url: "https://newest.test",
        lastVisitTime: now,
        visitTimes: Array.from({ length: count }, (_, i) => now - i * 1000),
      },
    ]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    const expanded = await expandBulk(op!.payload as never, op!.objectId);
    expect(expanded).toHaveLength(count);
    const times = expanded.map((v) => new Date(v.visitedAt).getTime());
    expect(times[0]).toBe(now);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThan(times[i - 1]);
  });

  it("v2: a visit group with no title round-trips as an undefined title, not the string 'undefined'", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const plaintext = { v: 2, groups: [{ u: "https://no-title.test", v: [5000] }] };
    const envelope = encryptWithSdek(plaintext, sdek, device!.accountKeyVersion, testBulkAad);
    const container = { v: 1, bulkVersion: 2, visitCount: 1, segments: [envelope] };

    const expanded = await expandBulk(container as never, TEST_BULK_OBJECT_ID);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].title).toBeUndefined();
    expect(expanded[0].title).not.toBe("undefined");
    expect(expanded[0].url).toBe("https://no-title.test");
  });
});

describe("bulk compression (spec §D: deflate-raw)", () => {
  it("compressed segment round-trips: collect → decrypt → inflate → expand", async () => {
    const now = Date.now();
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: now, visitTimes: [now, now - 1000, now - 2000] },
    ]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    const container = op!.payload as { codec?: string };
    // Node (this test runtime) has CompressionStream, so the real producer
    // path compresses — this is the non-feature-detect-off case.
    expect(container.codec).toBe("deflate-raw");

    const expanded = await expandBulk(op!.payload as never, op!.objectId);
    expect(expanded).toHaveLength(3);
    expect(expanded.every((v) => v.url === "https://a.test")).toBe(true);
    expect(expanded[0].visitedAt).toBe(new Date(now).toISOString());
  });

  it("a v2 container with codec absent (uncompressed) still round-trips", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const plaintext = { v: 2, groups: [{ u: "https://plain.test", t: "Plain", v: [1000, 2000] }] };
    const envelope = encryptWithSdek(plaintext, sdek, device!.accountKeyVersion, testBulkAad);
    // No `codec` field at all — same as the producer's own uncompressed
    // fallback shape (spec §D: absent means uncompressed, not "unknown").
    const container = { v: 1, bulkVersion: 2, visitCount: 2, segments: [envelope] };

    const expanded = await expandBulk(container as never, TEST_BULK_OBJECT_ID);
    expect(expanded).toHaveLength(2);
    expect(expanded.map((v) => v.url)).toEqual(["https://plain.test", "https://plain.test"]);
    expect(expanded.map((v) => v.title)).toEqual(["Plain", "Plain"]);
  });

  it("a corrupted compressed segment fails closed (skipped, not thrown out of expansion)", async () => {
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    // Valid AEAD envelope, but its plaintext bytes are not valid deflate-raw
    // output — DecompressionStream must reject it, and that rejection must
    // be caught (decryptSegment's existing try/catch), not propagate.
    const garbage = new TextEncoder().encode("not actually compressed data — garbage bytes 12345");
    const envelope = encryptBytesWithSdek(garbage, sdek, device!.accountKeyVersion, testBulkAad);
    const container = { v: 1, bulkVersion: 2, codec: "deflate-raw", visitCount: 5, segments: [envelope] };

    const expanded = await expandBulk(container as never, TEST_BULK_OBJECT_ID);
    expect(expanded).toEqual([]);
  });

  it("feature-detect off: producer emits v2 without codec when CompressionStream is unavailable, and it still round-trips", async () => {
    const originalCompressionStream = globalThis.CompressionStream;
    const originalDecompressionStream = globalThis.DecompressionStream;
    try {
      // Simulates an MV3 runtime without CompressionStream support (spec
      // §D: never version-gate, only feature-detect) rather than mocking
      // the detection result directly — exercises the real feature-detect
      // path end to end.
      // @ts-expect-error test-only: simulate an environment without this API
      delete globalThis.CompressionStream;
      // @ts-expect-error test-only: simulate an environment without this API
      delete globalThis.DecompressionStream;
      resetDeflateSupportForTesting();

      const now = Date.now();
      installFakeChromeHistory([
        { url: "https://nostream.test", lastVisitTime: now, visitTimes: [now, now - 1000] },
      ]);
      const op = await collectSingleChunk(0);
      expect(op).not.toBeNull();
      const container = op!.payload as { codec?: string; bulkVersion: number };
      expect(container.bulkVersion).toBe(2); // §C's grouping is independent of §D's compression
      expect(container.codec).toBeUndefined();

      const expanded = await expandBulk(op!.payload as never, op!.objectId);
      expect(expanded).toHaveLength(2);
      expect(expanded.every((v) => v.url === "https://nostream.test")).toBe(true);
    } finally {
      globalThis.CompressionStream = originalCompressionStream;
      globalThis.DecompressionStream = originalDecompressionStream;
      resetDeflateSupportForTesting();
    }
  });

  it("compresses a synthetic repetitive dataset by a meaningful ratio (guards against silently shipping uncompressed data)", async () => {
    const now = Date.now();
    const visitCount = 5_000;
    const url = "https://repeat.test/page";
    const title = `title:${url}`;
    const times = Array.from({ length: visitCount }, (_, i) => now - i);

    // Uncompressed baseline: exact same plaintext shape the producer would
    // build for this visit set (v2 grouped), encrypted without deflate.
    const sdek = await getSdek(device!.accountKey, device!.accountKeyVersion);
    const uncompressedEnvelope = encryptWithSdek(
      { v: 2, groups: [{ u: url, t: title, v: times }] },
      sdek,
      device!.accountKeyVersion,
      testBulkAad,
    );
    const uncompressedBytes = uncompressedEnvelope.ciphertext.length;

    // Real producer path — node (this test runtime) has CompressionStream,
    // so this actually compresses.
    installFakeChromeHistory([{ url, lastVisitTime: now, visitTimes: times }]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    const container = op!.payload as { codec?: string; segments: Array<{ ciphertext: string }> };
    expect(container.codec).toBe("deflate-raw");
    const compressedBytes = container.segments.reduce((sum, s) => sum + s.ciphertext.length, 0);

    // A highly repetitive synthetic dataset like this should compress hard;
    // a regression that silently stops compressing (or ships plaintext
    // mislabeled as compressed) would leave compressedBytes ~= uncompressedBytes.
    expect(compressedBytes).toBeLessThan(uncompressedBytes * 0.5);
  });
});

describe("bulk backfill: URL reappearing across pages (regression)", () => {
  // Reproduces the real-world runaway-upload bug: a URL whose HistoryItem
  // resurfaces in a later page (in production this was a frequently-reloaded
  // local dev server whose lastVisitTime kept advancing while the scan was
  // still running, but the fix must hold regardless of *why* it resurfaces —
  // installFakeChromeHistory's static model can't itself produce this, so
  // this test drives chrome.history.search directly to force the overlap).
  // Without seenUrls dedup in enumerateVisits, this URL's visits get
  // collected a second time and the chunk's visitCount silently inflates.
  it("collects a URL's visits exactly once even if its item reappears in a later page", async () => {
    const hotUrl = "https://dev.local/reload";
    const now = 10_000_000;

    const page1Items = [
      { id: hotUrl, url: hotUrl, title: "hot", lastVisitTime: now },
      ...Array.from({ length: 4999 }, (_, i) => ({
        id: `https://filler.test/${i}`,
        url: `https://filler.test/${i}`,
        title: "filler",
        lastVisitTime: now - 1000 - i,
      })),
    ];
    // Same hotUrl item comes back on page 2 — the exact overlap observed in
    // production (page N and a later page sharing an identical boundary).
    const page2Items = [
      { id: hotUrl, url: hotUrl, title: "hot", lastVisitTime: now },
      { id: "https://filler.test/last", url: "https://filler.test/last", title: "filler", lastVisitTime: now - 6000 },
    ];

    let call = 0;
    const searchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return page1Items;
      if (call === 2) return page2Items;
      return [];
    });
    const getVisitsCallsByUrl = new Map<string, number>();
    const getVisitsMock = vi.fn(async ({ url }: { url: string }) => {
      getVisitsCallsByUrl.set(url, (getVisitsCallsByUrl.get(url) ?? 0) + 1);
      if (url === hotUrl) {
        return [
          { id: url, visitId: "1", referringVisitId: "0", visitTime: now, transition: "link" },
          { id: url, visitId: "2", referringVisitId: "0", visitTime: now - 500, transition: "link" },
        ];
      }
      return [{ id: url, visitId: "1", referringVisitId: "0", visitTime: now - 1000, transition: "link" }];
    });

    (globalThis as unknown as { chrome: unknown }).chrome = {
      history: { search: searchMock, getVisits: getVisitsMock, addUrl: vi.fn(async () => {}) },
    };

    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();

    // The regression check: hotUrl's visits are fetched exactly once, no
    // matter how many pages its HistoryItem shows up in.
    expect(getVisitsCallsByUrl.get(hotUrl)).toBe(1);
    // 4999 filler (page1) + 1 filler (page2) + 2 hotUrl visits — not
    // inflated by a second pass over hotUrl.
    expect(op!.visitCount).toBe(4999 + 1 + 2);
  });
});

describe("bulk paging cursor (fix B: correct cursor, no stall escalation)", () => {
  afterEach(() => {
    setBulkSearchPageSizeForTesting(5_000);
  });

  it("collects every in-window visit exactly once across many pages, including hot URLs revisited across page boundaries", async () => {
    setBulkSearchPageSizeForTesting(5);
    const now = 100_000_000;
    const hotUrls = ["https://hot-0.test", "https://hot-1.test", "https://hot-2.test"];
    const items: FakeHistoryItem[] = [];
    for (const url of hotUrls) {
      // Spread far enough apart that each hot URL's matching visit lands on
      // a different page as the cursor walks backward — the exact scenario
      // the old lastVisitTime-as-cursor bug skipped visits on.
      const visitTimes = Array.from({ length: 5 }, (_, i) => now - i * 10_000);
      items.push({ url, lastVisitTime: visitTimes[0], visitTimes });
    }
    for (let i = 0; i < 37; i++) {
      const t = now - 200_000 - i * 10;
      items.push({ url: `https://cold-${i}.test`, lastVisitTime: t, visitTimes: [t] });
    }
    installFakeChromeHistory(items);

    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    const expectedVisitCount = hotUrls.length * 5 + 37;
    expect(op!.visitCount).toBe(expectedVisitCount);

    const expanded = await expandBulk(op!.payload as never, op!.objectId);
    expect(expanded).toHaveLength(expectedVisitCount);
    const keys = expanded.map((v) => `${v.url}|${v.visitedAt}`);
    expect(new Set(keys).size).toBe(expectedVisitCount); // no duplicates
  });

  it("terminates instead of stalling in a dense timestamp neighborhood (regression for the deleted escalating-stall path)", async () => {
    setBulkSearchPageSizeForTesting(5);
    const now = 100_000_000;
    // 3 URLs packed into a 200-visit-wide millisecond-dense cluster each —
    // the old code's fullyDuplicatePage escalation existed for exactly this
    // shape. With the corrected cursor, pagination should walk straight
    // through it in a bounded number of pages, no escalation needed.
    const items: FakeHistoryItem[] = ["https://dense-a.test", "https://dense-b.test", "https://dense-c.test"].map(
      (url, idx) => {
        const visitTimes = Array.from({ length: 200 }, (_, i) => now - idx * 1000 - i);
        return { url, lastVisitTime: visitTimes[0], visitTimes };
      },
    );
    installFakeChromeHistory(items);

    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    expect(op!.visitCount).toBe(600);

    const chromeHistory = (
      globalThis as unknown as { chrome: { history: { search: ReturnType<typeof vi.fn> } } }
    ).chrome.history;
    // Bounded, not runaway: with 3 URLs and page size 5, this must resolve
    // in a small number of pages, not hang or loop indefinitely.
    expect(chromeHistory.search.mock.calls.length).toBeLessThan(50);
  });
});

describe("bulk import window (fix A: fixed [cutoffMs, endMs))", () => {
  it("persists endMs on the first run and reuses it (not a fresh Date.now()) on a retry", async () => {
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] }]);
    await backfillExisting();
    const persistedEndMs = device!.historyBulkEndMs;
    expect(persistedEndMs).toBeDefined();

    // Second run (e.g. a retry): must reuse the persisted endMs rather than
    // recomputing Date.now() again, even though real time has moved on.
    uploadOperationsMock.mockClear();
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] }]);
    await backfillExisting();
    expect(device!.historyBulkEndMs).toBe(persistedEndMs);
  });

  it("excludes visits at or after historyBulkEndMs, even though they're after cutoffMs", async () => {
    const cutoff = 1_700_000_000_000;
    const inWindowVisit = cutoff + 1000;
    const excludedVisit = cutoff + 5000; // at/after historyBulkEndMs below
    device = baseDevice({ historyBulkCutoffMs: cutoff, historyBulkEndMs: cutoff + 2000 });
    installFakeChromeHistory([
      { url: "https://both.test", lastVisitTime: excludedVisit, visitTimes: [inWindowVisit, excludedVisit] },
    ]);

    await backfillExisting();
    expect(lastUploadOp().visitCount).toBe(1);
  });
});

describe("bulk peer expansion", () => {
  function bulkOpFor(
    objectId: string,
    deviceId: string,
    container: unknown,
  ): { op: OperationOut; payload: unknown } {
    return {
      op: {
        operationId: "op-bulk-1",
        deviceId,
        deviceSequence: 1,
        lamportTimestamp: 1,
        objectType: "historyVisit",
        objectId,
        operationType: "bulkImport",
        encryptionVersion: 1,
        payload: container,
        serverCursor: 1,
        createdAt: new Date().toISOString(),
      },
      payload: container,
    };
  }

  it("replays a bulk import's distinct URLs, oldest first, once each", async () => {
    // 100 visits across two URLs: the peer has neither locally, so each URL is
    // added to its browser history once, not once per visit.
    const now = Date.now();
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: now, visitTimes: Array.from({ length: 60 }, (_, i) => now - i * 1000) },
      { url: "https://b.test", lastVisitTime: now - 1000, visitTimes: Array.from({ length: 40 }, (_, i) => now - 2000 - i * 1000) },
    ]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    emptyPeerHistory();

    const batch = batchAppliers.get("historyVisit");
    await batch!([bulkOpFor(op!.objectId, "device-2", op!.payload)]);

    // b.test's newest visit is older than a.test's, so it goes in first.
    expect(addedUrls()).toEqual(["https://b.test", "https://a.test"]);
  });

  it("adds nothing the browser already has", async () => {
    // The fake history still holds both URLs, so the replay finds nothing to add.
    const now = Date.now();
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: now, visitTimes: Array.from({ length: 60 }, (_, i) => now - i * 1000) },
      { url: "https://b.test", lastVisitTime: now - 1000, visitTimes: Array.from({ length: 40 }, (_, i) => now - 2000 - i * 1000) },
    ]);
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();

    const batch = batchAppliers.get("historyVisit");
    expect(batch).toBeDefined();
    await batch!([bulkOpFor(op!.objectId, "device-2", op!.payload)]);

    expect(historyApi().addUrl).not.toHaveBeenCalled();
  });

  it("replays every distinct URL of a large import: nothing is cut off", async () => {
    const now = Date.now();
    const count = 2600; // more than the 2000 a peer once kept
    installFakeChromeHistory(
      Array.from({ length: count }, (_, i) => ({
        url: `https://many.test/${i}`,
        lastVisitTime: now - i,
        visitTimes: [now - i],
      })),
    );
    const op = await collectSingleChunk(0);
    expect(op).not.toBeNull();
    expect(op!.visitCount).toBe(count);
    emptyPeerHistory();

    const batch = batchAppliers.get("historyVisit");
    await batch!([bulkOpFor(op!.objectId, "device-2", op!.payload)]);

    const urls = addedUrls();
    expect(urls).toHaveLength(count);
    expect(new Set(urls).size).toBe(count);
    // Oldest first: the highest index is the oldest visit.
    expect(urls[0]).toBe(`https://many.test/${count - 1}`);
    expect(urls[count - 1]).toBe("https://many.test/0");
  });

  it("re-applying the same bulk import adds nothing the second time", async () => {
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000, 2000] }]);
    const op = await collectSingleChunk(0);
    // The peer starts empty; once a URL is added it has a visit.
    const history = historyApi();
    const present = new Set<string>();
    history.getVisits.mockImplementation(async ({ url }: { url: string }) =>
      present.has(url) ? [{ visitId: "1" }] : [],
    );
    history.addUrl.mockImplementation(async ({ url }: { url: string }) => {
      present.add(url);
    });
    const batch = batchAppliers.get("historyVisit");
    const item = bulkOpFor(op!.objectId, "device-2", op!.payload);

    await batch!([item]);
    await batch!([item]);

    expect(history.addUrl).toHaveBeenCalledTimes(1);
  });

  it("skips own-device bulk entirely", async () => {
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] }]);
    const op = await collectSingleChunk(0);
    const history = historyApi();
    history.getVisits.mockClear();
    const batch = batchAppliers.get("historyVisit");

    await batch!([bulkOpFor(op!.objectId, "device-1", op!.payload)]);

    expect(history.getVisits).not.toHaveBeenCalled();
    expect(history.addUrl).not.toHaveBeenCalled();
  });
});

describe("bulk determinism and abort", () => {
  it("wipe → relogin same scope → identical operationId", async () => {
    const cutoff = 1_700_000_000_000;
    const first = await deterministicBulkIds("device-1", cutoff, 0);
    // Simulate logout wipe (local state gone) + relogin same scope: the
    // deterministic derivation re-mints the same IDs → server duplicate.
    const second = await deterministicBulkIds("device-1", cutoff, 0);
    expect(second.operationId).toBe(first.operationId);
    expect(second.objectId).toBe(first.objectId);
    // Genuinely different scope → genuinely different import (intentional).
    const third = await deterministicBulkIds("device-1", cutoff + 1000, 0);
    expect(third.operationId).not.toBe(first.operationId);
    // Different chunk index within the same scope → genuinely different
    // chunk, so its own distinct IDs (see BULK_CHUNK_TARGET_BYTES).
    const fourth = await deterministicBulkIds("device-1", cutoff, 1);
    expect(fourth.operationId).not.toBe(first.operationId);
    expect(fourth.objectId).not.toBe(first.objectId);
  });

  it("reuses the persisted cutoff on mid-POST retry (same IDs)", async () => {
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 5000, visitTimes: [5000] }]);
    await backfillExisting();
    const firstOp = lastUploadOp();
    const persistedCutoff = device!.historyBulkCutoffMs;
    expect(persistedCutoff).toBeDefined();

    // Simulate SW kill after persist, before response: next run passes a
    // different fresh cutoff, but the persisted scope wins → same IDs.
    uploadOperationsMock.mockClear();
    device = { ...device!, historyBulkCutoffMs: persistedCutoff, historyBulkOperationId: firstOp.operationId };
    installFakeChromeHistory([{ url: "https://a.test", lastVisitTime: 5000, visitTimes: [5000] }]);
    // Fresh cutoff would differ (time passed); bulk must reuse persisted.
    await backfillExisting();
    const secondOp = lastUploadOp();
    expect(secondOp.operationId).toBe(firstOp.operationId);
  });

  it("aborts cleanly when the device disconnects mid-collect", async () => {
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] },
      { url: "https://b.test", lastVisitTime: 2000, visitTimes: [2000] },
    ]);
    const { getDevice } = await import("../storage/db");
    vi.mocked(getDevice).mockImplementationOnce(async () => baseDevice());
    vi.mocked(getDevice).mockImplementationOnce(async () => undefined);
    await backfillExisting();
    expect(uploadOperationsMock).not.toHaveBeenCalled();
  });
});

describe("bulk chunk resume checkpoint (fix C: skip-by-count)", () => {
  // Forces one chunk per visit: BULK_SEGMENT_VISITS=1 makes every group its
  // own segment (flushed as soon as it's pushed), and
  // BULK_CHUNK_TARGET_VISITS=1 then flushes that segment's chunk
  // immediately — five distinct URLs become five distinct chunks, so a
  // resume partway through is actually exercised instead of everything
  // landing in one chunk.
  beforeEach(() => {
    setBulkSegmentVisitsForTesting(1);
    setBulkChunkTargetVisitsForTesting(1);
  });

  // These are shared module-level constants (see the setters' own doc
  // comments) — every other describe block in this file assumes the real
  // defaults, so this suite must restore them once it's done, not just set
  // them for its own duration.
  afterEach(() => {
    setBulkSegmentVisitsForTesting(10_000);
    setBulkChunkTargetVisitsForTesting(100_000);
  });

  function fiveUrlFixture(cutoff: number): void {
    installFakeChromeHistory(
      Array.from({ length: 5 }, (_, i) => ({
        url: `https://resume-${i}.test`,
        lastVisitTime: cutoff + 1000 + i,
        visitTimes: [cutoff + 1000 + i],
      })),
    );
  }

  it("resumes after an upload failure: earlier chunks aren't re-sent, later ones use the right deterministic IDs, no gaps or duplicates", async () => {
    const cutoff = 1_700_000_000_000;
    fiveUrlFixture(cutoff);

    // Chunks 0 and 1 (deviceSequence order tracks URL enumeration order,
    // itself deterministic per fix B) succeed; chunk 2 throws, simulating a
    // mid-import failure (SW kill, network error) after 2 chunks have
    // already landed.
    let call = 0;
    uploadOperationsMock.mockImplementation(async (ops) => {
      call += 1;
      if (call === 3) throw new Error("simulated upload failure");
      return { accepted: ops.map((o) => o.operationId), duplicate: [], rejected: [], serverCursor: call };
    });

    await expect(backfillExisting()).rejects.toThrow(/simulated upload failure/);
    expect(uploadOperationsMock).toHaveBeenCalledTimes(3);
    expect(device!.historyBulkUploadedChunks).toBe(2);
    expect(device!.historyBulkUploadedVisits).toBe(2);
    const firstRunOpsUploaded = uploadOperationsMock.mock.calls
      .slice(0, 2)
      .map((call) => (call[0] as LocalOperation[])[0]);
    const firstRunIds = firstRunOpsUploaded.map((op) => op.operationId);
    for (const op of firstRunOpsUploaded) {
      expect(Object.values(op.visitHours ?? {}).reduce((a, b) => a + b, 0)).toBe(1);
    }

    // Second run: uploads succeed from here on. Chunks 0-1 must not be
    // re-sent at all; the run picks up at chunk 2 and finishes chunks 2-4.
    uploadOperationsMock.mockReset();
    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: ops.map((o) => o.operationId),
      duplicate: [],
      rejected: [],
      serverCursor: 1,
    }));
    fiveUrlFixture(cutoff);
    await backfillExisting();

    expect(uploadOperationsMock).toHaveBeenCalledTimes(3);
    const secondRunOps = uploadOperationsMock.mock.calls.map((call) => (call[0] as LocalOperation[])[0]);
    for (const op of secondRunOps) {
      expect(firstRunIds).not.toContain(op.operationId);
    }
    // Use the actually-persisted cutoff (retention is "unlimited" in this
    // suite, so backfillHistoryBulk's effective cutoff is 0, not the local
    // `cutoff` constant above — that constant only shapes the fixture's
    // visit timestamps) — same pattern as "reuses the persisted cutoff on
    // mid-POST retry" above.
    const chunk2Ids = await deterministicBulkIds("device-1", device!.historyBulkCutoffMs ?? 0, 2);
    expect(secondRunOps[0].operationId).toBe(chunk2Ids.operationId);
    expect(secondRunOps[0].objectId).toBe(chunk2Ids.objectId);

    // Union of both runs covers every visit exactly once: 2 (first run,
    // recorded before the mock was reset) + 3 (second run) = 5, matching
    // the fixture, with no objectId overlap between the two runs.
    expect(secondRunOps.reduce((sum, op) => sum + (op.visitCount ?? 0), 0)).toBe(3);
    const secondRunObjectIds = secondRunOps.map((op) => op.objectId);
    expect(new Set(secondRunObjectIds).size).toBe(secondRunObjectIds.length);

    // Change 3 + fix C interaction: each resumed chunk's visitHours must
    // reflect only its own (post-skip) visit — never a visit already
    // covered by an earlier, already-uploaded chunk. Every chunk here
    // carries exactly 1 visit (BULK_CHUNK_TARGET_VISITS=1), so a histogram
    // that accidentally re-counted a skipped visit would sum to more than 1.
    for (const op of secondRunOps) {
      const sum = Object.values(op.visitHours ?? {}).reduce((a, b) => a + b, 0);
      expect(sum).toBe(op.visitCount);
      expect(sum).toBe(1);
    }
    // Checkpoint is cleared after the import fully completes.
    expect(device!.historyBulkUploadedChunks).toBeUndefined();
    expect(device!.historyBulkUploadedVisits).toBeUndefined();
  });

  it("does not advance the checkpoint when a chunk upload throws", async () => {
    const cutoff = 1_700_000_000_000;
    fiveUrlFixture(cutoff);
    uploadOperationsMock.mockImplementationOnce(async (ops) => ({
      accepted: ops.map((o) => o.operationId),
      duplicate: [],
      rejected: [],
      serverCursor: 1,
    }));
    uploadOperationsMock.mockImplementationOnce(async () => {
      throw new Error("simulated upload failure");
    });

    await expect(backfillExisting()).rejects.toThrow(/simulated upload failure/);

    // Chunk 0 succeeded and its checkpoint was persisted; chunk 1 (the
    // throwing one) must not have advanced it any further.
    expect(device!.historyBulkUploadedChunks).toBe(1);
    expect(device!.historyBulkUploadedVisits).toBe(1);
  });

  it("migrates a legacy in-progress device record (old resume fields) to the new scheme and restarts from chunk 0", async () => {
    const cutoff = 1_700_000_000_000;
    // Old shape, from before fix C: page-granularity resume fields, cutoff
    // persisted, no historyBulkEndMs (didn't exist yet).
    device = {
      ...baseDevice({ historyBulkCutoffMs: cutoff }),
      historyBulkResumePageEndTime: cutoff + 999,
      historyBulkResumePreviousPageEndTime: cutoff + 500,
      historyBulkResumeChunkIndex: 2,
    } as DeviceRecord;
    fiveUrlFixture(cutoff);

    await backfillExisting();

    // Old fields are gone; historyBulkEndMs has been backfilled.
    expect((device as unknown as Record<string, unknown>)["historyBulkResumePageEndTime"]).toBeUndefined();
    expect((device as unknown as Record<string, unknown>)["historyBulkResumePreviousPageEndTime"]).toBeUndefined();
    expect((device as unknown as Record<string, unknown>)["historyBulkResumeChunkIndex"]).toBeUndefined();
    expect(device!.historyBulkEndMs).toBeDefined();

    // Treated as "uploaded 0 chunks": every one of the 5 fixture visits was
    // uploaded this run (chunk indices restart at 0), not just the ones
    // beyond the stale chunk-index-2 checkpoint.
    expect(uploadOperationsMock).toHaveBeenCalledTimes(5);
    const firstOp = (uploadOperationsMock.mock.calls[0][0] as LocalOperation[])[0];
    const chunk0Ids = await deterministicBulkIds("device-1", cutoff, 0);
    expect(firstOp.operationId).toBe(chunk0Ids.operationId);
  });
});

describe("backfillExisting retention window (bulk)", () => {
  it("scopes to 7d and reports the scoped visitCount", async () => {
    retention = "7d";
    const now = Date.now();
    const recent = now - 2 * 24 * 60 * 60 * 1000;
    const old = now - 60 * 24 * 60 * 60 * 1000;
    installFakeChromeHistory([
      { url: "https://recent.test", lastVisitTime: recent, visitTimes: [recent] },
      { url: "https://old.test", lastVisitTime: old, visitTimes: [old] },
    ]);

    await backfillExisting();

    const op = lastUploadOp();
    expect(op.visitCount).toBe(1);
  });

  it("filters old visits of a still-recent URL", async () => {
    retention = "7d";
    const now = Date.now();
    const recentVisit = now - 1 * 24 * 60 * 60 * 1000;
    const oldVisit = now - 100 * 24 * 60 * 60 * 1000;
    installFakeChromeHistory([
      { url: "https://mixed.test", lastVisitTime: recentVisit, visitTimes: [recentVisit, oldVisit] },
    ]);

    await backfillExisting();

    expect(lastUploadOp().visitCount).toBe(1);
  });

  it("falls open to unlimited when settings fetch fails", async () => {
    const { fetchSettings } = await import("../api/client");
    vi.mocked(fetchSettings).mockRejectedValueOnce(new Error("offline"));
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
    installFakeChromeHistory([{ url: "https://old.test", lastVisitTime: old, visitTimes: [old] }]);

    await backfillExisting();

    expect(lastUploadOp().visitCount).toBe(1);
  });
});

describe("backfillExisting capture toggle", () => {
  it("skips the import entirely while History sync is disabled", async () => {
    syncHistory = false;
    installFakeChromeHistory([{ url: "https://x.test", lastVisitTime: 1000, visitTimes: [1000] }]);

    await backfillExisting();

    const chromeHistory = (
      globalThis as unknown as { chrome: { history: { search: ReturnType<typeof vi.fn> } } }
    ).chrome.history;
    expect(chromeHistory.search).not.toHaveBeenCalled();
    expect(uploadOperationsMock).not.toHaveBeenCalled();
  });

  it("still backfills when the toggle is enabled or omitted", async () => {
    syncHistory = true;
    installFakeChromeHistory([{ url: "https://x.test", lastVisitTime: 1000, visitTimes: [1000] }]);
    await backfillExisting();
    expect(lastUploadOp().visitCount).toBe(1);
  });
});

describe("backfillExisting visit-transition filter", () => {
  it("skips auto_subframe visits but keeps user-navigated ones", async () => {
    const now = Date.now();
    installFakeChromeHistory([{ url: "https://m.test", lastVisitTime: now, visitTimes: [now, now - 1000] }]);
    const getVisits = (
      globalThis as unknown as { chrome: { history: { getVisits: ReturnType<typeof vi.fn> } } }
    ).chrome.history.getVisits;
    getVisits.mockImplementation(async () => [
      { id: "u", visitId: "1", referringVisitId: "0", visitTime: now, transition: "auto_subframe" },
      { id: "u", visitId: "2", referringVisitId: "0", visitTime: now - 1000, transition: "link" },
    ]);

    await backfillExisting();

    expect(lastUploadOp().visitCount).toBe(1);
  });
});
