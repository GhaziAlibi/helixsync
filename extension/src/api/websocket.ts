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
// If the service worker is torn down, this socket and all its in-memory
// reconnect/backoff state go with it; there is nothing here that persists
// across a restart. `ensureConnected` is the recovery mechanism instead: it
// is safe (and cheap — a no-op once connected) to call from every wake
// path a service worker actually has, including the existing periodic
// alarm, so a torn-down connection is always retried within one alarm
// interval at worst — never worse than the pre-WebSocket baseline.
import { getDevice } from "../storage/db";
import { fetchSettings } from "./client";

type ChangesAvailableHandler = () => void;

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let changesHandler: ChangesAvailableHandler | undefined;
let disconnectRequested = false;

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
  await connect();
}

async function connect(): Promise<void> {
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
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
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

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect().catch((e) => {
      console.warn("HelixSync: WebSocket reconnect failed", e);
      scheduleReconnect();
    });
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

/** Called on device disconnect so a stale connection (and any pending
 * reconnect timer) doesn't linger against an account this device no
 * longer holds credentials for. */
export function disconnect(): void {
  disconnectRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  socket?.close();
  socket = undefined;
}
