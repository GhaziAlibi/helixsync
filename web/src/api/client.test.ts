import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KDF_PARAMS,
  deriveKek,
  deriveMasterKey,
  deriveRecoveryKeys,
  fromB64,
  generateAccountKey,
  generateRecoveryCode,
  parseRecoveryCode,
  toB64,
  unwrapAccountKey,
  wrapAccountKey,
} from "../crypto";

// `csrfToken` is module state, so every test imports a fresh copy of the
// client. `fetch` is replaced by a mock that records each call.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // client.ts reads VITE_API_BASE_URL at import time; the tests expect relative paths.
  vi.stubEnv("VITE_API_BASE_URL", "");
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; credentials?: string };

function call(index: number): Call {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: init.method as string,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    credentials: init.credentials,
  };
}

const client = () => import("./client");

describe("CSRF header", () => {
  it("is not sent on GET, even when a token is held", async () => {
    const { setCsrfToken, listDevices } = await client();
    setCsrfToken("tok");
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await listDevices();

    expect(call(0).method).toBe("GET");
    expect(call(0).headers["X-CSRF-Token"]).toBeUndefined();
  });

  it.each([
    ["POST", (c: Awaited<ReturnType<typeof client>>) => c.revokeDevice("d-1")],
    ["PATCH", (c: Awaited<ReturnType<typeof client>>) => c.renameDevice("d-1", "Laptop")],
    ["PATCH", (c: Awaited<ReturnType<typeof client>>) => c.updateSettings({ syncTabs: false })],
  ])("is sent on %s", async (method, run) => {
    const c = await client();
    c.setCsrfToken("tok-123");
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await run(c);

    expect(call(0).method).toBe(method);
    expect(call(0).headers["X-CSRF-Token"]).toBe("tok-123");
  });

  it("is sent on DELETE (account deletion)", async () => {
    const c = await client();
    c.setCsrfToken("tok-123");
    fetchMock
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(noContent());

    await c.deleteAccount("correct horse battery staple");

    expect(call(1).method).toBe("DELETE");
    expect(call(1).url).toBe("/api/v1/auth/account");
    expect(call(1).headers["X-CSRF-Token"]).toBe("tok-123");
  }, 30_000);

  it("is left off when no token is held yet (e.g. the first login)", async () => {
    const { revokeDevice } = await client();
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await revokeDevice("d-1");

    expect(call(0).headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("is dropped after logout, so the next mutation doesn't present a dead token", async () => {
    const c = await client();
    c.setCsrfToken("tok");
    fetchMock.mockResolvedValueOnce(noContent()).mockResolvedValueOnce(jsonResponse({}));

    await c.logout();
    await c.revokeDevice("d-1");

    expect(call(0).headers["X-CSRF-Token"]).toBe("tok");
    expect(call(1).headers["X-CSRF-Token"]).toBeUndefined();
  });
});

describe("request shape", () => {
  it("sends the session cookie with every request", async () => {
    const { listDevices, revokeDevice } = await client();
    fetchMock.mockImplementation(async () => jsonResponse([]));

    await listDevices();
    await revokeDevice("d-1");

    expect(call(0).credentials).toBe("include");
    expect(call(1).credentials).toBe("include");
  });

  it("sets Content-Type only when there is a body", async () => {
    const { listDevices, renameDevice } = await client();
    fetchMock.mockImplementation(async () => jsonResponse({}));

    await listDevices();
    await renameDevice("d-1", "Laptop");

    expect(call(0).headers["Content-Type"]).toBeUndefined();
    expect(call(1).headers["Content-Type"]).toBe("application/json");
    expect(call(1).body).toEqual({ name: "Laptop" });
  });
});

describe("error mapping", () => {
  it("turns an error body into an ApiError carrying message, status and code", async () => {
    const { listDevices, ApiError } = await client();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "device_limit_reached", message: "too many devices" }, 409));

    const err = await listDevices().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: "too many devices", status: 409, code: "device_limit_reached" });
  });

  it("falls back to a generic message when the body has none", async () => {
    const { listDevices } = await client();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));

    await expect(listDevices()).rejects.toMatchObject({ message: "request failed (403)", status: 403, code: undefined });
  });

  it("copes with a non-JSON error body, such as a proxy's HTML error page", async () => {
    const { listDevices } = await client();
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
    );

    await expect(listDevices()).rejects.toMatchObject({ message: "request failed (502)", status: 502 });
  });

  it("surfaces a closed registration with the server's own message and code", async () => {
    const { register } = await client();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "registration_disabled", message: "registration is disabled on this server" }, 403),
    );

    await expect(register("a@example.com", "correct horse battery staple")).rejects.toMatchObject({
      status: 403,
      code: "registration_disabled",
    });
  }, 30_000);
});

