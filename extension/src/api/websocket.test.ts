// Regression test: concurrent ensureConnected() calls share one in-flight
// WebSocket attempt instead of each opening their own socket (measured
// pre-fix: 2 concurrent calls constructed 2 sockets, doubling connections
// against the server's per-device limit and duplicating push handlers).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionStore = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, sessionStore.get(k)]))),
      set: vi.fn(async (obj: Record<string, unknown>) => void Object.entries(obj).forEach(([k, v]) => sessionStore.set(k, v))),
      remove: vi.fn(async (k: string) => void sessionStore.delete(k)),
    },
  },
});

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => ({
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "device-1",
    accessToken: "tok",
    accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    refreshToken: "r",
  })),
}));

vi.mock("./client", () => ({
  fetchSettings: vi.fn(async () => ({ tabRestorePolicy: "disabled" })),
  invalidateSettingsCache: vi.fn(async () => {}),
  refreshAccessToken: vi.fn(async () => "tok"),
}));

let wsConstructed = 0;
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeSocket.CONNECTING;
  listeners = new Map<string, Array<() => void>>();
  constructor(public url: string) {
    wsConstructed++;
  }
  addEventListener(t: string, fn: () => void) {
    const l = this.listeners.get(t) ?? [];
    l.push(fn);
    this.listeners.set(t, l);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
vi.stubGlobal("WebSocket", FakeSocket as never);

const { ensureConnected, disconnect } = await import("./websocket");

describe("ensureConnected connection sharing", () => {
  beforeEach(async () => {
    await disconnect();
    sessionStore.clear();
    wsConstructed = 0;
  });

  it("two concurrent calls while disconnected open exactly one socket", async () => {
    await Promise.all([ensureConnected(), ensureConnected()]);
    expect(wsConstructed).toBe(1);
  }, 30000);

  it("a call after the first attempt settles may connect again (no sticky memo)", async () => {
    await ensureConnected();
    expect(wsConstructed).toBe(1);
    await disconnect();
    await ensureConnected();
    expect(wsConstructed).toBe(2);
  }, 30000);
});

describe("reconnect backoff schedule", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await disconnect();
    sessionStore.clear();
    wsConstructed = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries at 1s then 2s (deadline and timer agree; pre-fix waited 2s then 4s)", async () => {
    // Every attempt fails at the WebSocket constructor, exercising the
    // backoff path deterministically. Math.random is pinned near 1 so the
    // reconnect jitter (scheduleReconnect arms [0.5x, 1x) of nominal) does
    // not perturb the exact nominal timings asserted here — Math.random is
    // pinned to 1 so the armed delay is exactly nominal (fake timers floor
    // fractional delays, so 0.999999 would fire 1ms early). The jitter
    // itself is covered by the dedicated test below.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    // Every attempt fails at the WebSocket constructor, exercising the
    // backoff path deterministically.
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        wsConstructed++;
        throw new Error("boom");
      }
    };
    try {
      const started = ensureConnected();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(wsConstructed).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(wsConstructed).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wsConstructed).toBe(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(wsConstructed).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(wsConstructed).toBe(3);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket as never;
      randomSpy.mockRestore();
    }
  }, 30000);

  it("jitters the armed timer to [0.5x, 1x) of nominal without moving the nominal schedule", async () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        wsConstructed++;
        throw new Error("boom");
      }
    };
    // Math.random = 0 -> armed delay is exactly 0.5x nominal (500ms for the
    // first 1000ms backoff); the persisted deadline/blocked-until math still
    // uses the unjittered nominal, so the second attempt's nominal is 2000ms.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const started = ensureConnected();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(wsConstructed).toBe(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(wsConstructed).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wsConstructed).toBe(2);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket as never;
      randomSpy.mockRestore();
    }
  }, 30000);

  it("resuming a long cooldown after restart arms no timer (alarm resumes it)", async () => {
    vi.resetModules();
    sessionStore.set("reconnectDelayMs", 60_000);
    sessionStore.set("reconnectBlockedUntil", Date.now() + 60_000);
    const fresh = await import("./websocket");
    await fresh.ensureConnected();
    expect(vi.getTimerCount()).toBe(0);
  }, 30000);

  it("resuming a short cooldown after restart still arms its timer", async () => {
    vi.resetModules();
    sessionStore.set("reconnectDelayMs", 5_000);
    sessionStore.set("reconnectBlockedUntil", Date.now() + 5_000);
    const fresh = await import("./websocket");
    await fresh.ensureConnected();
    expect(vi.getTimerCount()).toBe(1);
  }, 30000);
});
