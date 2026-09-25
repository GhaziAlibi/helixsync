// docs/protocol.md §12: a notification-only push channel. It never carries
// sync data, only "something changed, download now", so losing it costs
// latency, never correctness: the periodic alarm's sync cycle still runs
// either way.
//
// The socket and timers die with the MV3 service worker, but the backoff
// state is persisted to chrome.storage.session so a restart doesn't bypass
// a cooldown. `ensureConnected` is cheap and idempotent, so every wake path
// (including the alarm) calls it to reconnect.
import { getDevice } from "../storage/db";
import { fetchSettings, invalidateSettingsCache, refreshAccessToken } from "./client";

type ChangesAvailableHandler = () => void;

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
// A pending setTimeout keeps the service worker awake for its whole delay.
// Longer waits are left to the periodic alarm, which calls ensureConnected.
const SHORT_RECONNECT_HOLD_MS = 30_000;
// A close before the server's "connected" frame carries no usable reason: a
// handshake rate-limit 429 surfaces to JS only as a bare 1006 close. Raising
// the backoff to this floor avoids re-tripping that IP-keyed limit. It never
// applies after "connected": that endpoint is known-good and just dropped.
const MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS = 15_000;

// Sending an already-expired token is a guaranteed auth_error plus the
// unauthenticated-close backoff above. Refresh first if the token expires
// within this margin, which also covers the handshake round trip.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 5_000;

let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
// Synchronous mirrors of the persisted backoff (setTimeout needs a number
// synchronously). `reconnectBlockedUntil` is an absolute deadline because a
// delay alone can't tell a fresh worker how much of the wait already passed.
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let reconnectBlockedUntil = 0;
let changesHandler: ChangesAvailableHandler | undefined;
let disconnectRequested = false;

const RECONNECT_DELAY_STORAGE_KEY = "reconnectDelayMs";
const RECONNECT_BLOCKED_UNTIL_STORAGE_KEY = "reconnectBlockedUntil";

// Shared so concurrent early callers await one read instead of racing.
let reconnectDelayHydration: Promise<void> | undefined;

function ensureReconnectDelayHydrated(): Promise<void> {
  if (!reconnectDelayHydration) {
    reconnectDelayHydration = (async () => {
      const stored = await chrome.storage.session.get([
        RECONNECT_DELAY_STORAGE_KEY,
        RECONNECT_BLOCKED_UNTIL_STORAGE_KEY,
      ]);
      const delay = stored[RECONNECT_DELAY_STORAGE_KEY];
      if (typeof delay === "number") reconnectDelayMs = delay;
      const blockedUntil = stored[RECONNECT_BLOCKED_UNTIL_STORAGE_KEY];
      if (typeof blockedUntil === "number") reconnectBlockedUntil = blockedUntil;
    })();
  }
  return reconnectDelayHydration;
}

/** Updates the mirror immediately and writes through in the background;
 * only `disconnect` needs to await the write. */
function setReconnectDelayMs(value: number): Promise<void> {
  reconnectDelayMs = value;
  return chrome.storage.session
    .set({ [RECONNECT_DELAY_STORAGE_KEY]: value })
    .catch(() => {});
}

function setReconnectBlockedUntil(value: number): Promise<void> {
  reconnectBlockedUntil = value;
  return chrome.storage.session
    .set({ [RECONNECT_BLOCKED_UNTIL_STORAGE_KEY]: value })
    .catch(() => {});
}

export function onChangesAvailable(handler: ChangesAvailableHandler): void {
  changesHandler = handler;
}

