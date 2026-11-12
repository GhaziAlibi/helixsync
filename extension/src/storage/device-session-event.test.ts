import { describe, expect, it, vi } from "vitest";
import { toB64 } from "../crypto";

// Regression: getDevice() hydrates from IndexedDB, then mirrors the record to
// chrome.storage.session. That write fires the session change listener, which
// clears the memory mirror. Firefox runs the listener before the write's
// promise resolves, so getDevice() used to return the just-cleared mirror
// (undefined) and startup skipped a connected device's initial import.

const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
async function encrypt(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return JSON.stringify({ iv: toB64(iv), ciphertext: toB64(ciphertext) });
}

const storedDevice = {
  id: "self",
  serverUrl: "https://x",
  deviceId: "d-1",
  userId: "u-1",
  email: "a@b.c",
  accessToken: "a",
  accessTokenExpiresAt: new Date().toISOString(),
  refreshToken: await encrypt("refresh"),
  accountKey: await encrypt("account-key"),
  accountKeyVersion: 1,
};

vi.mock("idb", () => ({
  openDB: vi.fn(async () => ({
    get: vi.fn(async (store: string) => (store === "device" ? storedDevice : store === "device_secret_key" ? key : undefined)),
    put: vi.fn(async () => {}),
  })),
}));

describe("getDevice with Firefox's session event order", () => {
  it("returns the device even when the session write's change event runs first", async () => {
    const sessionStore = new Map<string, unknown>();
    const listeners: Array<(changes: Record<string, unknown>) => void> = [];
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (k: string) => (sessionStore.has(k) ? { [k]: sessionStore.get(k) } : {})),
          // Firefox: listeners run before the set() promise resolves.
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
            for (const listener of listeners) listener(items);
          }),
          remove: vi.fn(async () => {}),
          onChanged: { addListener: (l: (changes: Record<string, unknown>) => void) => listeners.push(l) },
        },
      },
    });
    const db = await import("./db");

    const device = await db.getDevice();

    expect(device?.deviceId).toBe("d-1");
    expect(device?.accountKey).toBe("account-key");
    expect(device?.refreshToken).toBe("refresh");
    expect(listeners.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
