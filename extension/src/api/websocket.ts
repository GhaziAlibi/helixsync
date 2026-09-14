// docs/protocol.md §12: a low-latency, notification-only channel — it
// never carries sync payloads, only tells the client "something changed,
// go call the normal download API." Losing this connection never loses
// sync correctness, only the latency win: `background/index.ts`'s
// alarm-driven `runSyncCycle` on its ordinary interval is the sole
// correctness-relevant path and stays completely unconditional whether or
// not this module ever manages to connect.
//
// This deliberately makes no assumption about whether an open WebSocket
// keeps the MV3 service worker alive longer than it otherwise would —
// whatever Chrome's current behavior is, this module doesn't depend on it.
// If the service worker is torn down, this socket and the in-memory
// handles tied to this specific instance (the WebSocket object, the
// setTimeout handle) go with it — those can't be serialized into storage
// and wouldn't mean anything to a fresh instance anyway. The backoff
// bookkeeping itself (`reconnectDelayMs`, `reconnectBlockedUntil`) is
// different and does survive a restart, via chrome.storage.session — see
// the comment above their declarations below. `ensureConnected` is the
// recovery mechanism: it is safe (and cheap — a no-op once connected) to
// call from every wake path a service worker actually has, including the
// existing periodic alarm, so a torn-down connection is always retried
// within one alarm interval at worst — never worse than the pre-WebSocket
// baseline — while still honoring any backoff/rate-limit cooldown that was
// already in progress before the restart, rather than bypassing it.
import { getDevice } from "../storage/db";
import { fetchSettings } from "./client";

type ChangesAvailableHandler = () => void;

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// `socket` and `reconnectTimer` are correctly reset on every service worker
// restart — a WebSocket object and a setTimeout handle are inherently tied
// to this specific worker instance and can't be serialized into storage
// anyway, so there's nothing to persist for either. `reconnectDelayMs` and
// `reconnectBlockedUntil` are different: they're plain numbers, and losing
// them on restart throws away whatever exponential backoff (or server-
// instructed rate-limit cooldown) was accumulated while the server was
// unreachable or throttling us, hammering it at INITIAL_RECONNECT_DELAY_MS
// again. They're kept here as synchronous mirrors (scheduleReconnect below
// needs a number synchronously, to hand to setTimeout, so it can't await a
// storage read at the point it needs the value) backed by
// chrome.storage.session — the storage area that survives a service worker
// restart without ever touching disk. `ensureReconnectDelayHydrated` below
// re-populates both mirrors from storage.session lazily, the first time
// this module is used after a fresh load, so a real restart doesn't just
// silently keep the reset defaults.
//
// `reconnectDelayMs` alone is only a *duration* — "how long to wait next
// time" — which was all a single worker instance ever needed before, since
// it always armed its setTimeout in the same instance it computed the
// value in. But `reconnectTimer` does NOT survive a restart, so
// `ensureConnected` (called from every wake path) has no reliable way to
// tell, from `reconnectDelayMs` alone, whether a previously-armed wait is
// still in progress or already elapsed — a duration says nothing about
// *when* it started counting. `reconnectBlockedUntil` is the absolute
// wall-clock deadline (epoch ms) that answers that instead: `ensureConnected`
// compares it directly against `Date.now()`, so it works correctly no
// matter how much of the wait, if any, already elapsed before the restart.
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let reconnectBlockedUntil = 0;
let changesHandler: ChangesAvailableHandler | undefined;
let disconnectRequested = false;

const RECONNECT_DELAY_STORAGE_KEY = "reconnectDelayMs";
const RECONNECT_BLOCKED_UNTIL_STORAGE_KEY = "reconnectBlockedUntil";

// Shared by every caller so concurrent early callers (e.g. the startup path
// and the periodic alarm both calling `ensureConnected` right after a
// restart) await the same read instead of racing separate ones and
// clobbering each other's hydration.
let reconnectDelayHydration: Promise<void> | undefined;

