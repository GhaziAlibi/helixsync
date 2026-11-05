import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOperationAad, decryptWithSdek, getSdek, toB64 } from "../crypto";
import type { LocalOperation, UploadResponse } from "./types";

// A `restore` of an object the server never saw is rejected object_not_found
// (it isn't an origination operation). The engine sends it again as a
// `create` for the same object (docs/protocol.md §16.4). Runs the real engine
// against a real IndexedDB; only the network is scripted.

const AK = toB64(crypto.getRandomValues(new Uint8Array(32)));
const DEVICE = { deviceId: "dev-A", accountKey: AK, accountKeyVersion: 1 };
const uploads: LocalOperation[][] = [];
let respond: (ops: LocalOperation[]) => UploadResponse;

async function load() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("chrome", { storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } } });
  uploads.length = 0;
  vi.doMock("../storage/db", async (importActual) => ({
    ...(await importActual<typeof import("../storage/db")>()),
    getDevice: async () => DEVICE,
  }));
  vi.doMock("../api/client", async (importActual) => ({
    ...(await importActual<typeof import("../api/client")>()),
    uploadOperations: async (ops: LocalOperation[]) => {
      uploads.push(ops);
      return respond(ops);
    },
    downloadChanges: vi.fn(),
    fetchSnapshot: vi.fn(),
  }));
  vi.doMock("../api/websocket", () => ({ isConnected: () => false }));
  const engine = await import("./engine");
  const db = await import("../storage/db");
  return { engine, db };
}

const payload = { title: "Docs", url: "https://example.com/docs", parent: "00000000-0000-7000-8000-000000000001", position: "a0" };

beforeEach(() => {
  respond = (ops) => ({ accepted: ops.map((o) => o.operationId), duplicate: [], rejected: [], serverCursor: 1 });
});

describe("restore of an unknown object", () => {
  it("is sent again as a create for the same object and payload", async () => {
    const { engine, db } = await load();
    const [restore] = await engine.createLocalOperationsBatch([
      { objectType: "bookmark", objectId: "obj-1", operationType: "restore", payload },
    ]);
    respond = (ops) =>
      ops[0].operationType === "restore"
        ? { accepted: [], duplicate: [], rejected: [{ operationId: ops[0].operationId, reason: "object_not_found" }], serverCursor: 0 }
        : { accepted: ops.map((o) => o.operationId), duplicate: [], rejected: [], serverCursor: 1 };

    await engine.uploadPending();

    // The same call sends the replacement.
    expect(uploads).toHaveLength(2);
    const sent = uploads.flat();
    expect(sent[0].operationType).toBe("restore");
    const create = sent.find((o) => o.operationType === "create")!;
    expect(create).toBeDefined();
    expect(create.objectId).toBe("obj-1");
    expect(create.objectType).toBe("bookmark");
    expect(create.operationId).not.toBe(restore.operation.operationId);
    expect(create.deviceSequence).toBeGreaterThan(restore.operation.deviceSequence);
    expect(create.lamportTimestamp).toBeGreaterThan(restore.operation.lamportTimestamp);

    // It decrypts with the create AAD only, to the original payload.
    const sdek = await getSdek(AK, 1);
    expect(decryptWithSdek(create.payload as never, sdek, buildOperationAad("bookmark", "obj-1", "create"))).toEqual(payload);
    expect(() => decryptWithSdek(create.payload as never, sdek, buildOperationAad("bookmark", "obj-1", "restore"))).toThrow();

    // Nothing of the original is left queued.
    expect(await db.countPendingOperations()).toBe(0);
  });

  it("records field state under the new operation's key", async () => {
    const { engine, db } = await load();
    await engine.createLocalOperationsBatch([{ objectType: "bookmarkFolder", objectId: "obj-2", operationType: "restore", payload: { ...payload, url: null } }]);
    respond = (ops) =>
      ops[0].operationType === "restore"
        ? { accepted: [], duplicate: [], rejected: [{ operationId: ops[0].operationId, reason: "object_not_found" }], serverCursor: 0 }
        : { accepted: ops.map((o) => o.operationId), duplicate: [], rejected: [], serverCursor: 1 };
    await engine.uploadPending();

    const create = uploads.flat().find((o) => o.operationType === "create")!;
    for (const field of ["liveness", "title", "url", "move"]) {
      const state = await db.getFieldState("obj-2", field);
      expect(state?.operationId).toBe(create.operationId);
      expect(state?.lamportTimestamp).toBe(create.lamportTimestamp);
      expect(state?.operationType).toBe("create");
    }
    expect((await db.getFieldState("obj-2", "move"))?.value).toEqual({ parent: payload.parent, position: payload.position });
  });

  it("still requeues other operations rejected object_not_found", async () => {
    const { engine, db } = await load();
    const [update] = await engine.createLocalOperationsBatch([
      { objectType: "bookmark", objectId: "obj-3", operationType: "update", payload: { title: "x" } },
    ]);
    respond = (ops) => ({ accepted: [], duplicate: [], rejected: [{ operationId: ops[0].operationId, reason: "object_not_found" }], serverCursor: 0 });
    await engine.uploadPending();
    const [record] = await db.getPendingOperations(10);
    expect(record.operation.operationId).toBe(update.operation.operationId);
    expect(record.operation.operationType).toBe("update");
    expect(record.attempts).toBe(1);
  });

  it("does not re-issue a restore the server accepts", async () => {
    const { engine } = await load();
    await engine.createLocalOperationsBatch([{ objectType: "bookmark", objectId: "obj-4", operationType: "restore", payload }]);
    await engine.uploadPending();
    expect(uploads.flat().map((o) => o.operationType)).toEqual(["restore"]);
  });
});

describe("pre-snapshot hooks", () => {
  it("run before local field state is cleared, and a failing hook doesn't block the resync", async () => {
    const { engine, db } = await load();
    await db.putFieldState({
      objectId: "o",
      field: "title",
      lamportTimestamp: 1,
      deviceId: "dev-A",
      operationId: "op",
      operationType: "create",
      value: "kept until the hook ran",
    });
    const seen: unknown[] = [];
    engine.registerPreSnapshotHook(async () => {
      seen.push((await db.getFieldState("o", "title"))?.value);
    });
    engine.registerPreSnapshotHook(async () => {
      throw new Error("hook failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await engine.applySnapshot({ snapshotCursor: 9, objects: [], tombstones: [] }, DEVICE as never);

    expect(seen).toEqual(["kept until the hook ran"]);
    expect(await db.getFieldState("o", "title")).toBeUndefined();
    expect((await db.getSyncState()).cursor).toBe(9);
    warn.mockRestore();
  });
});

describe("runExclusive", () => {
  it("waits for a running cycle and holds the slot meanwhile", async () => {
    const { engine } = await load();
    const order: string[] = [];
    const first = engine.runExclusive(async () => {
      order.push("first-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("first-end");
    });
    const second = engine.runExclusive(async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("releases the slot when the function throws", async () => {
    const { engine } = await load();
    await expect(engine.runExclusive(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(engine.runExclusive(async () => 5)).resolves.toBe(5);
  });
});
