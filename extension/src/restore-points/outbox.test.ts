import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

let factory: IDBFactory;
let uploaded: string[];
let nextError: unknown;

async function load() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", factory);
  vi.doMock("../api/client", async (importActual) => {
    const actual = await importActual<typeof import("../api/client")>();
    return {
      ...actual,
      uploadRestorePoint: async (point: { id: string }) => {
        if (nextError) {
          const err = nextError;
          nextError = undefined;
          throw err;
        }
        uploaded.push(point.id);
        return point;
      },
    };
  });
  const api = await import("../api/client");
  const outbox = await import("./outbox");
  return { api, outbox };
}

const record = (id: string) => ({
  id,
  kind: "scheduled",
  bookmarkCount: 3,
  encryptionVersion: 1,
  envelope: { v: 2 },
});

beforeEach(() => {
  factory = new IDBFactory();
  uploaded = [];
  nextError = undefined;
});

describe("the restore point outbox", () => {
  it("keeps points across a worker restart and uploads them oldest first", async () => {
    let { outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    await new Promise((r) => setTimeout(r, 5));
    await outbox.enqueueRestorePoint(record("b"));

    ({ outbox } = await load()); // a new worker
    expect((await outbox.listOutbox()).map((i) => i.id)).toEqual(["a", "b"]);

    const result = await outbox.drainOutbox();
    expect(uploaded).toEqual(["a", "b"]);
    expect([...result.values()].map((r) => r.outcome)).toEqual(["uploaded", "uploaded"]);
    expect(await outbox.listOutbox()).toEqual([]);
  });

  it("keeps a point when the network fails, and stops there", async () => {
    const { outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    await outbox.enqueueRestorePoint(record("b"));
    nextError = new TypeError("Failed to fetch");

    const result = await outbox.drainOutbox();
    expect(result.get("a")?.outcome).toBe("retry-later");
    expect(result.has("b")).toBe(false);
    expect(uploaded).toEqual([]);
    expect((await outbox.listOutbox()).map((i) => i.id)).toEqual(["a", "b"]);

    await outbox.drainOutbox();
    expect(uploaded).toEqual(["a", "b"]);
  });

  it("keeps a point on a server error or rate limit", async () => {
    const { api, outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    nextError = new api.ApiError("busy", 503);
    expect((await outbox.drainOutbox()).get("a")?.outcome).toBe("retry-later");
    nextError = new api.ApiError("slow down", 429, "rate_limited");
    expect((await outbox.drainOutbox()).get("a")?.outcome).toBe("retry-later");
    expect(await outbox.listOutbox()).toHaveLength(1);
  });

  it.each([
    ["restore_point_recent", 409],
    ["restore_points_disabled", 409],
    ["restore_point_limit", 409],
    ["validation_error", 400],
  ])("discards a point the server refuses for good (%s)", async (code, status) => {
    const { api, outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    await outbox.enqueueRestorePoint(record("b"));
    nextError = new api.ApiError("no", status, code);

    const result = await outbox.drainOutbox();
    expect(result.get("a")).toEqual({ outcome: "discarded", code });
    // The next one is still tried.
    expect(result.get("b")?.outcome).toBe("uploaded");
    expect(await outbox.listOutbox()).toEqual([]);
  });

  it("discards a point the server finds too large", async () => {
    const { api, outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    nextError = new api.ApiError("too big", 413);
    expect((await outbox.drainOutbox()).get("a")?.outcome).toBe("discarded");
    expect(await outbox.listOutbox()).toEqual([]);
  });

  it("gives up on a point after too many failed attempts", async () => {
    const { outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    for (let i = 0; i < 20; i++) {
      nextError = new TypeError("offline");
      await outbox.drainOutbox();
    }
    expect(await outbox.listOutbox()).toEqual([]);
  });

  it("drops a point that has waited a week", async () => {
    const { outbox } = await load();
    const db = await import("../storage/db");
    await db.putRestorePointOutbox({
      ...record("old"),
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      attempts: 0,
    });
    const result = await outbox.drainOutbox();
    expect(result.get("old")).toEqual({ outcome: "discarded", code: "expired" });
    expect(uploaded).toEqual([]);
  });

  it("stops quietly when the device needs to sign in again", async () => {
    const { api, outbox } = await load();
    await outbox.enqueueRestorePoint(record("a"));
    nextError = new api.ReauthRequiredError("no");
    expect((await outbox.drainOutbox()).get("a")?.outcome).toBe("retry-later");
    expect(await outbox.listOutbox()).toHaveLength(1);
  });
});
