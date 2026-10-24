import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";
import type { UserSettingsDto } from "./client";

// client.ts has no chrome-API mock harness in this project (see
// history/index.test.ts's comment on the same limitation) — chrome.storage.session
// and the global `fetch` that client.ts calls directly are both stubbed
// here with small in-memory fakes, and ../storage/db is mocked so
// authedFetch's getDevice() call doesn't need a real IndexedDB store.
//
// The settings cache under test (EXT-5: the in-memory mirror
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
    accountKey: "rek",
    accountKeyVersion: 1,
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

describe("fetchSettings caching (EXT-5)", () => {
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
    expect(sessionRemoveSpy).toHaveBeenCalledTimes(2); // settings cache + policy cache

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

describe("fetchTabRestorePolicy long-TTL cache (perf: idle-tick settings fetch)", () => {
  it("serves repeated badge/policy reads with one network fetch and one session read", async () => {
    const { fetchTabRestorePolicy } = await import("./client");
    for (let i = 0; i < 50; i++) {
      expect(await fetchTabRestorePolicy()).toBe("automatic");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 2 session reads on cold start (policy key + settings key, one each) —
    // steady-state cost is still zero IPC once both mirrors are warm.
    expect(sessionGetSpy).toHaveBeenCalledTimes(2);
  });

  it("stays cached past the 60s settings TTL without another network fetch", async () => {
    vi.useFakeTimers();
    const { fetchTabRestorePolicy } = await import("./client");
    expect(await fetchTabRestorePolicy()).toBe("automatic");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1); // one full alarm interval later
    expect(await fetchTabRestorePolicy()).toBe("automatic");
    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1: no idle-tick settings HTTPS
  });

  it("re-fetches once the 30-minute policy TTL expires", async () => {
    vi.useFakeTimers();
    const { fetchTabRestorePolicy } = await import("./client");
    expect(await fetchTabRestorePolicy()).toBe("automatic");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(await fetchTabRestorePolicy()).toBe("automatic");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("updateSettings writes the policy through, and invalidation clears it", async () => {
    const { fetchTabRestorePolicy, updateSettings, invalidateSettingsCache } = await import("./client");
    expect(await fetchTabRestorePolicy()).toBe("automatic");

    const patched = { ...baseSettings(), tabRestorePolicy: "ask" as const };
    fetchMock.mockResolvedValueOnce(jsonResponse(patched));
    await updateSettings({ tabRestorePolicy: "ask" });
    expect(await fetchTabRestorePolicy()).toBe("ask");
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + updateSettings only

    await invalidateSettingsCache();
    expect(await fetchTabRestorePolicy()).toBe("automatic");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("refreshAccessToken (EXT-01)", () => {
  it("throws ApiError with status 429 and parses Retry-After header without throwing ReauthRequiredError", async () => {
    const { refreshAccessToken, ApiError, ReauthRequiredError } = await import("./client");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "RATE_LIMITED", message: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "45",
        },
      })
    );

    let error: unknown;
    try {
      await refreshAccessToken("https://example.test");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ReauthRequiredError);
    const apiErr = error as InstanceType<typeof ApiError>;
    expect(apiErr.status).toBe(429);
    expect(apiErr.code).toBe("RATE_LIMITED");
    expect(apiErr.message).toBe("Too many requests");
    expect(apiErr.retryAfterSeconds).toBe(45);
  });

  it("throws ApiError with status 429 when Retry-After is absent", async () => {
    const { refreshAccessToken, ApiError, ReauthRequiredError } = await import("./client");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    let error: unknown;
    try {
      await refreshAccessToken("https://example.test");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ReauthRequiredError);
    const apiErr = error as InstanceType<typeof ApiError>;
    expect(apiErr.status).toBe(429);
    expect(apiErr.retryAfterSeconds).toBeUndefined();
    expect(apiErr.message).toBe("refresh failed with status 429");
  });

  it.each([500, 503])(
    "throws ApiError with status %i on transient server errors without throwing ReauthRequiredError",
    async (status) => {
      const { refreshAccessToken, ApiError, ReauthRequiredError } = await import("./client");
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: `server down with ${status}` }), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );

      let error: unknown;
      try {
        await refreshAccessToken("https://example.test");
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(ReauthRequiredError);
      const apiErr = error as InstanceType<typeof ApiError>;
      expect(apiErr.status).toBe(status);
      expect(apiErr.message).toBe(`server down with ${status}`);
    }
  );

  it.each([401, 403])(
    "throws ReauthRequiredError on HTTP %i authentication failure",
    async (status) => {
      const { refreshAccessToken, ApiError, ReauthRequiredError } = await import("./client");
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "UNAUTHORIZED", message: "Token revoked" }), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );

      let error: unknown;
      try {
        await refreshAccessToken("https://example.test");
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(ReauthRequiredError);
      expect(error).not.toBeInstanceOf(ApiError);
      const reauthErr = error as InstanceType<typeof ReauthRequiredError>;
      expect(reauthErr.message).toBe(`refresh failed with status ${status}`);
    }
  );

  it("[SEC-15] does not resurrect the device record if disconnect clears it mid-refresh", async () => {
    const { refreshAccessToken, ReauthRequiredError } = await import("./client");
    fetchMock.mockImplementationOnce(async () => {
      // Simulates the popup's disconnect flow wiping the device store while
      // this refresh's network round trip is still in flight.
      device = undefined as unknown as DeviceRecord;
      return jsonResponse({
        accessToken: "new-token",
        refreshToken: "new-refresh",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    });

    let error: unknown;
    try {
      await refreshAccessToken("https://example.test");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(device).toBeUndefined();
  });

  it("[SEC-15] does not overwrite a reconnected device's record with a stale refresh result", async () => {
    const { refreshAccessToken, ReauthRequiredError } = await import("./client");
    fetchMock.mockImplementationOnce(async () => {
      // Simulates disconnect + reconnect to a different account completing
      // while this refresh (started under the old device) is in flight.
      device = { ...baseDevice(), deviceId: "device-2", accountKey: "different-rek" };
      return jsonResponse({
        accessToken: "new-token",
        refreshToken: "new-refresh",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    });

    let error: unknown;
    try {
      await refreshAccessToken("https://example.test");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(device.deviceId).toBe("device-2");
    expect(device.accountKey).toBe("different-rek");
  });
});


describe("revokeThisDevice (Disconnect revokes server-side)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function revokeCalls(): Array<[string, RequestInit]> {
    return (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(([url]) =>
      url.endsWith("/api/v1/devices/self/revoke"),
    );
  }

  it("POSTs to /devices/self/revoke with the device's bearer token and reports success on 204", async () => {
    const { revokeThisDevice } = await import("./client");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(revokeThisDevice()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = revokeCalls()[0];
    expect(url).toBe("https://example.test/api/v1/devices/self/revoke");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token once, then revokes with the new one", async () => {
    const { revokeThisDevice } = await import("./client");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "fresh-token",
          refreshToken: "fresh-refresh",
          accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(revokeThisDevice()).resolves.toBe(true);

    const calls = revokeCalls();
    expect(calls).toHaveLength(2);
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
  });

  it("never throws when the server is unreachable, and says why in the console only", async () => {
    const { revokeThisDevice } = await import("./client");
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(revokeThisDevice()).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("disconnecting locally anyway");
  });

  it.each([403, 404, 500, 503])("reports false, without throwing, on HTTP %i", async (status) => {
    const { revokeThisDevice } = await import("./client");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, status));

    await expect(revokeThisDevice()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("reports false when the credentials are already invalid (refresh refused too)", async () => {
    const { revokeThisDevice } = await import("./client");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    await expect(revokeThisDevice()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the timeout when the server never answers, instead of hanging Disconnect", async () => {
    vi.useFakeTimers();
    const { revokeThisDevice, SELF_REVOKE_TIMEOUT_MS } = await import("./client");
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));

    const result = revokeThisDevice();
    await vi.advanceTimersByTimeAsync(SELF_REVOKE_TIMEOUT_MS + 1);

    await expect(result).resolves.toBe(false);
    expect(String(warnSpy.mock.calls[0][0])).toContain("timed out");
    // No timer is left behind to keep the service worker or popup busy.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing, and does not throw, when no device is registered", async () => {
    const { revokeThisDevice } = await import("./client");
    device = undefined as unknown as DeviceRecord;

    await expect(revokeThisDevice()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
