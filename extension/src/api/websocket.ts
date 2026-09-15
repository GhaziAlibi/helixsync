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
import { fetchSettings, invalidateSettingsCache, refreshAccessToken } from "./client";

type ChangesAvailableHandler = () => void;

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
// A close that arrives before the server ever sent "connected" carries no
// information the client can act on: it's indistinguishable from
// WEBSOCKET_HANDSHAKE_LIMIT (server/src/websocket/mod.rs) rejecting the
// upgrade — a plain HTTP 429 with a Retry-After header that the WebSocket
// spec forbids exposing to JS, surfacing here only as an abnormal close
// (code 1006) — from a proxy timeout mid-handshake, or any other failure
// that never got as far as a completed auth handshake. Retrying at
// INITIAL_RECONNECT_DELAY_MS (or whatever small value a fresh attempt
// happens to start from) risks re-tripping the same IP-keyed limit within
// a second or two. This floor is deliberately independent of
// `reconnectDelayMs`'s own doubling — it's a one-time bump applied at the
// moment of an uninformative close, not a new starting point for future
// attempts. It must NOT apply once "connected" was received (see
// `receivedConnected` in `connect()`): a connection that authenticated
// successfully and later dropped is a known-good endpoint having a bad
// moment, not a signal that we're being rate-limited or otherwise
// rejected, so it keeps the existing, less cautious backoff behavior.
const MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS = 15_000;

// Sending a token we already know is expired is a wasted round trip: the
// server rejects it with auth_error, and since `receivedConnected` never
// becomes true for that attempt, the "close" handler below applies
// MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS on top — a 15s lockout for a failure
// that was entirely avoidable by checking the clock first. This margin
// covers the handshake round-trip itself, so a token that's merely
// about-to-expire (not yet expired) when connect() starts doesn't slip
// through and expire mid-handshake.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 5_000;

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

  // Refresh proactively if the cached token is already expired (or expires
  // within the handshake margin above) rather than sending it and letting
  // the server tell us — see TOKEN_EXPIRY_SAFETY_MARGIN_MS's comment. This
  // reuses client.ts's memoized refreshAccessToken, the same one
  // authedFetch's 401 path uses, so a WS-triggered refresh and an
  // HTTP-triggered refresh racing around the same moment share one
  // in-flight request instead of each kicking off their own.
  let accessToken = device.accessToken;
  const expiresAt = new Date(device.accessTokenExpiresAt).getTime();
  if (Date.now() >= expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS) {
    try {
      accessToken = await refreshAccessToken(device.serverUrl);
    } catch (e) {
      // Same fallback as the WebSocket-constructor failure just below:
      // warn and let the normal backoff/reconnect machinery pick this up
      // rather than inventing separate handling for this failure mode —
      // covers a dead refresh token (ReauthRequiredError) the same way it
      // covers any other reason this attempt couldn't proceed.
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

  // Scoped to this connect() call (a fresh `ws` and fresh listeners are
  // created per attempt) rather than hoisted alongside `reconnectDelayMs`,
  // because it answers a question only meaningful for the attempt currently
  // in flight — "did *this* socket ever get authenticated?" — not something
  // that needs to survive a service worker restart the way the backoff
  // bookkeeping does.
  let receivedConnected = false;

  // Scoped identically to `receivedConnected` above (fresh per connect()
  // call) — set true when the "rate_limited" handler below already bumped
  // reconnectDelayMs to the server's instructed value, so the "close"
  // listener knows not to clobber that fine-grained value with the coarser
  // MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS floor meant for an uninformative
  // bare close.
  let wasRateLimited = false;

  ws.addEventListener("open", () => {
    // docs/protocol.md §12 / docs/security.md §1.3: the device access
    // token is sent as the first text frame after connect rather than a
    // URL query parameter, so it never lands in a reverse proxy's access
    // log the way a query string would.
    ws.send(accessToken);
    // Backoff reset does NOT happen here — "open" only means the TCP/TLS
    // handshake finished, not that the server accepted the token just sent
    // above. Resetting this early would let an expired token reset the
    // backoff to its minimum on every single attempt, right before the
    // server rejects it with auth_error below and closes the socket —
    // exponential backoff would never actually grow across repeated auth
    // failures. The reset instead happens on the "connected" case below,
    // which the server only sends once JWT verification actually succeeds.
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
      // Authentication actually succeeded (server sends this only after JWT
      // verification and revocation check pass) — this, not "open" above, is
      // the correct point to consider the backoff cleared.
      void setReconnectDelayMs(INITIAL_RECONNECT_DELAY_MS);
      void setReconnectBlockedUntil(0);
      // Marks this attempt as having gotten past the handshake/auth stage,
      // so the "close" listener below knows NOT to apply
      // MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS if this socket later drops —
      // see that listener and the constant's own comment for why.
      receivedConnected = true;
    } else if (type === "changes_available") {
      changesHandler?.();
    } else if (type === "auth_error") {
      // The token this socket authenticated with (or tried to) is no
      // longer valid — most likely it expired between when it was cached
      // and when this connection attempt sent it. Invalidate the settings
      // cache first: fetchSettings() checks its own TTL cache before ever
      // calling authedFetch, so without this a still-fresh cache entry
      // (settings are fetched often, e.g. on badge updates) would make
      // fetchSettings() a no-op and never trigger authedFetch's 401 →
      // refreshAccessToken() path. The close handler's reconnect will pick
      // up whatever token `getDevice()` returns next, which is the
      // refreshed one once that finishes.
      invalidateSettingsCache()
        .then(() => fetchSettings())
        .catch(() => {});
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
        // Tell the "close" listener below this attempt's close is already
        // explained — don't let it re-raise the delay to
        // MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS on top of what we just set.
        wasRateLimited = true;
      }
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = undefined;
    if (disconnectRequested) return;
    if (!receivedConnected && !wasRateLimited) {
      // This attempt never got a "connected" message — closed by
      // WEBSOCKET_HANDSHAKE_LIMIT before the upgrade completed (invisible to
      // JS as anything but a bare 1006), or some other failure before auth
      // finished. Bump the backoff up to the floor before scheduling —
      // same "never shrink, only raise to at least X" pattern as the
      // rate_limited handler above, so this composes correctly whether
      // reconnectDelayMs is still at its initial value or already larger
      // (e.g. a prior rate_limited bump, or several unauthenticated closes
      // in a row already having raised it past the floor via doubling).
      // Skipped when `wasRateLimited` is true: the rate_limited handler
      // already set reconnectDelayMs to the server's own instructed value,
      // and this floor (meant for an uninformative bare close) would
      // otherwise override that fine-grained value with a much coarser one.
      void setReconnectDelayMs(Math.max(reconnectDelayMs, MIN_UNAUTHENTICATED_CLOSE_BACKOFF_MS));
    }
    scheduleReconnect();
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