describe("204 No Content", () => {
  it("resolves to undefined without trying to parse a body", async () => {
    const { logout } = await client();
    fetchMock.mockResolvedValueOnce(noContent());

    await expect(logout()).resolves.toBeUndefined();
  });
});

describe("password handling (SEC-01)", () => {
  const PASSWORD = "correct horse battery staple";
  const SALT = toB64(Uint8Array.from({ length: 16 }, (_, i) => i + 1));

  it("login asks for the KDF material first and sends only the derived authKey", async () => {
    const { login } = await client();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ kdfSalt: SALT, kdfParams: DEFAULT_KDF_PARAMS }))
      .mockResolvedValueOnce(
        jsonResponse({ user: { id: "u-1", email: "a@example.com" }, csrfToken: "csrf-1", wrappedAk: "x", kdfSalt: SALT, kdfParams: DEFAULT_KDF_PARAMS, accountKeyVersion: 1 }),
      );

    const result = await login("a@example.com", PASSWORD);

    expect(call(0).url).toBe("/api/v1/auth/prelogin");
    expect(call(0).body).toEqual({ email: "a@example.com" });
    expect(call(1).url).toBe("/api/v1/auth/login");
    const sent = call(1).body as { email: string; authKey: string };
    // Known answer for this password and salt (also pinned in crypto tests).
    expect(sent).toEqual({ email: "a@example.com", authKey: "tqH-3QMYG1E9dVNKuW_VspmWeN5oe86XQf6RarodStQ" });
    expect(JSON.stringify(call(1).body)).not.toContain(PASSWORD);
    expect(result.csrfToken).toBe("csrf-1");
  }, 30_000);

  it("login keeps the CSRF token from the response for later mutations", async () => {
    const { login, revokeDevice } = await client();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ kdfSalt: SALT, kdfParams: DEFAULT_KDF_PARAMS }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "u-1", email: "a@example.com" }, csrfToken: "csrf-from-login" }))
      .mockResolvedValueOnce(jsonResponse({}));

    await login("a@example.com", PASSWORD);
    await revokeDevice("d-1");

    expect(call(2).headers["X-CSRF-Token"]).toBe("csrf-from-login");
  }, 30_000);

  it("register generates a fresh salt and wraps a new account key under the typed password", async () => {
    const { register } = await client();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ user: { id: "u-1", email: "a@example.com" }, csrfToken: "csrf-1" }),
    );

    const result = await register("a@example.com", PASSWORD);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = call(0).body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "authKey",
      "email",
      "kdfParams",
      "kdfSalt",
      "recoveryAuthKey",
      "recoveryWrappedAk",
      "wrappedAk",
    ]);
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
    expect(JSON.stringify(sent)).not.toContain(result.recoveryCode);

    // What was sent is internally consistent: the wrapped key opens with the
    // KEK that the same password and the same salt produce.
    const master = await deriveMasterKey(PASSWORD, sent.kdfSalt as string, sent.kdfParams as typeof DEFAULT_KDF_PARAMS);
    const accountKey = unwrapAccountKey(await deriveKek(master), sent.wrappedAk as string);
    expect(accountKey).toHaveLength(32);
    expect(fromB64(sent.kdfSalt as string)).toHaveLength(16);

    // And the returned recovery code opens the second copy of the same key.
    const recovery = await deriveRecoveryKeys(parseRecoveryCode(result.recoveryCode));
    expect(sent.recoveryAuthKey).toBe(recovery.authKey);
    expect(unwrapAccountKey(recovery.kek, sent.recoveryWrappedAk as string)).toEqual(accountKey);
  }, 30_000);
});

