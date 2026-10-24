import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A long download (applying a page of history replays thousands of URLs) runs
// while the user keeps browsing, and each captured visit reserves a device
// sequence in the same sync_state record. Writing back the state read at the
// start of the page rolled those sequences back, so later operations reused
// numbers already held by queued ones and the server rejected them as
// sequence_out_of_order (docs/protocol.md §4.1). Runs against a real
// IndexedDB (fake-indexeddb), not a mock, since the race is a storage one.

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("updateSyncState", () => {
  it("keeps device sequences reserved after the caller last read the state", async () => {
    const { getSyncState, reserveSequenceBatch, updateSyncState } = await import("./db");

    const readAtPageStart = await getSyncState();
    expect(readAtPageStart.deviceSequence).toBe(0);

    // Visits captured while the page is being applied.
    await reserveSequenceBatch(3);
    await reserveSequenceBatch(2);

    await updateSyncState({ cursor: 7, lastSyncAt: "2026-10-01T00:00:00.000Z" });

    const after = await getSyncState();
    expect(after.cursor).toBe(7);
    expect(after.lastSyncAt).toBe("2026-10-01T00:00:00.000Z");
    expect(after.deviceSequence).toBe(5);
    expect(after.lamportClock).toBe(5);
    // The next reservation continues after the ones already handed out.
    expect((await reserveSequenceBatch(1)).startDeviceSequence).toBe(5);
  });

  it("changes only the fields it is given", async () => {
    const { getSyncState, updateSyncState } = await import("./db");

    await updateSyncState({ cursor: 4, lastSyncAt: "2026-10-01T00:00:00.000Z" });
    await updateSyncState({ lastMaintenanceAt: "2026-10-02T00:00:00.000Z" });

    expect(await getSyncState()).toMatchObject({
      cursor: 4,
      lastSyncAt: "2026-10-01T00:00:00.000Z",
      lastMaintenanceAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("creates the record when none exists yet", async () => {
    const { getSyncState, updateSyncState } = await import("./db");

    await updateSyncState({ cursor: 1 });

    expect(await getSyncState()).toMatchObject({ id: "self", cursor: 1, deviceSequence: 0, lamportClock: 0 });
  });
});
