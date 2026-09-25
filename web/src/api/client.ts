// REST client for the web dashboard. Uses cookie-based sessions
// (docs/security.md §1.1) with a double-submit CSRF token on mutating
// requests, unlike the extension, which uses device bearer tokens.
import {
  DEFAULT_KDF_PARAMS,
  deriveAuthKey,
  deriveKek,
  deriveMasterKey,
  generateAccountKey,
  generateKdfSalt,
  unwrapAccountKey,
  wrapAccountKey,
  type KdfParams,
} from "../crypto";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message ?? `request failed (${res.status})`, res.status, body.error);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface UserPublic {
  id: string;
  email: string;
}

interface WireAuthResponse {
  user: UserPublic;
  csrfToken: string;
  wrappedAk: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  accountKeyVersion: number;
}

export interface AuthResponse {
  user: UserPublic;
  csrfToken: string;
}

interface PreloginResponse {
  kdfSalt: string;
  kdfParams: KdfParams;
}

/** SEC-01 / docs/encryption.md §2: must be called before `login` (and
 * before deriving the current key material for `changePassword`) — returns
 * the KDF material needed to derive `authKey` locally from the account
 * password. Never reveals whether the email actually has an account.
 * `register` does NOT call this: a brand-new account generates its own
 * fresh, random `kdfSalt` client-side (`generateKdfSalt`) rather than
 * reusing prelogin's deterministic fake-salt response for an email that
 * doesn't exist yet. */
async function prelogin(email: string): Promise<PreloginResponse> {
  return request("/api/v1/auth/prelogin", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const { kdfSalt, kdfParams } = await prelogin(email);
  const masterKey = await deriveMasterKey(password, kdfSalt, kdfParams);
  const authKey = await deriveAuthKey(masterKey);

  const result = await request<WireAuthResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, authKey }),
  });
  setCsrfToken(result.csrfToken);
  return { user: result.user, csrfToken: result.csrfToken };
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const kdfSalt = generateKdfSalt();
  const kdfParams = DEFAULT_KDF_PARAMS;
  const masterKey = await deriveMasterKey(password, kdfSalt, kdfParams);
  const authKey = await deriveAuthKey(masterKey);
  const kek = await deriveKek(masterKey);
  const wrappedAk = wrapAccountKey(kek, generateAccountKey());

  const result = await request<WireAuthResponse>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, authKey, kdfSalt, kdfParams, wrappedAk }),
  });
  setCsrfToken(result.csrfToken);
  return { user: result.user, csrfToken: result.csrfToken };
}

export async function logout(): Promise<void> {
  await request("/api/v1/auth/logout", { method: "POST" });
  csrfToken = null;
}

interface MeResponse extends UserPublic {
  wrappedAk: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  accountKeyVersion: number;
}

export async function me(): Promise<UserPublic> {
  const result = await request<MeResponse>("/api/v1/auth/me");
  return { id: result.id, email: result.email };
}

/** The account's current wrapped-key material (docs/encryption.md §2),
 * needed by `changePassword` to unwrap/rewrap the account key. A thin
 * wrapper over `/auth/me` rather than a separate endpoint — same data the
 * server already returns there. */
async function currentKeyMaterial(): Promise<MeResponse> {
  return request<MeResponse>("/api/v1/auth/me");
}

export interface DevicePublic {
  id: string;
  name: string;
  browser: string | null;
  browserVersion: string | null;
  platform: string | null;
  extensionVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export async function listDevices(): Promise<DevicePublic[]> {
  return request("/api/v1/devices");
}

export async function renameDevice(id: string, name: string): Promise<DevicePublic> {
  return request(`/api/v1/devices/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function revokeDevice(id: string): Promise<DevicePublic> {
  return request(`/api/v1/devices/${id}/revoke`, { method: "POST" });
}

export interface UserSettings {
  syncBookmarks: boolean;
  syncHistory: boolean;
  syncTabs: boolean;
  syncTabGroups: boolean;
  syncExtensions: boolean;
  tabRestorePolicy: "disabled" | "ask" | "automatic";
  historyRetention: "7d" | "30d" | "90d" | "1y" | "unlimited";
  requireEncryption: boolean;
}

export async function getSettings(): Promise<UserSettings> {
  return request("/api/v1/sync/settings");
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  return request("/api/v1/sync/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export interface ServerVersion {
  apiVersion: string;
  protocolVersion: number;
  minimumSupportedProtocolVersion: number;
  /** False when the operator has set `ALLOW_REGISTRATION=false`. Optional
   * because servers from before the switch existed don't send it; treat a
   * missing value as "registration open". */
  registrationEnabled?: boolean;
}

export async function getServerVersion(): Promise<ServerVersion> {
  return request("/api/v1/version");
}

export interface SyncStats {
  bookmarks: number;
  historyVisits: number;
  tabs: number;
  storageBytes: number;
  storageLimitBytes: number;
}

export async function getSyncStats(): Promise<SyncStats> {
  return request("/api/v1/sync/stats");
}

/** Rewraps the account key under a freshly-derived KEK (docs/encryption.md
 * §4) — the account key itself never changes, so existing synced data stays
 * decryptable on every device once it reconnects with the new password. The
 * server also revokes every other web session as part of this (SEC-10). */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const current = await currentKeyMaterial();

  const oldMasterKey = await deriveMasterKey(currentPassword, current.kdfSalt, current.kdfParams);
  const currentAuthKey = await deriveAuthKey(oldMasterKey);
  const oldKek = await deriveKek(oldMasterKey);
  // A wrong currentPassword surfaces as a raw AEAD "invalid tag" error from
  // the cipher, before anything is sent to the server — translate it into
  // something a user reads as a password mistake, not a crypto failure.
  let accountKey: Uint8Array;
  try {
    accountKey = unwrapAccountKey(oldKek, current.wrappedAk);
  } catch {
    throw new ApiError("current password is incorrect", 401, "unauthorized");
  }

  const newKdfSalt = generateKdfSalt();
  const newKdfParams = DEFAULT_KDF_PARAMS;
  const newMasterKey = await deriveMasterKey(newPassword, newKdfSalt, newKdfParams);
  const newAuthKey = await deriveAuthKey(newMasterKey);
  const newKek = await deriveKek(newMasterKey);
  const newWrappedAk = wrapAccountKey(newKek, accountKey);

  await request("/api/v1/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentAuthKey, newAuthKey, newKdfSalt, newKdfParams, newWrappedAk }),
  });
}

/** Permanently deletes the signed-in account and everything stored under it
 * (`DELETE /auth/account`). The server wants the current `authKey` in the
 * body, not just the session, so a stolen cookie alone can't do this. The
 * key is derived like login does, from the account's own KDF material
 * (`/auth/me`, the same source `changePassword` uses) and the typed
 * password; the password itself is never sent. A wrong password is a 401. */
export async function deleteAccount(password: string): Promise<void> {
  const { kdfSalt, kdfParams } = await currentKeyMaterial();
  const masterKey = await deriveMasterKey(password, kdfSalt, kdfParams);
  const authKey = await deriveAuthKey(masterKey);

  await request("/api/v1/auth/account", {
    method: "DELETE",
    body: JSON.stringify({ authKey }),
  });
  // The session and CSRF cookies are gone server-side too.
  csrfToken = null;
}

export interface WebSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

export async function listSessions(): Promise<WebSession[]> {
  return request("/api/v1/auth/sessions");
}

export async function revokeSession(id: string): Promise<void> {
  await request(`/api/v1/auth/sessions/${id}/revoke`, { method: "POST" });
}
