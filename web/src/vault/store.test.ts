import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockVault, setAccountKey } from "./keyring";
import type { WorkerRequest, WorkerResponse } from "./snapshot.worker";
import { clearVault, getVaultState, loadVault } from "./store";
import type { VaultData } from "./types";
import { packVaultData } from "./wire";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;
  constructor(
    public url: URL,
    public options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: WorkerRequest): void {
    this.received.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

const data: VaultData = {
  bookmarks: [{ id: "b", title: "T", url: "https://t.test/", parent: null, position: "a" }],
  folders: [],
  history: [
    { url: "https://a.test/", title: "A", t: 1700000000000 },
    { url: "https://b.test/", title: "", t: 1699999999000 },
  ],
  tabs: [],
  windows: [],
  tabGroups: [],
  unreadable: 0,
  incomplete: 0,
};

// Any touch of browser storage fails the test.
const storageTouched = vi.fn();
function trap(name: string): void {
  vi.stubGlobal(
    name,
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          storageTouched(name, String(prop));
          return undefined;
        },
      },
    ),
  );
}

beforeEach(() => {
  FakeWorker.instances = [];
  storageTouched.mockClear();
  vi.stubGlobal("Worker", FakeWorker);
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"]) trap(name);
});

afterEach(() => {
  lockVault();
  clearVault();
  vi.unstubAllGlobals();
});

describe("vault store", () => {
  it("does nothing while locked", () => {
    loadVault();
    expect(getVaultState().status).toBe("idle");
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("decrypts in a worker, handing it a copy of the key, and shows the result", () => {
    const key = new Uint8Array(32).fill(5);
    setAccountKey(key);
    loadVault();
    expect(getVaultState().status).toBe("loading");

    const [worker] = FakeWorker.instances;
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.received).toHaveLength(1);
    expect(worker.received[0].accountKey).not.toBe(key);
    expect([...worker.received[0].accountKey]).toEqual([...key]);

    worker.reply({ ok: true, data: packVaultData(data) });
    const state = getVaultState();
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.data).toEqual(data);
    expect(worker.terminated).toBe(true);
  });

  it("ignores a second load while one is running", () => {
    setAccountKey(new Uint8Array(32));
    loadVault();
    loadVault();
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("drops the decrypted data when the vault locks", () => {
    setAccountKey(new Uint8Array(32));
    loadVault();
    FakeWorker.instances[0].reply({ ok: true, data: packVaultData(data) });
    expect(getVaultState().status).toBe("ready");

    lockVault();
    expect(getVaultState()).toEqual({ status: "idle" });
  });

  it("abandons a load in progress when the vault locks, and ignores its late answer", () => {
    setAccountKey(new Uint8Array(32));
    loadVault();
    const [worker] = FakeWorker.instances;

    lockVault();
    expect(worker.terminated).toBe(true);
    worker.reply({ ok: true, data: packVaultData(data) });
    expect(getVaultState()).toEqual({ status: "idle" });
  });

  it("reports an unsupported format and an HTTP failure", () => {
    setAccountKey(new Uint8Array(32));
    loadVault();
    FakeWorker.instances[0].reply({ ok: false, failure: { kind: "unsupported" } });
    expect(getVaultState().status).toBe("unsupported");

    loadVault();
    FakeWorker.instances[1].reply({ ok: false, failure: { kind: "http", status: 401, code: "unauthorized" } });
    const state = getVaultState();
    expect(state.status).toBe("error");
    expect(state.status === "error" && (state.error as { status: number }).status).toBe(401);
  });

  it("turns a missing Worker into an error state", () => {
    vi.stubGlobal("Worker", undefined);
    setAccountKey(new Uint8Array(32));
    loadVault();
    expect(getVaultState().status).toBe("error");
  });

  it("never touches browser storage through load, ready and lock", () => {
    setAccountKey(new Uint8Array(32));
    loadVault();
    FakeWorker.instances[0].reply({ ok: true, data: packVaultData(data) });
    lockVault();
    expect(storageTouched).not.toHaveBeenCalled();
  });
});
