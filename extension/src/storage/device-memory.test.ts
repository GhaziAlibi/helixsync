import { describe, expect, it, vi } from "vitest";

// Regression test for P0-1: the SW heap's device mirror must not stay stale
// after another heap (popup) writes chrome.storage.session. The message
// handlers in background/index.ts now call invalidateDeviceMemory() on
// REFRESH_CAPTURE_CONFIG / DEVICE_DISCONNECTED; this tests the primitive.

vi.mock("idb", () => ({
  openDB: vi.fn(async () => ({
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    transaction: vi.fn(() => {
      throw new Error("unused");
    }),
    count: vi.fn(async () => 0),
  })),
}));

describe("device memory invalidation across contexts", () => {
  it("re-hydrates from session after invalidateDeviceMemory", async () => {
    const sessionStore = new Map<string, unknown>();
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) if (sessionStore.has(key)) out[key] = sessionStore.get(key);
            return out;
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
          }),
          remove: vi.fn(async () => {}),
        },
      },
    });
    const db = await import("./db");
    expect(await db.getDevice()).toBeUndefined();
    // Popup heap writes shared session directly:
    sessionStore.set("deviceCache", {
      id: "self",
      serverUrl: "https://x",
      deviceId: "d-new",
      userId: "",
      email: "a@b.c",
      accessToken: "a",
      accessTokenExpiresAt: new Date().toISOString(),
      refreshToken: "r",
      encryptionRootKey: "cmVr",
      encryptionRootKeyVersion: 1,
    });
    // Without invalidation the SW heap serves stale undefined:
    expect(await db.getDevice()).toBeUndefined();
    // With it (the REFRESH_CAPTURE_CONFIG path) the fresh device appears:
    db.invalidateDeviceMemory();
    expect(((await db.getDevice()) as { deviceId: string } | undefined)?.deviceId).toBe("d-new");
    vi.unstubAllGlobals();
  });
});