function ensureReconnectDelayHydrated(): Promise<void> {
  if (!reconnectDelayHydration) {
    reconnectDelayHydration = (async () => {
      // Both keys are read together in one storage.session.get call rather
      // than two separate hydration mechanisms — they're always needed at
      // the same moments (connect(), ensureConnected()) so there's no
      // benefit to hydrating them independently, only extra round trips.
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

/** Updates the sync mirror immediately (so the very next scheduleReconnect
 * call sees it) and write-throughs to storage.session in the background —
 * callers that need the write durable before proceeding (`disconnect`) can
 * await the returned promise; the hot paths (backoff doubling on every
 * reconnect attempt, reset on every successful open) don't need to block on
 * it. */
function setReconnectDelayMs(value: number): Promise<void> {
  reconnectDelayMs = value;
  return chrome.storage.session
    .set({ [RECONNECT_DELAY_STORAGE_KEY]: value })
    .catch(() => {});
}

/** Same mirror + write-through pattern as `setReconnectDelayMs`, for the
 * absolute deadline described above `reconnectBlockedUntil`'s declaration.
 * Called everywhere a reconnect wait gets (re)armed, so the persisted
 * deadline always matches whatever delay is actually driving the in-memory
 * timer. */
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

/** Idempotent — safe to call any time the service worker is awake for any
 * reason (alarm fired, message received, startup) as a "make sure this is
 * still alive" check. Does nothing if already connected, connecting, or a
 * reconnect is already scheduled. */
export async function ensureConnected(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reconnectTimer) return;
  // `reconnectTimer` above is always undefined immediately after a service
  // worker restart, whether or not a backoff/rate-limit cooldown was
  // mid-wait before the restart — it's an in-memory setTimeout handle, not
  // a fact about the world. Hydrate the persisted deadline before deciding
  // whether it's actually safe to connect now, so a restart never bypasses
  // a cooldown the server (or our own backoff) already put us in.
  await ensureReconnectDelayHydrated();
  if (Date.now() < reconnectBlockedUntil) {
    // Still within a previously-set cooldown that outlived the worker
    // instance that set it. Resume it rather than dive into connect(): arm
    // a fresh timer for whatever's left of the deadline. This does not
    // touch reconnectDelayMs/reconnectBlockedUntil themselves — nothing new
    // is being scheduled, an existing wait is just continuing.
    armReconnectTimer(reconnectBlockedUntil - Date.now());
    return;
  }
  await connect();
}

async function connect(): Promise<void> {
  // Must resolve before anything below can reach `scheduleReconnect` (the
  // WebSocket constructor failure path a few lines down, or a later "close"
  // event once `ws` exists), so the backoff mirror reflects whatever was
  // persisted before this restart rather than the just-reset default.
  await ensureReconnectDelayHydrated();

  const device = await getDevice();
  if (!device) return; // not registered yet — nothing to connect to

  disconnectRequested = false;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrlFor(device.serverUrl));
  } catch (e) {
    console.warn("HelixSync: failed to open WebSocket", e);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    void setReconnectDelayMs(INITIAL_RECONNECT_DELAY_MS);
    void setReconnectBlockedUntil(0);
    // docs/protocol.md §12 / docs/security.md §1.3: the device access
    // token is sent as the first text frame after connect rather than a
    // URL query parameter, so it never lands in a reverse proxy's access
    // log the way a query string would.
    ws.send(device.accessToken);
  });

  ws.addEventListener("message", (event) => {
    let msg: unknown;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    const type = (msg as { type?: unknown }).type;
    if (type === "changes_available") {
      changesHandler?.();
    } else if (type === "auth_error") {
      // The token this socket authenticated with (or tried to) is no
      // longer valid — most likely it expired between when it was cached
      // and when this connection attempt sent it. Force the same
      // 401-triggered refresh path `authedFetch` already uses for REST
      // calls; the close handler's reconnect will pick up whatever token
      // `getDevice()` returns next, which is the refreshed one once that
      // finishes.
      fetchSettings().catch(() => {});
      ws.close();
    } else if (type === "rate_limited") {
      // Server hit WEBSOCKET_CONNECT_LIMIT for this device and is about to
      // close us (frame-then-close, same ordering as auth_error above). Bump
      // the backoff mirror to at least its instructed wait — never shrink an
      // already-larger accumulated backoff — so the "close" handler below
      // picks up the right delay for free when it calls scheduleReconnect(),
      // instead of retrying straight back into the same still-active window.
      const retryAfterMs = (msg as { retryAfterMs?: unknown }).retryAfterMs;
      if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
        const bumped = Math.min(Math.max(reconnectDelayMs, retryAfterMs), MAX_RECONNECT_DELAY_MS);
        void setReconnectDelayMs(bumped);
        // The server just told us to wait, starting now — the deadline is a
        // fresh count from this moment, not from whenever the previous
        // (possibly much smaller) backoff was armed.
        void setReconnectBlockedUntil(Date.now() + bumped);
      }
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = undefined;
    if (!disconnectRequested) scheduleReconnect();
  });

  // "close" always fires after "error" for a WebSocket — the actual
  // reconnect scheduling lives there. This listener only exists so a
  // connection failure doesn't surface as an unhandled-error console
  // warning on every retry.
  ws.addEventListener("error", () => {});
}

/** Arms the setTimeout that eventually retries `connect()`, guarded so at
 * most one is ever pending. Shared by `scheduleReconnect` (arming a fresh
 * backoff after a failed attempt within this worker instance, using
 * `reconnectDelayMs`) and `ensureConnected` (resuming a cooldown deadline
 * that was already in progress before a restart, using whatever remains of
 * `reconnectBlockedUntil`) — the two callers differ only in what delay they
 * pass in and what bookkeeping happens around the call, not in how the
 * timer itself gets set. */
function armReconnectTimer(delayMs: number): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect().catch((e) => {
      console.warn("HelixSync: WebSocket reconnect failed", e);
      scheduleReconnect();
    });
  }, Math.max(delayMs, 0));
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  armReconnectTimer(reconnectDelayMs);
  // The deadline mirrors the delay driving the timer just armed above —
  // if this worker instance gets torn down before the timer fires,
  // ensureConnected on the next instance needs to know not to reconnect
  // before this same wait has actually elapsed.
  void setReconnectBlockedUntil(Date.now() + reconnectDelayMs);
  void setReconnectDelayMs(Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS));
}

/** Called on device disconnect so a stale connection (and any pending
 * reconnect timer) doesn't linger against an account this device no
 * longer holds credentials for. Awaits both the delay and deadline resets
 * reaching storage.session (unlike the hot-path callers of
 * `setReconnectDelayMs`/`setReconnectBlockedUntil` above) so a reconnect to
 * a *different* account right after can't possibly still see this
 * account's accumulated backoff or still be blocked by its cooldown. */
export async function disconnect(): Promise<void> {
  disconnectRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  await setReconnectDelayMs(INITIAL_RECONNECT_DELAY_MS);
  await setReconnectBlockedUntil(0);
  socket?.close();
  socket = undefined;
}
