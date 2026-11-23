import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";
import type { PendingLocalOperation } from "../sync/engine";
import type { LocalOperation, OperationOut } from "../sync/types";
import { combineRulesets, type EffectiveRules } from "../rulesets/effective";
import { setCpuPaceTargetForTesting } from "../util/pace";

// History and rulesets (docs/protocol.md §17): live capture, the bulk import
// and its resume guard, and the replay of other devices' visits.

let device: DeviceRecord;
let rules: EffectiveRules;
const uploadOperationsMock = vi.fn<(ops: LocalOperation[]) => Promise<unknown>>();
const createLocalOperationsBatchMock = vi.fn<(items: PendingLocalOperation[]) => Promise<unknown[]>>();
let seq = 0;

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ historyRetention: "unlimited", syncHistory: true })),
  uploadOperations: (ops: LocalOperation[]) => uploadOperationsMock(ops),
}));
vi.mock("../storage/db", () => ({
  getRulesetsRecord: vi.fn(async () => undefined),
  getDevice: vi.fn(async () => device),
  putDevice: vi.fn(async (record: DeviceRecord) => {
    device = record;
  }),
  reserveSequenceBatch: vi.fn(async (count: number) => {
    const start = seq;
    seq += count;
    return { startDeviceSequence: start, startLamport: start };
  }),
}));
vi.mock("../rulesets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rulesets")>()),
  getEffectiveRules: vi.fn(async () => rules),
}));

type BatchApplier = (items: Array<{ op: OperationOut; payload: unknown }>) => Promise<void>;
const batchAppliers = new Map<string, BatchApplier>();
vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn((type: string, fn: unknown) => {
    batchAppliers.set(type, fn as BatchApplier);
  }),
  scheduleLocalSync: vi.fn(),
  uploadPending: vi.fn(async () => false),
}));

type VisitedListener = (item: { url?: string; title?: string; lastVisitTime?: number }) => void;
let visitedListener: VisitedListener | undefined;
const addUrlMock = vi.fn(async (_d: { url: string }) => {});

interface FakeItem {
  url: string;
  visitTimes: number[];
}
let items: FakeItem[] = [];
const getVisitsMock = vi.fn(async ({ url }: { url: string }) =>
  (items.find((i) => i.url === url)?.visitTimes ?? []).map((visitTime) => ({ visitTime, transition: "link" })),
);
(globalThis as unknown as { chrome: unknown }).chrome = {
  history: {
    onVisited: { addListener: vi.fn((cb: VisitedListener) => (visitedListener = cb)) },
    addUrl: (d: { url: string }) => addUrlMock(d),
    // Chromium semantics: one row per URL at its newest in-window visit, newest first.
    search: vi.fn(async (q: { startTime?: number; endTime?: number; maxResults?: number }) => {
      const start = q.startTime ?? 0;
      const rows = items
        .map((i) => {
          const inWindow = i.visitTimes.filter((t) => t >= start && (q.endTime === undefined || t < q.endTime));
          return inWindow.length ? { url: i.url, match: Math.max(...inWindow), last: Math.max(...i.visitTimes) } : null;
        })
        .filter((r): r is { url: string; match: number; last: number } => r !== null)
        .sort((a, b) => b.match - a.match);
      return (q.maxResults === undefined ? rows : rows.slice(0, q.maxResults)).map((r) => ({
        id: r.url,
        url: r.url,
        title: `t:${r.url}`,
        lastVisitTime: r.last,
      }));
    }),
    getVisits: (d: { url: string }) => getVisitsMock(d),
  },
  runtime: { getPlatformInfo: vi.fn() },
};

const set = (...rs: Array<import("../rulesets/types").Rule>) => combineRulesets([{ v: 1, name: "R", rules: rs, isDefault: false }]);
const domain = (d: string) => ({ id: d, kind: "blockDomain" as const, domain: d });

setCpuPaceTargetForTesting(1);
const { registerCapture } = await import("./index");
const bulk = await import("./bulk");
bulk.setBulkChunkUploadDelayMsForTesting(0);
const { resetReplayStateForTesting } = await import("./replay");

function baseDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "device-1",
    userId: "user-1",
    email: "u@example.test",
    accessToken: "t",
    accessTokenExpiresAt: "",
    refreshToken: "r",
    accountKey: "a".repeat(44),
    accountKeyVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  device = baseDevice();
  rules = combineRulesets([]);
  items = [];
  seq = 0;
  uploadOperationsMock.mockReset();
  uploadOperationsMock.mockImplementation(async (ops) => ({
    accepted: ops.map((o) => o.operationId),
    duplicate: [],
    rejected: [],
    serverCursor: 1,
  }));
  createLocalOperationsBatchMock.mockReset();
  createLocalOperationsBatchMock.mockImplementation(async (list) => list.map(() => ({})));
  getVisitsMock.mockClear();
  addUrlMock.mockClear();
  resetReplayStateForTesting();
  registerCapture();
});

describe("live capture", () => {
  it("drops visits to blocked URLs and keeps the rest", async () => {
    rules = set(domain("facebook.com"), { id: "l", kind: "blockLocal" });
    const t = Date.now();
    visitedListener?.({ url: "https://www.facebook.com/home", lastVisitTime: t });
    visitedListener?.({ url: "http://localhost:3000/", lastVisitTime: t + 1 });
    visitedListener?.({ url: "https://example.com/ok", lastVisitTime: t + 2 });
    await new Promise((r) => setTimeout(r, 300));
    const ops = createLocalOperationsBatchMock.mock.calls.flatMap((c) => c[0]);
    expect(ops.map((o) => (o.payload as { url: string }).url)).toEqual(["https://example.com/ok"]);
  });

  it("captures everything without rules", async () => {
    visitedListener?.({ url: "https://www.facebook.com/home", lastVisitTime: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    expect(createLocalOperationsBatchMock.mock.calls.flatMap((c) => c[0])).toHaveLength(1);
  });

  it("uploads nothing when every visit in the burst is blocked", async () => {
    rules = set(domain("facebook.com"));
    visitedListener?.({ url: "https://facebook.com/", lastVisitTime: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
  });
});

describe("bulk import", () => {
  const T0 = 1_000_000;
  function chunkOps(): LocalOperation[] {
    return uploadOperationsMock.mock.calls.flatMap((c) => c[0]);
  }

  it("never reads or sends a blocked URL", async () => {
    items = [
      { url: "https://a.test/", visitTimes: [T0 + 3] },
      { url: "https://www.facebook.com/", visitTimes: [T0 + 2] },
      { url: "https://b.test/", visitTimes: [T0 + 1] },
    ];
    rules = set(domain("facebook.com"));
    await bulk.collectHistoryBulk(0, 10_000_000, async (op) => {
      uploadOperationsMock([op]);
    });
    const op = chunkOps()[0];
    expect(op.visitCount).toBe(2);
    // The blocked URL's visits were not even read (it isn't the page's last item).
    expect(getVisitsMock.mock.calls.map((c) => c[0].url).sort()).toEqual(["https://a.test/", "https://b.test/"]);
  });

  it("pages past a blocked last item without stalling", async () => {
    bulk.setBulkSearchPageSizeForTesting(2);
    items = [
      { url: "https://a.test/", visitTimes: [T0 + 5] },
      { url: "https://www.facebook.com/1", visitTimes: [T0 + 4] }, // last of page 1
      { url: "https://b.test/", visitTimes: [T0 + 3] },
      { url: "https://www.facebook.com/2", visitTimes: [T0 + 2] }, // last of page 2
      { url: "https://c.test/", visitTimes: [T0 + 1] },
    ];
    rules = set(domain("facebook.com"));
    const sent: LocalOperation[] = [];
    await bulk.collectHistoryBulk(0, 10_000_000, async (op) => {
      sent.push(op);
    });
    expect(sent.reduce((n, o) => n + (o.visitCount ?? 0), 0)).toBe(3); // a, b, c
    bulk.setBulkSearchPageSizeForTesting(1000);
  });

  it("chunk ids are as before without rules, and differ under rules", async () => {
    const a = await bulk.deterministicBulkIds("d", 5, 0);
    const b = await bulk.deterministicBulkIds("d", 5, 0, "");
    const c = await bulk.deterministicBulkIds("d", 5, 0, "abc");
    const d = await bulk.deterministicBulkIds("d", 5, 0, "abd");
    expect(a).toEqual(b);
    expect(c.operationId).not.toBe(a.operationId);
    expect(c.objectId).not.toBe(a.objectId);
    expect(c.operationId).not.toBe(d.operationId);
  });

  it("restarts the scope when the rules changed since the checkpoint", async () => {
    items = [
      { url: "https://a.test/", visitTimes: [T0 + 3] },
      { url: "https://b.test/", visitTimes: [T0 + 2] },
      { url: "https://c.test/", visitTimes: [T0 + 1] },
    ];
    // A checkpoint taken with no rules: one chunk and two visits already sent.
    device = baseDevice({
      historyBulkCutoffMs: 0,
      historyBulkEndMs: 10_000_000,
      historyBulkUploadedChunks: 1,
      historyBulkUploadedVisits: 2,
    });
    rules = set(domain("b.test"));
    const sent: LocalOperation[] = [];
    await bulk.collectHistoryBulk(0, 10_000_000, async (op) => {
      sent.push(op);
    });
    // Not skip-resumed (that would have dropped a and c's neighbours wrongly):
    // the whole scope under the new rules, a and c, in chunk 0 of its own ids.
    expect(sent).toHaveLength(1);
    expect(sent[0].visitCount).toBe(2);
    const salted = await bulk.deterministicBulkIds("device-1", 0, 0, rules.hash);
    expect(sent[0].operationId).toBe(salted.operationId);
    expect(device.historyBulkRulesetHash).toBe(rules.hash);
  });

  it("resumes by count when the rules are the same as at the checkpoint", async () => {
    items = [
      { url: "https://a.test/", visitTimes: [T0 + 3] },
      { url: "https://b.test/", visitTimes: [T0 + 2] },
      { url: "https://c.test/", visitTimes: [T0 + 1] },
    ];
    rules = set(domain("b.test"));
    device = baseDevice({
      historyBulkCutoffMs: 0,
      historyBulkEndMs: 10_000_000,
      historyBulkUploadedChunks: 1,
      historyBulkUploadedVisits: 1, // a was sent under these rules
      historyBulkRulesetHash: rules.hash,
    });
    const sent: LocalOperation[] = [];
    await bulk.collectHistoryBulk(0, 10_000_000, async (op) => {
      sent.push(op);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].visitCount).toBe(1); // only c remains
    const next = await bulk.deterministicBulkIds("device-1", 0, 1, rules.hash);
    expect(sent[0].operationId).toBe(next.operationId);
  });

  it("a checkpoint from before rulesets existed resumes under no rules", async () => {
    items = [
      { url: "https://a.test/", visitTimes: [T0 + 2] },
      { url: "https://b.test/", visitTimes: [T0 + 1] },
    ];
    device = baseDevice({
      historyBulkCutoffMs: 0,
      historyBulkEndMs: 10_000_000,
      historyBulkUploadedChunks: 1,
      historyBulkUploadedVisits: 1,
    });
    const sent: LocalOperation[] = [];
    await bulk.collectHistoryBulk(0, 10_000_000, async (op) => {
      sent.push(op);
    });
    expect(sent[0].visitCount).toBe(1);
    const next = await bulk.deterministicBulkIds("device-1", 0, 1);
    expect(sent[0].operationId).toBe(next.operationId);
  });
});

describe("replay of other devices' visits", () => {
  it("does not write a blocked URL into this browser's history", async () => {
    rules = set(domain("facebook.com"));
    const apply = batchAppliers.get("historyVisit")!;
    const remote = (objectId: string, url: string) => ({
      op: {
        operationId: `op-${objectId}`,
        deviceId: "device-2",
        deviceSequence: 1,
        lamportTimestamp: 1,
        objectType: "historyVisit",
        objectId,
        operationType: "visit",
        encryptionVersion: 1,
        payload: {},
        serverCursor: 1,
        createdAt: new Date().toISOString(),
      } as OperationOut,
      payload: { url, visitedAt: new Date().toISOString() },
    });
    await apply([remote("o1", "https://www.facebook.com/x"), remote("o2", "https://example.com/y")]);
    expect(addUrlMock.mock.calls.map((c) => c[0].url)).toEqual(["https://example.com/y"]);
  });
});
