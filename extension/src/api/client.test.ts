import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";
import type { UserSettingsDto } from "./client";

// client.ts has no chrome-API mock harness in this project (see
// history/index.test.ts's comment on the same limitation) — chrome.storage.session
// and the global `fetch` that client.ts calls directly are both stubbed
// here with small in-memory fakes, and ../storage/db is mocked so
// authedFetch's getDevice() call doesn't need a real IndexedDB store.
//
// The settings cache under test (EXT-5, review.md: the in-memory mirror
// added in front of the chrome.storage.session-backed TTL cache) lives in
// module-level variables (memorySettingsCache/settingsCacheLoaded), so
// every test re-imports client.ts fresh via vi.resetModules() rather than
// sharing one import across tests — otherwise cache state left over from an
// earlier test would leak into the next one and hide exactly the
// cold-start-vs-warm distinction these tests exist to check.

let device: DeviceRecord;

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => device),
  putDevice: vi.fn(async (record: DeviceRecord) => {
    device = record;
  }),
}));

function baseDevice(): DeviceRecord {
  return {
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "device-1",
    userId: "user-1",
    email: "user@example.test",
    accessToken: "token",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "refresh-token",
    encryptionRootKey: "rek",
    encryptionRootKeyVersion: 1,
  };
}

function baseSettings(): UserSettingsDto {
  return {
    syncBookmarks: true,
    syncHistory: true,
    syncTabs: true,
    syncTabGroups: true,
    syncExtensions: false,
    tabRestorePolicy: "automatic",
    historyRetention: "30d",
    requireEncryption: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let sessionStore: Record<string, unknown>;
let sessionGetSpy: ReturnType<typeof vi.fn>;
let sessionSetSpy: ReturnType<typeof vi.fn>;
let sessionRemoveSpy: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  device = baseDevice();
  sessionStore = {};

  sessionGetSpy = vi.fn(async (key: string) => ({ [key]: sessionStore[key] }));
  sessionSetSpy = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(sessionStore, items);
  });
  sessionRemoveSpy = vi.fn(async (key: string) => {
    delete sessionStore[key];
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: sessionGetSpy,
        set: sessionSetSpy,
        remove: sessionRemoveSpy,
      },
    },
  };

  fetchMock = vi.fn(async () => jsonResponse(baseSettings()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchSettings caching (EXT-5, review.md)", () => {
  it("reads through chrome.storage.session on a cold start", async () => {
    const { fetchSettings } = await import("./client");
    const settings = await fetchSettings();
    expect(settings).toEqual(baseSettings());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionGetSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call chrome.storage.session.get again for a second call within the TTL window", async () => {
    const { fetchSettings } = await import("./client");
    await fetchSettings();
    expect(sessionGetSpy).toHaveBeenCalledTimes(1);

    const settings = await fetchSettings();
    expect(settings).toEqual(baseSettings());
    // Still 1: the in-memory mirror served the second call, so
    // readSettingsCache never touched chrome.storage.session again.
    expect(sessionGetSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL expires and refreshes the in-memory mirror", async () => {
    vi.useFakeTimers();
    const { fetchSettings } = await import("./client");
    await fetchSettings();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001); // just past SETTINGS_CACHE_TTL_MS
    await fetchSettings();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the in-memory mirror on invalidateSettingsCache so the next read is a genuine miss", async () => {
    const { fetchSettings, invalidateSettingsCache } = await import("./client");
    await fetchSettings();
    expect(sessionGetSpy).toHaveBeenCalledTimes(1);

    await invalidateSettingsCache();
    expect(sessionRemoveSpy).toHaveBeenCalledTimes(1);

    // Must hit the network again — nothing valid cached anymore, whether in
    // the mirror or in chrome.storage.session — rather than serving the
    // stale in-memory value from before invalidation.
    await fetchSettings();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("updateSettings writes through to the in-memory mirror, so the next fetchSettings needs no extra IPC or network call", async () => {
    const { fetchSettings, updateSettings } = await import("./client");
    await fetchSettings();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const getCallsAfterFirstRead = sessionGetSpy.mock.calls.length;

    const patched = { ...baseSettings(), tabRestorePolicy: "ask" as const };
    fetchMock.mockResolvedValueOnce(jsonResponse(patched));
    const result = await updateSettings({ tabRestorePolicy: "ask" });
    expect(result.tabRestorePolicy).toBe("ask");

    const settings = await fetchSettings();
    expect(settings.tabRestorePolicy).toBe("ask");
    expect(fetchMock).toHaveBeenCalledTimes(2); // fetchSettings + updateSettings only
    expect(sessionGetSpy).toHaveBeenCalledTimes(getCallsAfterFirstRead); // mirror served it
  });

  it("simulates the restorePolicy hot path: many calls in one batch cost exactly one storage.session.get and one network fetch", async () => {
    const { fetchSettings } = await import("./client");
    for (let i = 0; i < 500; i++) {
      await fetchSettings();
    }
    expect(sessionGetSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