describe("recoverAccount", () => {
  const NEW_PASSWORD = "a brand new passphrase";

  async function preparedFor(code: string, accountKey: Uint8Array): Promise<Response> {
    const { kek } = await deriveRecoveryKeys(parseRecoveryCode(code));
    return jsonResponse({ recoveryWrappedAk: wrapAccountKey(kek, accountKey) });
  }

  it("re-wraps the same account key under the new password and a new code, sending neither secret", async () => {
    const { recoverAccount } = await client();
    const code = generateRecoveryCode();
    const accountKey = generateAccountKey();
    fetchMock.mockResolvedValueOnce(await preparedFor(code, accountKey)).mockResolvedValueOnce(noContent());

    const newCode = await recoverAccount("a@example.com", code.toLowerCase().replace(/-/g, " "), NEW_PASSWORD);

    const recovery = await deriveRecoveryKeys(parseRecoveryCode(code));
    expect(call(0).url).toBe("/api/v1/auth/recover/prepare");
    expect(call(0).body).toEqual({ email: "a@example.com", recoveryAuthKey: recovery.authKey });

    expect(call(1).url).toBe("/api/v1/auth/recover/complete");
    const sent = call(1).body as Record<string, string>;
    expect(sent.recoveryAuthKey).toBe(recovery.authKey);
    for (const secret of [NEW_PASSWORD, code, newCode]) {
      expect(JSON.stringify(sent)).not.toContain(secret);
    }

    const master = await deriveMasterKey(NEW_PASSWORD, sent.newKdfSalt, sent.newKdfParams as unknown as typeof DEFAULT_KDF_PARAMS);
    expect(unwrapAccountKey(await deriveKek(master), sent.newWrappedAk)).toEqual(accountKey);
    const next = await deriveRecoveryKeys(parseRecoveryCode(newCode));
    expect(newCode).not.toBe(code);
    expect(sent.newRecoveryAuthKey).toBe(next.authKey);
    expect(unwrapAccountKey(next.kek, sent.newRecoveryWrappedAk)).toEqual(accountKey);
  }, 30_000);

  it("rejects a malformed code before contacting the server", async () => {
    const { recoverAccount } = await client();

    await expect(recoverAccount("a@example.com", "ABCD-EFGH", NEW_PASSWORD)).rejects.toThrow("32 characters");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a wrong code as the server's 401 and sends nothing else", async () => {
    const { recoverAccount } = await client();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized", message: "unauthorized" }, 401));

    await expect(recoverAccount("a@example.com", generateRecoveryCode(), NEW_PASSWORD)).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("regenerateRecoveryCode", () => {
  const PASSWORD = "correct horse battery staple";
  const SALT = toB64(Uint8Array.from({ length: 16 }, (_, i) => i + 1));

  it("proves the current password and wraps the account key under the new code", async () => {
    const { regenerateRecoveryCode } = await client();
    const accountKey = generateAccountKey();
    const master = await deriveMasterKey(PASSWORD, SALT, DEFAULT_KDF_PARAMS);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "u-1",
          email: "a@example.com",
          wrappedAk: wrapAccountKey(await deriveKek(master), accountKey),
          kdfSalt: SALT,
          kdfParams: DEFAULT_KDF_PARAMS,
          accountKeyVersion: 1,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const code = await regenerateRecoveryCode(PASSWORD);

    expect(call(1).method).toBe("PATCH");
    expect(call(1).url).toBe("/api/v1/auth/recovery-code");
    const sent = call(1).body as Record<string, string>;
    expect(sent.currentAuthKey).toBe("tqH-3QMYG1E9dVNKuW_VspmWeN5oe86XQf6RarodStQ");
    const recovery = await deriveRecoveryKeys(parseRecoveryCode(code));
    expect(sent.recoveryAuthKey).toBe(recovery.authKey);
    expect(unwrapAccountKey(recovery.kek, sent.recoveryWrappedAk)).toEqual(accountKey);
  }, 30_000);

  it("reports a wrong password without contacting the server again", async () => {
    const { regenerateRecoveryCode } = await client();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "u-1",
        email: "a@example.com",
        wrappedAk: wrapAccountKey(generateAccountKey(), generateAccountKey()),
        kdfSalt: SALT,
        kdfParams: DEFAULT_KDF_PARAMS,
        accountKeyVersion: 1,
      }),
    );

    await expect(regenerateRecoveryCode(PASSWORD)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe("login with device", () => {
  it("creates a web request with the public key, and keeps the CSRF token from an approval", async () => {
    const c = await client();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "r-1", secret: "s-1", expiresAt: "2026-01-01T00:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
      .mockResolvedValueOnce(
        jsonResponse({ status: "approved", user: { id: "u-1", email: "a@example.com" }, csrfToken: "csrf-device" }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    await c.createAuthRequest("a@example.com", "pk");
    expect(call(0).url).toBe("/api/v1/auth/requests");
    expect(call(0).body).toEqual({ email: "a@example.com", kind: "web", publicKey: "pk" });

    await expect(c.pollAuthRequest("r-1", "s-1")).resolves.toEqual({ status: "pending" });
    expect(call(1).url).toBe("/api/v1/auth/requests/r-1/poll");
    expect(call(1).body).toEqual({ secret: "s-1" });

    await expect(c.pollAuthRequest("r-1", "s-1")).resolves.toEqual({
      status: "approved",
      user: { id: "u-1", email: "a@example.com" },
    });
    await c.revokeDevice("d-1");
    expect(call(3).headers["X-CSRF-Token"]).toBe("csrf-device");
  });
});

function meResponse(): Response {
  return jsonResponse({
    id: "u-1",
    email: "a@example.com",
    wrappedAk: "unused",
    kdfSalt: toB64(Uint8Array.from({ length: 16 }, (_, i) => i + 1)),
    kdfParams: DEFAULT_KDF_PARAMS,
    accountKeyVersion: 1,
  });
}

describe("deleteAccount", () => {
  const PASSWORD = "correct horse battery staple";

  it("sends the authKey derived from the account's own KDF material, never the password", async () => {
    const { deleteAccount } = await client();
    fetchMock.mockResolvedValueOnce(meResponse()).mockResolvedValueOnce(noContent());

    await expect(deleteAccount(PASSWORD)).resolves.toBeUndefined();

    expect(call(0).url).toBe("/api/v1/auth/me");
    expect(call(1).body).toEqual({ authKey: "tqH-3QMYG1E9dVNKuW_VspmWeN5oe86XQf6RarodStQ" });
    expect(JSON.stringify(call(1).body)).not.toContain(PASSWORD);
  }, 30_000);

  it("forgets the CSRF token once the account is gone", async () => {
    const c = await client();
    c.setCsrfToken("tok");
    fetchMock
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(jsonResponse({}));

    await c.deleteAccount(PASSWORD);
    await c.revokeDevice("d-1");

    expect(call(2).headers["X-CSRF-Token"]).toBeUndefined();
  }, 30_000);

  it("keeps the session (and its token) when the server rejects the password", async () => {
    const c = await client();
    c.setCsrfToken("tok");
    fetchMock
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized", message: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({}));

    await expect(c.deleteAccount("wrong password entirely")).rejects.toMatchObject({ status: 401 });
    await c.revokeDevice("d-1");

    expect(call(2).headers["X-CSRF-Token"]).toBe("tok");
  }, 30_000);
});

describe("getServerVersion", () => {
  it("returns registrationEnabled when the server reports it", async () => {
    const { getServerVersion } = await client();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ apiVersion: "v1", protocolVersion: 1, minimumSupportedProtocolVersion: 1, registrationEnabled: false }),
    );

    await expect(getServerVersion()).resolves.toMatchObject({ registrationEnabled: false });
    expect(call(0).url).toBe("/api/v1/version");
  });

  it("tolerates a server that predates the field", async () => {
    const { getServerVersion } = await client();
    fetchMock.mockResolvedValueOnce(jsonResponse({ apiVersion: "v1", protocolVersion: 1, minimumSupportedProtocolVersion: 1 }));

    const version = await getServerVersion();
    expect(version.registrationEnabled).toBeUndefined();
  });
});
