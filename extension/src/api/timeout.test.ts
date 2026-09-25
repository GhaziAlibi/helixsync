import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";

// Verifies perf fix P10: fetch timeouts must never leave a pending 30s timer
// holding the service worker awake after the request settles, and a genuinely
// hung request must still abort at 30s.

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const { registerDevice } = await import("./client");

beforeEach(() => {
  device = baseDevice();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(), remove: vi.fn() } },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const timeout = (AbortSignal as unknown as { timeout?: unknown }).timeout;
  if (timeout === undefined) {
    const real = (globalThis as unknown as { __realAbortTimeout?: unknown }).__realAbortTimeout;
    if (real !== undefined) {
      (AbortSignal as unknown as { timeout?: unknown }).timeout = real as never;
    }
  }
});

function hideNativeTimeout(): void {
  const g = globalThis as unknown as { __realAbortTimeout?: unknown };
  if (g.__realAbortTimeout === undefined) {
    g.__realAbortTimeout = (AbortSignal as unknown as { timeout?: unknown }).timeout;
  }
  (AbortSignal as unknown as { timeout?: unknown }).timeout = undefined;
}

describe("fetchWithTimeout timer cleanup (perf fix P10)", () => {
  it("leaves no pending timer after a fast successful request (manual path)", async () => {
    hideNativeTimeout();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          deviceId: "d1",
          accessToken: "a",
          refreshToken: "r",
          accessTokenExpiresAt: new Date().toISOString(),
          protocolVersion: 1,
          minimumSupportedProtocolVersion: 1,
          encryptionSalt: "c2FsdA",
        }),
      ),
    );

    await registerDevice({
      serverUrl: "https://example.test",
      email: "u@e.test",
      password: "pw",
      name: "n",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a hung request at 30s and leaves no pending timer (manual path)", async () => {
    hideNativeTimeout();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Timeout", "TimeoutError"));
            });
          }),
      ),
    );

    const pending = registerDevice({
      serverUrl: "https://example.test",
      email: "u@e.test",
      password: "pw",
      name: "n",
    });
    // Attach the rejection handler BEFORE advancing, so the abort rejection
    // is never momentarily unhandled.
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no pending timer after a fast request (native path)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          deviceId: "d1",
          accessToken: "a",
          refreshToken: "r",
          accessTokenExpiresAt: new Date().toISOString(),
          protocolVersion: 1,
          minimumSupportedProtocolVersion: 1,
          encryptionSalt: "c2FsdA",
        }),
      ),
    );

    await registerDevice({
      serverUrl: "https://example.test",
      email: "u@e.test",
      password: "pw",
      name: "n",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
