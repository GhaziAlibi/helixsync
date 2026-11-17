import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KDF_PARAMS,
  deriveKek,
  deriveMasterKey,
  generateAccountKey,
  generateKdfSalt,
  wrapAccountKey,
} from "../crypto";

// The client and keyring are module state, so each test imports fresh copies.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("VITE_API_BASE_URL", "");
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PASSWORD = "correct horse battery staple";
const salt = generateKdfSalt();
const accountKey = generateAccountKey();
let wrappedAk: string;

async function material() {
  if (!wrappedAk) {
    const master = await deriveMasterKey(PASSWORD, salt, DEFAULT_KDF_PARAMS);
    wrappedAk = wrapAccountKey(await deriveKek(master), accountKey);
  }
  return { kdfSalt: salt, kdfParams: DEFAULT_KDF_PARAMS, wrappedAk };
}

describe("unlocking the vault", () => {
  it("login keeps the account key in memory only", async () => {
    const m = await material();
    const client = await import("../api/client");
    const keyring = await import("./keyring");
    fetchMock
      .mockResolvedValueOnce(json({ kdfSalt: m.kdfSalt, kdfParams: m.kdfParams }))
      .mockResolvedValueOnce(
        json({ user: { id: "u", email: "a@example.com" }, csrfToken: "c", ...m, accountKeyVersion: 1 }),
      );

    await client.login("a@example.com", PASSWORD);

    expect([...keyring.getAccountKey()!]).toEqual([...accountKey]);
    keyring.lockVault();
  }, 30_000);

  it("login still succeeds when the key can't be unwrapped, and leaves the vault locked", async () => {
    const m = await material();
    const client = await import("../api/client");
    const keyring = await import("./keyring");
    fetchMock
      .mockResolvedValueOnce(json({ kdfSalt: m.kdfSalt, kdfParams: m.kdfParams }))
      .mockResolvedValueOnce(json({ user: { id: "u", email: "a@example.com" }, csrfToken: "c" }));

    await expect(client.login("a@example.com", PASSWORD)).resolves.toMatchObject({ csrfToken: "c" });
    expect(keyring.isUnlocked()).toBe(false);
  }, 30_000);

  it("unlocks from the typed password after a reload, sending only the /auth/me request", async () => {
    const m = await material();
    const client = await import("../api/client");
    const keyring = await import("./keyring");
    fetchMock.mockResolvedValueOnce(json({ id: "u", email: "a@example.com", recoveryCodeConfirmed: true, accountKeyVersion: 1, ...m }));

    await client.unlockAccountKey(PASSWORD);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/me");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(PASSWORD);
    expect([...keyring.getAccountKey()!]).toEqual([...accountKey]);
    keyring.lockVault();
  }, 30_000);

  it("rejects a wrong password with a 401 and stays locked", async () => {
    const m = await material();
    const client = await import("../api/client");
    const keyring = await import("./keyring");
    fetchMock.mockResolvedValueOnce(json({ id: "u", email: "a@example.com", recoveryCodeConfirmed: true, accountKeyVersion: 1, ...m }));

    await expect(client.unlockAccountKey("wrong password")).rejects.toMatchObject({ status: 401 });
    expect(keyring.isUnlocked()).toBe(false);
  }, 30_000);

  it("logout and account deletion drop the key, even if the request fails", async () => {
    const client = await import("../api/client");
    const keyring = await import("./keyring");

    keyring.setAccountKey(new Uint8Array(32).fill(1));
    fetchMock.mockResolvedValueOnce(json({ message: "boom" }, 500));
    await expect(client.logout()).rejects.toBeDefined();
    expect(keyring.isUnlocked()).toBe(false);

    const m = await material();
    keyring.setAccountKey(new Uint8Array(32).fill(1));
    fetchMock
      .mockResolvedValueOnce(json({ id: "u", email: "a@example.com", recoveryCodeConfirmed: true, accountKeyVersion: 1, ...m }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.deleteAccount(PASSWORD);
    expect(keyring.isUnlocked()).toBe(false);
  }, 30_000);
});