function wsUrlFor(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/ws`;
  url.search = "";
  return url.toString();
}

/** Safe to call from any wake path. No-op when already connected,
 * connecting, or a reconnect is scheduled; concurrent callers share one
 * attempt so the server's per-device connection limit isn't doubled. */
let connectPromise: Promise<void> | undefined;
export async function ensureConnected(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (connectPromise) return connectPromise;
  if (reconnectTimer) return;
  // reconnectTimer is always unset after a worker restart, so check the
  // persisted deadline before connecting.
  await ensureReconnectDelayHydrated();
  if (Date.now() < reconnectBlockedUntil) {
    // Resume a cooldown that outlived the worker that set it. Long remainders
    // are left for the alarm to resume.
    if (reconnectBlockedUntil - Date.now() <= SHORT_RECONNECT_HOLD_MS) {
      armReconnectTimer(reconnectBlockedUntil - Date.now());
    }
    return;
  }
  connectPromise = startConnect();
  return connectPromise;
}

/** Unexpected throws become a warning plus backoff. Expected failures
 * schedule their own reconnect inside `connect()` and return normally, so
 * this can't double-schedule. */
function startConnect(): Promise<void> {
  if (!connectPromise) {
    connectPromise = connect()
      .catch((e) => {
        console.warn("HelixSync: WebSocket reconnect failed", e);
        scheduleReconnect();
      })
      .finally(() => {
        connectPromise = undefined;
      });
  }
  return connectPromise;
}

async function connect(): Promise<void> {
  // Must finish before anything can reach scheduleReconnect, so the backoff
  // reflects what was persisted before a restart.
  await ensureReconnectDelayHydrated();

  const device = await getDevice();
  if (!device) return;

  disconnectRequested = false;

  // Shares client.ts's single-flight refresh, so a WS-triggered and an
  // HTTP-triggered refresh never rotate the token twice.
  let accessToken = device.accessToken;
  const expiresAt = new Date(device.accessTokenExpiresAt).getTime();
  if (Date.now() >= expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS) {
    try {
      accessToken = await refreshAccessToken(device.serverUrl);
    } catch (e) {
      console.warn("HelixSync: failed to refresh access token before WebSocket connect", e);
      scheduleReconnect();
      return;
    }
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrlFor(device.serverUrl));
  } catch (e) {
    console.warn("HelixSync: failed to open WebSocket", e);
    scheduleReconnect();
    return;
  }
  socket = ws;

  // Per-attempt: whether this socket ever authenticated, and whether the
  // server already set an exact backoff via "rate_limited".
  let receivedConnected = false;
  let wasRateLimited = false;

  ws.addEventListener("open", () => {
    // docs/security.md §1.3: the token goes in the first frame, not the URL,
    // so it never lands in a proxy access log. Backoff is not reset here:
    // "open" only means TLS finished, not that the token was accepted.
    ws.send(accessToken);
  });

  ws.addEventListener("message", (event) => {
    let msg: unknown;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    const type = (msg as { type?: unknown }).type;
    if (type === "connected") {
      // Sent only after the server verified the token.
      void setReconnectDelayMs(INITIAL_RECONNECT_DELAY_MS);
      void setReconnectBlockedUntil(0);
      receivedConnected = true;
    } else if (type === "changes_available") {
      changesHandler?.();
    } else if (type === "auth_error") {
      // The token is likely stale. fetchSettings would be served from its
      // cache and never hit the 401 -> refresh path, so clear the cache
      // first; the reconnect then picks up the refreshed token.
      invalidateSettingsCache()
        .then(() => fetchSettings())
        .catch(() => {});
      ws.close();
    } else if (type === "rate_limited") {
      // The server is about to close us. Raise (never shrink) the backoff to
      // its instructed wait, counted from now.
      const retryAfterMs = (msg as { retryAfterMs?: unknown }).retryAfterMs;
      if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
        const bumped = Math.min(Math.max(reconnectDelayMs, retryAfterMs), MAX_RECONNECT_DELAY_MS);
        void setReconnectDelayMs(bumped);
        void setReconnectBlockedUntil(Date.now() + bumped);
        wasRateLimited = true;
      }
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = undefined;
    if (disconnectRequested) return;
    if (!receivedConnected && !wasRateLimited) {
      void setReconnectDelayMs(Math.max(reconnectDelayMs, MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS));
    }
    scheduleReconnect();
  });

  // "close" always follows "error" and handles reconnecting; this listener
  // only prevents an unhandled-error warning on every retry.
  ws.addEventListener("error", () => {});
}

/** At most one reconnect timer is ever pending. */
function armReconnectTimer(delayMs: number): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void startConnect();
  }, Math.max(delayMs, 0));
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  // Snapshot once so the persisted deadline and the armed timer agree.
  const delay = reconnectDelayMs;
  // Persisted first, unjittered, so a restart still honors the backoff even
  // when no timer is armed below.
  void setReconnectBlockedUntil(Date.now() + delay);
  void setReconnectDelayMs(Math.min(delay * 2, MAX_RECONNECT_DELAY_MS));
  if (delay > SHORT_RECONNECT_HOLD_MS) return;
  // Jitter in [0.5x, 1x) so devices dropped by the same server event don't
  // retry in lockstep and re-trip the handshake limit together.
  armReconnectTimer(delay * (0.5 + Math.random() * 0.5));
}

/** Synchronous so the sync engine can decide to skip an idle download poll
 * without awaiting storage. */
export function isConnected(): boolean {
  return !!socket && socket.readyState === WebSocket.OPEN;
}

/** Called on device disconnect. Awaits the backoff reset so a reconnect to
 * a different account can't inherit this account's cooldown. */
export async function disconnect(): Promise<void> {
  disconnectRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  connectPromise = undefined;
  await setReconnectDelayMs(INITIAL_RECONNECT_DELAY_MS);
  await setReconnectBlockedUntil(0);
  socket?.close();
  socket = undefined;
}
