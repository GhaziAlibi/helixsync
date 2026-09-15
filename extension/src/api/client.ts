import type {
  DownloadResponse,
  LocalOperation,
  SnapshotResponse,
  UploadResponse,
} from "../sync/types";
import { getDevice, putDevice } from "../storage/db";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    // Seconds to wait before retrying, from the server's `Retry-After`
    // header (server/src/error.rs's `AppError::RateLimited` response) —
    // only ever meaningful when `status === 429`. `undefined` whenever the
    // header is missing or unparseable, never a guessed number: a caller
    // that wants a fallback wait (sync/engine.ts's cooldown) is in a much
    // better position to pick a sane default than this layer is.
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Parses the `Retry-After` header for a 429 response. Per the server side
 * of this (server/src/error.rs), it's always a whole-seconds decimal
 * string, never an HTTP date — but this still guards against a missing or
 * malformed value rather than trusting it blindly, since it ultimately
 * came over the network. */
function parseRetryAfterSeconds(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Builds the `ApiError` to throw for a non-ok `Response`: parses the JSON
 * error body (if any) for a server-supplied message/code, and the
 * `Retry-After` header (if any) for `retryAfterSeconds`. Centralized here
 * rather than duplicated per call site so every `authedFetch`-based call
 * (and registration, below) threads retry-after consistently instead of
 * only some of them remembering to. */
async function buildApiError(res: Response, fallbackMessage: string): Promise<ApiError> {
  const body = await res.json().catch(() => ({}));
  return new ApiError(body.message ?? fallbackMessage, res.status, body.error, parseRetryAfterSeconds(res));
}

/** Thrown by authenticated calls when the access token is rejected and a
 * refresh attempt also fails — the caller should transition to a
 * "needs re-authentication" state per docs/protocol.md §15.6. */
export class ReauthRequiredError extends Error {}

// The server rotates refresh tokens on every use (docs/security.md §1.2):
// presenting one immediately revokes it and issues a new one. `authedFetch`
// is called independently from many places (upload, download, snapshot,
// listDevices, fetchSettings, updateSettings), so it's common for several
// calls to hit a 401 around the same time and each reach for
// `refreshAccessToken` with what they think is the current refresh token.
// Without coordination, the first request to land rotates the token server
// side; every other concurrent request is still holding the now-stale token
// it read earlier and gets rejected, incorrectly bouncing the whole
// extension into `needs_reauth`. Memoizing the in-flight promise here
// ensures only one refresh request is ever in the air at a time and that
// `device.refreshToken` is read exactly once per rotation, with every
// concurrent caller sharing that single outcome instead of racing the
// server with duplicate, mutually-invalidating tokens.
let activeRefreshPromise: Promise<string> | null = null;

export async function refreshAccessToken(serverUrl: string): Promise<string> {
  if (activeRefreshPromise) return activeRefreshPromise;

  activeRefreshPromise = (async () => {
    try {
      const device = await getDevice();
      if (!device) throw new ReauthRequiredError("no device registered");

      const res = await fetch(`${serverUrl}/api/v1/devices/credentials/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: device.refreshToken }),
      });

      if (!res.ok) {
        throw new ReauthRequiredError(`refresh failed with status ${res.status}`);
      }

      const body = await res.json();
      const updated = {
        ...device,
        accessToken: body.accessToken as string,
        refreshToken: body.refreshToken as string,
        accessTokenExpiresAt: body.accessTokenExpiresAt as string,
      };
      await putDevice(updated);
      return updated.accessToken;
    } finally {
      // Cleared whether the refresh succeeded or threw, so a genuinely
      // failed refresh (e.g. an actually-revoked device) doesn't wedge
      // every subsequent call behind one rejected promise forever.
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

/** docs/protocol.md §13/§40: advertised on every device-authenticated
 * request so the server can block writes from a client too old to safely
 * synchronize (426 Upgrade Required) rather than silently corrupting state. */
const PROTOCOL_VERSION = 1;

/** Performs an authenticated request, transparently refreshing the device
 * access token once on a 401 before giving up. */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const device = await getDevice();
  if (!device) throw new ReauthRequiredError("no device registered");

  const doFetch = (token: string) =>
    fetch(`${device.serverUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "X-Protocol-Version": String(PROTOCOL_VERSION),
      },
    });

  let res = await doFetch(device.accessToken);
  if (res.status === 401) {
    // Before rotating the refresh token ourselves, check whether some other
    // concurrently in-flight `authedFetch` call already landed a refresh
    // while we were waiting on our own request — if so, our 401 was caused
    // by presenting the token that refresh just made stale, not by genuine
    // expiry, and reusing the already-fresh token avoids an unnecessary
    // second rotation (see `activeRefreshPromise` comment above for the
    // full race). `getDevice()` is cheap here: it's backed by an in-memory
    // cache that's already been populated by the call above.
    const currentDevice = await getDevice();
    const newToken =
      currentDevice && currentDevice.accessToken !== device.accessToken
        ? currentDevice.accessToken
        : await refreshAccessToken(device.serverUrl);
    res = await doFetch(newToken);
  }
  return res;
}

export interface RegisterDeviceParams {
  serverUrl: string;
  email: string;
  password: string;
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
  // docs/encryption.md §2: per-account salt for deriving the REK from the
  // password (crypto/index.ts::deriveRekFromPassword) — same for every
  // device on the account, so this never needs a device-to-device relay.
  encryptionSalt: string;
}

export async function registerDevice(params: RegisterDeviceParams): Promise<RegisterDeviceResult> {
  const res = await fetch(`${params.serverUrl}/api/v1/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: params.email,
      password: params.password,
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

export interface DevicePublicDto {
  id: string;
  name: string;
  revokedAt: string | null;
}

export async function listDevices(): Promise<DevicePublicDto[]> {
  const res = await authedFetch("/api/v1/devices");
  if (!res.ok) {
    throw await buildApiError(res, `failed to list devices (${res.status})`);
  }
  return res.json();
}

export async function uploadOperations(operations: LocalOperation[]): Promise<UploadResponse> {
  const res = await authedFetch("/api/v1/sync/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operations }),
  });
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

// `fetchSettings` is called on essentially every remote tab/window/group
// operation applied during sync (tabs/index.ts::restorePolicy) as well as
// once per periodic badge update (background/index.ts::updateBadge) — with
// no cache, a single download page of a few hundred tab operations turned
// into a few hundred sequential HTTPS round trips (each itself two DB
// queries server-side: device auth + settings lookup) on an endpoint that,
// unlike the sync routes, has no rate limit. Settings rarely change and
// are never required to be instantaneously fresh (tabRestorePolicy already
// fails closed to "disabled" on any fetch error), so a short TTL cache is
// enough to collapse that into one request per cache window while still
// picking up changes made from another device/the web dashboard within a
// minute.
const SETTINGS_CACHE_TTL_MS = 60_000;

// A plain module-level `let` here is wiped by Chrome tearing down this MV3
// service worker after ~30s idle — which happens well inside the 1-minute
// sync alarm interval (background/index.ts SYNC_INTERVAL_MINUTES), so the
// cache would be reset before almost every alarm tick and a "60s TTL" cache
// would in practice re-fetch on nearly every use, defeating the point.
// chrome.storage.session is the storage area that specifically survives a
// service worker restart (for the life of the browser session) while still
// living in memory only — no disk write, unlike chrome.storage.local, which
// would needlessly outlive the 60s TTL this cache is supposed to have.
const SETTINGS_CACHE_STORAGE_KEY = "settingsCache";

interface SettingsCacheEntry {
  value: UserSettingsDto;
  expiresAt: number;
}

// Even with the TTL cache above living in chrome.storage.session so it
// survives a service worker restart, `readSettingsCache` was still paying
// for a `chrome.storage.session.get` IPC round trip (extension process ->
// browser process and back) on every single call — including the hundreds
// of restorePolicy() calls per download batch (tabs/index.ts) that all land
// within the same TTL window and would all resolve to the exact same
// value. Mirroring the entry in a plain module-level variable, the same
// pattern storage/db.ts's `getDevice` uses for the "device" record, turns
// every one of those repeat calls into a synchronous lookup and leaves only
// the first call per service-worker lifetime (or the call right after an
// invalidation) paying for the IPC. `settingsCacheLoaded` is tracked
// separately from `memorySettingsCache` because `undefined` is itself a
// valid loaded state (no cached entry / just invalidated) and must be
// distinguished from "haven't checked chrome.storage.session yet" — without
// it, every read after an invalidation would look like a cold start and
// re-pay for the IPC on every call instead of just the next one.
let memorySettingsCache: SettingsCacheEntry | undefined;
let settingsCacheLoaded = false;

async function readSettingsCache(): Promise<SettingsCacheEntry | undefined> {
  if (settingsCacheLoaded) return memorySettingsCache;

  const stored = await chrome.storage.session.get(SETTINGS_CACHE_STORAGE_KEY);
  memorySettingsCache = stored[SETTINGS_CACHE_STORAGE_KEY] as SettingsCacheEntry | undefined;
  settingsCacheLoaded = true;
  return memorySettingsCache;
}

async function writeSettingsCache(entry: SettingsCacheEntry | undefined): Promise<void> {
  memorySettingsCache = entry;
  settingsCacheLoaded = true;
  if (entry) {
    await chrome.storage.session.set({ [SETTINGS_CACHE_STORAGE_KEY]: entry });
  } else {
    await chrome.storage.session.remove(SETTINGS_CACHE_STORAGE_KEY);
  }
}

/** Called on device disconnect so a subsequent reconnect (possibly to a
 * different account or server) never serves another account's cached
 * settings for up to `SETTINGS_CACHE_TTL_MS`. */
export async function invalidateSettingsCache(): Promise<void> {
  await writeSettingsCache(undefined);
}

// Once the cache above expires, every independent caller (restorePolicy per
// tab/window/group op, updateBadge, the popup) reads the same stale entry
// and, without coordination, would each kick off its own GET to
// `/api/v1/sync/settings` before any of them has written the refreshed
// cache back — a burst that can blow through this route's own
// `SYNC_SETTINGS_LIMIT` rate limit on a single download batch and turn into
// spurious 429s (which restorePolicy fails closed on). Memoizing the
// in-flight promise here ensures only one refresh is ever in the air past
// TTL expiry, with every concurrent caller sharing that single outcome
// instead of racing the server with duplicate requests.
let inFlightSettingsPromise: Promise<UserSettingsDto> | null = null;

export async function fetchSettings(): Promise<UserSettingsDto> {
  const cached = await readSettingsCache();
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  if (inFlightSettingsPromise) return inFlightSettingsPromise;

  inFlightSettingsPromise = (async () => {
    try {
      const res = await authedFetch("/api/v1/sync/settings");
      if (!res.ok) {
        throw await buildApiError(res, `failed to fetch settings (${res.status})`);
      }
      const settings: UserSettingsDto = await res.json();
      await writeSettingsCache({ value: settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
      return settings;
    } finally {
      // Cleared whether the fetch succeeded or threw, so a genuinely failed
      // fetch doesn't wedge every subsequent call behind one rejected
      // promise forever.
      inFlightSettingsPromise = null;
    }
  })();
  return inFlightSettingsPromise;
}

export type UpdateSettingsRequest = Partial<
  Pick<
    UserSettingsDto,
    "syncBookmarks" | "syncHistory" | "syncTabs" | "syncTabGroups" | "syncExtensions" | "tabRestorePolicy" | "historyRetention"
  >
>;

/** Device bearer tokens don't need CSRF protection (docs/security.md §2),
 * so the extension can call this directly — see
 * server/src/auth/extractors.rs `AnyAuthorizedMutator`. */
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
  await writeSettingsCache({ value: settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return settings;
}

