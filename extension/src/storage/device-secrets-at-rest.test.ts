import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// F-11 regression: `device.accountKey` and `device.refreshToken` must never
// reach the IndexedDB "device" object store in plaintext. Unlike the other
// storage tests, this one does NOT mock "idb" — it runs against a real
// IndexedDB implementation (fake-indexeddb) and real WebCrypto, so it
// actually exercises encryptDeviceSecret/decryptDeviceSecret end to end
// instead of asserting against a mock.

function stubChromeSessionStorage(): void {
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
        remove: vi.fn(async (k: string) => {
          sessionStore.delete(k);
        }),
      },
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  // Fresh database per test: fake-indexeddb keeps state in the module-level
  // `indexedDB` instance, which persists across tests otherwise.
  vi.stubGlobal("indexedDB", new IDBFactory());
  stubChromeSessionStorage();
});

const PLAINTEXT_ACCOUNT_KEY = "super-secret-account-key-b64";
const PLAINTEXT_REFRESH_TOKEN = "super-secret-refresh-token";

function baseDeviceRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "self" as const,
    serverUrl: "https://example.com",
    deviceId: "device-1",
    userId: "user-1",
    email: "a@b.c",
    accessToken: "access-token",
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: PLAINTEXT_REFRESH_TOKEN,
    accountKey: PLAINTEXT_ACCOUNT_KEY,
    accountKeyVersion: 1,
    ...overrides,
  };
}

describe("F-11: device secrets at rest", () => {
  it("stores accountKey/refreshToken encrypted in IndexedDB, not as plaintext", async () => {
    const db = await import("./db");
    await db.putDevice(baseDeviceRecord() as never);

    // Bypass getDevice() entirely and read the raw IDB record, the way
    // someone inspecting the on-disk LevelDB files would see it.
    const raw = await db.getDb().then((conn) => conn.get("device", "self"));
    expect(raw).toBeDefined();
    expect(raw!.accountKey).not.toBe(PLAINTEXT_ACCOUNT_KEY);
    expect(raw!.refreshToken).not.toBe(PLAINTEXT_REFRESH_TOKEN);
    expect(raw!.accountKey).not.toContain(PLAINTEXT_ACCOUNT_KEY);
    expect(raw!.refreshToken).not.toContain(PLAINTEXT_REFRESH_TOKEN);

    // The stored value must be an AEAD envelope, not just an obfuscated copy.
    const parsedAccountKey = JSON.parse(raw!.accountKey) as { iv: string; ciphertext: string };
    expect(typeof parsedAccountKey.iv).toBe("string");
    expect(typeof parsedAccountKey.ciphertext).toBe("string");

    // Other fields (not covered by F-11) stay in plaintext, unchanged.
    expect(raw!.deviceId).toBe("device-1");
    expect(raw!.accessToken).toBe("access-token");
  });

  it("round-trips accountKey/refreshToken back to plaintext through getDevice()", async () => {
    const db = await import("./db");
    await db.putDevice(baseDeviceRecord() as never);

    const device = await db.getDevice();
    expect(device?.accountKey).toBe(PLAINTEXT_ACCOUNT_KEY);
    expect(device?.refreshToken).toBe(PLAINTEXT_REFRESH_TOKEN);
  });

  it("two different accountKey values encrypt to different ciphertexts (real AEAD, not a static substitution)", async () => {
    const db = await import("./db");
    await db.putDevice(baseDeviceRecord({ accountKey: "key-one" }) as never);
    const first = await db.getDb().then((conn) => conn.get("device", "self"));

    await db.putDevice(baseDeviceRecord({ accountKey: "key-two" }) as never);
    const second = await db.getDb().then((conn) => conn.get("device", "self"));

    expect(first!.accountKey).not.toBe(second!.accountKey);
  });
});
