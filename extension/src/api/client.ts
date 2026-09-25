import type {
  DownloadResponse,
  LocalOperation,
  SnapshotResponse,
  UploadResponse,
} from "../sync/types";
import { getDevice, putDevice } from "../storage/db";
import { addSessionStorageChangeListener } from "../util/session-storage";
import { singleFlight } from "../util/single-flight";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    // From a 429's `Retry-After` header; undefined when missing or invalid so
    // the caller picks its own fallback instead of this layer guessing.
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

// The server always sends whole seconds, but the value came over the
// network, so it is validated rather than trusted.
function parseRetryAfterSeconds(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function buildApiError(res: Response, fallbackMessage: string): Promise<ApiError> {
  const body = await res.json().catch(() => ({}));
  return new ApiError(body.message ?? fallbackMessage, res.status, body.error, parseRetryAfterSeconds(res));
}

/** The access token was rejected and refreshing failed too; the device needs
 * re-authentication (docs/protocol.md §15.6). */
export class ReauthRequiredError extends Error {}

/** docs/protocol.md §13: lets the server refuse writes (426) from clients
 * too old to sync safely. */
const PROTOCOL_VERSION = 1;

/** Without a timeout a hung socket would pin the sync engine's in-flight
 * flag forever, so every later trigger would stall behind it. */
export const SYNC_FETCH_TIMEOUT_MS = 30_000;

function combinedSignal(ms: number, outer?: AbortSignal | null): { signal: AbortSignal; cleanup: () => void } {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof timeout === "function") {
    const t = timeout.call(AbortSignal, ms);
    if (!outer) return { signal: t, cleanup: () => {} };
    const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof anyFn === "function") return { signal: anyFn.call(AbortSignal, [outer, t]), cleanup: () => {} };
  }
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort((outer as AbortSignal).reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  // Manual fallback for runtimes without AbortSignal.timeout. The timer must
  // always be cleared, or a finished request would keep the service worker
  // awake for the full timeout.
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
  const cleanup = () => {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: controller.signal, cleanup };
}

function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  ms: number = SYNC_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { signal, cleanup } = combinedSignal(ms, init.signal ?? null);
  return fetch(input, { ...init, signal }).finally(cleanup);
}

// The server rotates refresh tokens on every use (docs/security.md §1.2), so
// concurrent 401s must share one refresh: a second request presenting the
// just-rotated token would be rejected and wrongly force re-authentication.
const refreshAccessTokenOnce = singleFlight(async (serverUrl: string): Promise<string> => {
  const device = await getDevice();
  if (!device) throw new ReauthRequiredError("no device registered");

  const res = await fetchWithTimeout(`${serverUrl}/api/v1/devices/credentials/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: device.refreshToken }),
  });

  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw await buildApiError(res, `refresh failed with status ${res.status}`);
    }
    throw new ReauthRequiredError(`refresh failed with status ${res.status}`);
  }

  const body = await res.json();

  // SEC-15: the device may have been disconnected or replaced while the
  // request was in flight; writing over it would resurrect wiped credentials.
  const current = await getDevice();
  if (!current || current.deviceId !== device.deviceId) {
    throw new ReauthRequiredError("device disconnected during refresh");
  }

  const updated = {
    ...current,
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
    accessTokenExpiresAt: body.accessTokenExpiresAt as string,
  };
  await putDevice(updated);
  return updated.accessToken;
});

export async function refreshAccessToken(serverUrl: string): Promise<string> {
  return refreshAccessTokenOnce(serverUrl);
}

/** Sends a device-authenticated request, refreshing the access token once on
 * a 401. */
async function authedFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = SYNC_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const device = await getDevice();
  if (!device) throw new ReauthRequiredError("no device registered");

  const send = (token: string) =>
    fetchWithTimeout(
      `${device.serverUrl}${path}`,
      {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
          "X-Protocol-Version": String(PROTOCOL_VERSION),
        },
      },
      timeoutMs,
    );

  let res = await send(device.accessToken);
  if (res.status === 401) {
    // A concurrent request may already have refreshed while ours was in
    // flight; reuse its token rather than rotating again.
    const currentDevice = await getDevice();
    const newToken =
      currentDevice && currentDevice.accessToken !== device.accessToken
        ? currentDevice.accessToken
        : await refreshAccessToken(device.serverUrl);
    res = await send(newToken);
  }
  return res;
}

/** Disconnect must never feel stuck behind an unreachable server, so the
 * whole revoke (including a token refresh, if the access token expired) gets
 * this long before the device is disconnected locally regardless. */
export const SELF_REVOKE_TIMEOUT_MS = 5_000;

/** Revokes this device on the server (`POST /devices/self/revoke`) so its
 * credentials stop working and it stops holding back compaction and counting
 * toward the device cap, instead of lingering until revoked from the
 * dashboard. Best-effort by design: it never throws, and a `false` result
 * (offline, timeout, server error, credentials already invalid) only means
 * the caller disconnects locally anyway and the device remains listed on the
 * dashboard for manual revocation. Must run before the local device record
 * is wiped, since it needs the stored tokens. */
export async function revokeThisDevice(timeoutMs: number = SELF_REVOKE_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const attempt = authedFetch("/api/v1/devices/self/revoke", { method: "POST" }, timeoutMs);
  // If the timeout wins, a later rejection must not surface as unhandled.
  attempt.catch(() => {});

  try {
    const outcome = await Promise.race([attempt, timedOut]);
    if (outcome === "timeout") {
      console.warn("HelixSync: timed out revoking this device on the server; disconnecting locally anyway");
      return false;
    }
    if (!outcome.ok) {
      console.warn(`HelixSync: server refused to revoke this device (${outcome.status}); disconnecting locally anyway`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("HelixSync: could not revoke this device on the server; disconnecting locally anyway", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface PreloginResult {
  kdfSalt: string;
  kdfParams: { m: number; t: number; p: number };
}

/** SEC-01 / docs/encryption.md §2: returns the KDF material for deriving
 * `authKey` locally. The response never reveals whether the account exists. */
export async function prelogin(serverUrl: string, email: string): Promise<PreloginResult> {
  const res = await fetchWithTimeout(`${serverUrl}/api/v1/auth/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    throw await buildApiError(res, `prelogin failed (${res.status})`);
  }

  return res.json();
}

export interface RegisterDeviceParams {
  serverUrl: string;
  email: string;
  // Derived locally from the password (crypto::deriveAuthKey); the password
  // itself is never sent (SEC-01).
  authKey: string;
  name: string;
  browser?: string;
  browserVersion?: string;
  platform?: string;
  extensionVersion?: string;
}

export interface RegisterDeviceResult {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  protocolVersion: number;
  minimumSupportedProtocolVersion: number;
  // Unwrapped locally with the KEK derived from the password
  // (docs/encryption.md §2); identical for every device on the account.
  wrappedAccountKey: string;
  accountKeyVersion: number;
}

export async function registerDevice(params: RegisterDeviceParams): Promise<RegisterDeviceResult> {
  const res = await fetchWithTimeout(`${params.serverUrl}/api/v1/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: params.email,
      authKey: params.authKey,
      name: params.name,
      browser: params.browser,
      browserVersion: params.browserVersion,
      platform: params.platform,
      extensionVersion: params.extensionVersion,
    }),
  });

  if (!res.ok) {
    throw await buildApiError(res, `registration failed (${res.status})`);
  }

  return res.json();
}

/** `timeoutMs` is raised only for the bulk history import, whose single op
 * can be large enough to outlast the standard timeout. */
export async function uploadOperations(operations: LocalOperation[], timeoutMs?: number): Promise<UploadResponse> {
  const res = await authedFetch(
    "/api/v1/sync/operations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operations }),
    },
    timeoutMs ?? SYNC_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw await buildApiError(res, `upload failed (${res.status})`);
  }
  return res.json();
}

export async function downloadChanges(cursor: number, limit = 500): Promise<DownloadResponse> {
  const res = await authedFetch(`/api/v1/sync/changes?cursor=${cursor}&limit=${limit}`);
  if (!res.ok) {
    throw await buildApiError(res, `download failed (${res.status})`);
  }
  return res.json();
}

export async function fetchSnapshot(): Promise<SnapshotResponse> {
  const res = await authedFetch("/api/v1/sync/snapshot");
  if (!res.ok) {
    throw await buildApiError(res, `snapshot failed (${res.status})`);
  }
  return res.json();
}

export interface UserSettingsDto {
  syncBookmarks: boolean;
  syncHistory: boolean;
  syncTabs: boolean;
  syncTabGroups: boolean;
  syncExtensions: boolean;
  tabRestorePolicy: "disabled" | "ask" | "automatic";
  historyRetention: "7d" | "30d" | "90d" | "1y" | "unlimited";
  requireEncryption: boolean;
}

type TabRestorePolicy = UserSettingsDto["tabRestorePolicy"];

interface TtlCacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Settings are read for nearly every remote tab op and every badge update,
// on an endpoint with no rate limit of its own, so they're cached briefly.
// The cache lives in chrome.storage.session, which survives MV3 worker
// restarts without touching disk, and is mirrored in memory so repeat reads
// skip the storage IPC. `loaded` distinguishes "no entry" from "not read
// yet", so an empty cache doesn't cost an IPC on every call.
function createTtlSessionCache<T>(storageKey: string, ttlMs: number) {
  let memory: TtlCacheEntry<T> | undefined;
  let loaded = false;

  async function read(): Promise<TtlCacheEntry<T> | undefined> {
    if (loaded) return memory;
    const stored = await chrome.storage.session.get(storageKey);
    memory = stored[storageKey] as TtlCacheEntry<T> | undefined;
    loaded = true;
    return memory;
  }

  async function write(entry: TtlCacheEntry<T> | undefined): Promise<void> {
    memory = entry;
    loaded = true;
    if (entry) {
      await chrome.storage.session.set({ [storageKey]: entry });
    } else {
      await chrome.storage.session.remove(storageKey);
    }
  }

  return {
    storageKey,
    async readFresh(): Promise<TtlCacheEntry<T> | undefined> {
      const entry = await read();
      return entry && Date.now() < entry.expiresAt ? entry : undefined;
    },
    store(value: T): Promise<void> {
      return write({ value, expiresAt: Date.now() + ttlMs });
    },
    clear(): Promise<void> {
      return write(undefined);
    },
    /** Drops only the memory mirror, so the next read picks up what another
     * context (popup or worker) wrote to the session. */
    invalidateMemory(): void {
      memory = undefined;
      loaded = false;
    },
  };
}

const SETTINGS_CACHE_TTL_MS = 60_000;
// The badge and tab appliers only need the restore policy, which changes
// only through explicit user action, so it gets a much longer TTL than the
// other settings. `updateSettings` writes through, and disconnect clears it.
const POLICY_CACHE_TTL_MS = 30 * 60_000;

const settingsCache = createTtlSessionCache<UserSettingsDto>("settingsCache", SETTINGS_CACHE_TTL_MS);
const policyCache = createTtlSessionCache<TabRestorePolicy>("tabRestorePolicyCache", POLICY_CACHE_TTL_MS);

export function invalidateSettingsMemory(): void {
  settingsCache.invalidateMemory();
}

export function invalidatePolicyMemory(): void {
  policyCache.invalidateMemory();
}

addSessionStorageChangeListener((changes) => {
  if (settingsCache.storageKey in changes) invalidateSettingsMemory();
  if (policyCache.storageKey in changes) invalidatePolicyMemory();
});

/** Called on disconnect so a reconnect (maybe to another account) never sees
 * the previous account's cached settings. */
export async function invalidateSettingsCache(): Promise<void> {
  await settingsCache.clear();
  await policyCache.clear();
}

// Single-flight so callers that all find the cache expired at once send one
// request, not a burst that could trip the route's rate limit.
const loadSettings = singleFlight(async (): Promise<UserSettingsDto> => {
  const res = await authedFetch("/api/v1/sync/settings");
  if (!res.ok) {
    throw await buildApiError(res, `failed to fetch settings (${res.status})`);
  }
  const settings: UserSettingsDto = await res.json();
  await settingsCache.store(settings);
  return settings;
});

const loadTabRestorePolicy = singleFlight(async (): Promise<TabRestorePolicy> => {
  const settings = await fetchSettings();
  await policyCache.store(settings.tabRestorePolicy);
  return settings.tabRestorePolicy;
});

export async function fetchSettings(): Promise<UserSettingsDto> {
  const cached = await settingsCache.readFresh();
  if (cached) return cached.value;
  return loadSettings();
}

export async function fetchTabRestorePolicy(): Promise<TabRestorePolicy> {
  const cached = await policyCache.readFresh();
  if (cached) return cached.value;
  return loadTabRestorePolicy();
}

export type UpdateSettingsRequest = Partial<
  Pick<
    UserSettingsDto,
    "syncBookmarks" | "syncHistory" | "syncTabs" | "syncTabGroups" | "syncExtensions" | "tabRestorePolicy" | "historyRetention"
  >
>;

/** Bearer-token requests need no CSRF protection (docs/security.md §2). */
export async function updateSettings(patch: UpdateSettingsRequest): Promise<UserSettingsDto> {
  const res = await authedFetch("/api/v1/sync/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw await buildApiError(res, `failed to update settings (${res.status})`);
  }
  const settings: UserSettingsDto = await res.json();
  await settingsCache.store(settings);
  await policyCache.store(settings.tabRestorePolicy);
  return settings;
}
