use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::extractors::DEVICE_REVOCATION_CACHE_TTL;
use crate::error::AppError;
use crate::middleware::client_ip::client_ip;
use crate::middleware::rate_limit::{
    enforce, enforce_with_retry_after, WEBSOCKET_CONNECT_LIMIT, WEBSOCKET_HANDSHAKE_LIMIT,
};
use crate::state::AppState;

struct Connection {
    id: u64,
    device_id: Uuid,
    sender: mpsc::Sender<String>,
}

/// Per-user registry of connected WebSocket senders, used to fan out
/// "changes_available" notifications. WebSocket is a notification-only
/// optimization per docs/protocol.md §12 — losing a connection never loses
/// sync correctness, it only delays the client's poll. Because of that, each
/// connection's channel is bounded (see `handle_socket`) and a full channel
/// just drops the notification rather than blocking or growing without
/// limit — a stalled/backpressured socket costs at most a few queued
/// messages, never unbounded memory.
pub struct ConnectionRegistry {
    connections: DashMap<Uuid, Vec<Connection>>,
    next_id: AtomicU64,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
            next_id: AtomicU64::new(0),
        }
    }

    /// Returns a connection id — pass it to `unregister` when the socket
    /// closes. Previously there was no `unregister` at all: a MV3 service
    /// worker reconnects roughly every alarm tick (the worker is torn down
    /// when idle, per docs/protocol.md §12's own extension-side comments),
    /// so every reconnect from a connected-but-idle device left its old,
    /// now-dead sender permanently in this Vec — the only pruning was
    /// `notify_changes`'s `retain`, which only ever runs when that same
    /// user's device *uploads accepted operations*, so a user who only
    /// reads (or one whose peer devices are all quiet) accumulated one
    /// dead entry per reconnect for as long as the process ran.
    pub fn register(
        &self,
        user_id: Uuid,
        device_id: Uuid,
        sender: mpsc::Sender<String>,
    ) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.connections.entry(user_id).or_default().push(Connection {
            id,
            device_id,
            sender,
        });
        id
    }

    /// Removes exactly the one connection `id` identifies, and drops the
    /// user's whole entry once it's empty rather than leaving a
    /// permanently-empty `Vec` behind in the map. `handle_socket` calls this
    /// on every loop exit, including the ping/pong-timeout path — so a
    /// client that vanishes without a clean TCP close (lid closed, NAT
    /// mapping silently dropped, Wi-Fi switch) is still pruned within one
    /// heartbeat timeout instead of leaking for the life of the process.
    pub fn unregister(&self, user_id: Uuid, id: u64) {
        if let Some(mut entry) = self.connections.get_mut(&user_id) {
            entry.retain(|c| c.id != id);
            let now_empty = entry.is_empty();
            drop(entry);
            if now_empty {
                self.connections.remove(&user_id);
            }
        }
    }

    /// Force-closes every open connection belonging to `device_id` under
    /// `user_id` — called from `revoke_device` (server/src/devices/routes.rs)
    /// so a revoked device's live WebSocket doesn't keep receiving
    /// `changes_available` pushes (or sit connected at all) until it happens
    /// to disconnect on its own (ping/pong timeout or the client closing).
    ///
    /// Removing the `Connection` entries here drops their `sender` half of
    /// the mpsc channel. `handle_socket`'s main loop is a `tokio::select!`
    /// with `outgoing = rx.recv()` as one of its arms; once the last sender
    /// for that channel is dropped, `rx.recv()` resolves to `None` — tokio
    /// wakes the receiver as part of the drop, there's no polling delay —
    /// so the task takes the existing `None => break` path on its very next
    /// poll and then runs its own `unregister` call, exactly like any other
    /// close. That means this method only needs to touch the registry's own
    /// bookkeeping; it doesn't need a separate shutdown signal or to close
    /// the socket itself; dropping the sender is what makes the task notice.
    pub fn disconnect_device(&self, user_id: Uuid, device_id: Uuid) {
        if let Some(mut entry) = self.connections.get_mut(&user_id) {
            entry.retain(|c| c.device_id != device_id);
            let now_empty = entry.is_empty();
            drop(entry);
            if now_empty {
                self.connections.remove(&user_id);
            }
        }
    }

    /// `exclude_device_id` skips the originating device's own connection
    /// (if it happens to have one open) — it already knows about the
    /// change it just uploaded, so pushing this back to it was a pure
    /// wasted frame (and, if that device's own logic ever reacted to
    /// pushes by re-fetching, a wasted round trip) on every accepted
    /// upload.
    pub fn notify_changes(&self, user_id: Uuid, cursor: i64, exclude_device_id: Option<Uuid>) {
        if let Some(conns) = self.connections.get(&user_id) {
            let msg = serde_json::to_string(&ChangesAvailable {
                r#type: "changes_available",
                cursor,
            })
            .unwrap_or_default();
            for conn in conns.iter() {
                if Some(conn.device_id) == exclude_device_id {
                    continue;
                }
                // A failed send here means one of two harmless things: either
                // the connection died without its own cleanup task having run
                // `unregister` yet (e.g. the task hasn't been scheduled since
                // the socket closed), in which case that task's own
                // `unregister` call removes this entry for real shortly; or
                // the channel is bounded and legitimately full because the
                // client's socket write is backpressured/stalled, in which
                // case dropping this notification is an intentional trade —
                // it's a coalescable "there are changes, go poll" signal (see
                // the module doc comment), not data, so losing one costs the
                // client nothing beyond a slightly delayed poll. Either way,
                // `try_send` never blocks this synchronous, non-async
                // function.
                let _ = conn.sender.try_send(msg.clone());
            }
        }
    }
}

impl Default for ConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
struct ChangesAvailable {
    r#type: &'static str,
    cursor: i64,
}

/// WebSocket upgrade handler. Per docs/protocol.md §12 and docs/security.md
/// §1.3, authentication is performed via the first text frame sent by the
/// client after connect (a device access token), not via URL query string,
/// to avoid long-lived secrets landing in proxy/access logs. Unauthenticated
/// connections are closed immediately.
///
/// Rate limiting happens in two layers, at two different points, keyed on
/// two different things, because they guard against two different costs:
///
/// - Here, before `ws.on_upgrade` ever runs, `WEBSOCKET_HANDSHAKE_LIMIT` is
///   enforced by client IP. This is the only check that runs before the
///   HTTP 101 upgrade completes, so it's the only one that can reject a
///   connection attempt with a plain HTTP 429 instead of first opening a
///   socket. It has to be IP-keyed because no device claim exists yet at
///   this point — the request hasn't sent (or been asked for) an auth frame
///   — so this is also what bounds raw connection-attempt volume (and the
///   fd/socket exhaustion that comes with it) from a source that may never
///   authenticate at all, e.g. a scanner or a flood of never-authed sockets
///   left open until `handle_socket`'s 10s auth timeout fires.
/// - Inside `handle_socket`, `WEBSOCKET_CONNECT_LIMIT` is enforced by
///   device id, *after* the client's JWT has been verified. This bounds a
///   specific authenticated device's connection churn (reconnect storms,
///   flapping networks, restart loops) rather than raw attempt volume, and
///   it can only run post-auth since the device id it's keyed on comes from
///   the verified claims.
pub async fn ws_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(&state.rate_limiter, WEBSOCKET_HANDSHAKE_LIMIT, &ip.to_string())?;

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state)))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    // Require the first frame to be an auth message within a short deadline.
    let auth_result = tokio::time::timeout(std::time::Duration::from_secs(10), socket.recv()).await;

    let Ok(Some(Ok(Message::Text(token)))) = auth_result else {
        let _ = socket.close().await;
        return;
    };

    let claims = match crate::auth::tokens::verify_device_access_token(
        &state.config.jwt_signing_key,
        token.trim(),
    ) {
        Ok(c) => c,
        Err(_) => {
            let _ = socket
                .send(Message::Text(
                    serde_json::json!({"type": "auth_error"}).to_string(),
                ))
                .await;
            let _ = socket.close().await;
            return;
        }
    };

    // Rate limit first, before touching the database — otherwise a
    // reconnect storm (network flapping, MV3 service-worker restart loops,
    // or malicious rapid connection attempts) burns a DB connection-pool
    // checkout on every attempt before it's even rejected, risking starving
    // ordinary HTTP request traffic of pool connections.
    if let Err(retry_after) = enforce_with_retry_after(
        &state.rate_limiter,
        WEBSOCKET_CONNECT_LIMIT,
        &claims.sub.to_string(),
    ) {
        // Tell the client when the window resets instead of just closing on
        // it — without this, a device that hits the limit (rapid MV3
        // service-worker restarts, network flapping) reconnects straight
        // back into the same still-active window and gets closed again in a
        // tight loop, since it has no way to tell this apart from an
        // ordinary transient close.
        let _ = socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "rate_limited",
                    "retryAfterMs": retry_after.as_millis() as u64,
                })
                .to_string(),
            ))
            .await;
        let _ = socket.close().await;
        return;
    }

    // Confirm the device is not revoked before accepting the connection.
    // Checks `state.device_revocation_cache` first, exactly like
    // `AuthenticatedDevice::from_request_parts` in auth::extractors does for
    // every ordinary HTTP request, instead of paying a DB pool checkout on
    // every single WS handshake (see the module's own rate-limiting comment
    // above for why that matters during a reconnect burst).
    let cached = state
        .device_revocation_cache
        .get(&claims.sub)
        .filter(|entry| entry.0.elapsed() < DEVICE_REVOCATION_CACHE_TTL)
        .map(|entry| entry.1);

    let device_active = match cached {
        Some(active) => active,
        None => {
            let active = sqlx::query_scalar!(
                "SELECT revoked_at IS NULL FROM devices WHERE id = $1 AND user_id = $2",
                claims.sub,
                claims.user_id
            )
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten()
            .unwrap_or(false);

            state
                .device_revocation_cache
                .insert(claims.sub, (Instant::now(), active));

            active
        }
    };

    if !device_active {
        let _ = socket.close().await;
        return;
    }

    // Bounded, not unbounded: `changes_available` is a purely coalescable
    // "go poll" signal (see the module doc comment on `ConnectionRegistry`),
    // so a backpressured/stalled client should drop notifications rather
    // than let them queue without limit. 32 matches `notify_changes`'s
    // `try_send` drop policy on the sending side.
    let (tx, mut rx) = mpsc::channel::<String>(32);
    let conn_id = state.ws_registry.register(claims.user_id, claims.sub, tx);

    let _ = socket
        .send(Message::Text(
            serde_json::json!({"type": "connected"}).to_string(),
        ))
        .await;

    // Heartbeat: without this, a client that disappears without a clean TCP
    // close (laptop lid closed, NAT/firewall silently drops the mapping,
    // Wi-Fi switch) would never trip any of the other branches below —
    // `socket.recv()` simply never returns — and the connection (plus its
    // registry entry) would leak for the life of the process. 30s strikes a
    // balance between detecting a dead peer reasonably quickly and not
    // spamming the connection with pings.
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Not zero at connect time — the client hasn't had a chance to respond
    // to a first ping yet, so treating "no pong received so far" as already
    // stale would kill every connection on its first tick.
    let mut last_pong = Instant::now();
    // A couple of missed pings before giving up, per common heartbeat
    // convention, rather than closing on the very first unanswered ping.
    let pong_timeout = Duration::from_secs(90);

    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        if socket.send(Message::Text(msg)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Pong(_))) => { last_pong = Instant::now(); }
                    _ => {} // ignore other client frames (e.g. Text/Binary) — per protocol this connection never sends any
                }
            }
            _ = ping_interval.tick() => {
                if last_pong.elapsed() > pong_timeout {
                    break;
                }
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    // Every break above (clean close, send failure, recv error/EOF, or a
    // ping-timeout with no pong within `pong_timeout`) ends up here — this
    // is the one place the connection's entry is ever removed from the
    // registry (see `ConnectionRegistry::register`'s and `unregister`'s docs
    // for why that matters).
    state.ws_registry.unregister(claims.user_id, conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors what revoke_device (server/src/devices/routes.rs) triggers,
    // and what handle_socket's own select loop observes on the other end:
    // disconnect_device should both remove the connection from the registry
    // and cause the receiving side's channel to close, since that's the
    // only signal handle_socket's task has to notice it should exit and run
    // its own `unregister`.
    #[tokio::test]
    async fn disconnect_device_drops_sender_and_prunes_registry() {
        let registry = ConnectionRegistry::new();
        let user_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();
        let other_device_id = Uuid::new_v4();

        let (tx, mut rx) = mpsc::channel::<String>(32);
        registry.register(user_id, device_id, tx);

        let (other_tx, mut other_rx) = mpsc::channel::<String>(32);
        registry.register(user_id, other_device_id, other_tx);

        registry.disconnect_device(user_id, device_id);

        // The revoked device's receiver observes the channel closing, which
        // is exactly what makes handle_socket's `outgoing = rx.recv()` arm
        // break out of its loop and unregister.
        assert_eq!(rx.recv().await, None);

        // The other device on the same user wasn't touched — a targeted
        // eviction, not a blunt wipe of every connection for the user.
        registry.notify_changes(user_id, 1, None);
        assert_eq!(other_rx.recv().await.as_deref(), Some(r#"{"type":"changes_available","cursor":1}"#));

        // And the registry's own bookkeeping no longer thinks the revoked
        // device is connected.
        let conns = registry.connections.get(&user_id).unwrap();
        assert!(conns.iter().all(|c| c.device_id != device_id));
    }

    #[tokio::test]
    async fn disconnect_device_is_a_no_op_for_unknown_user_or_device() {
        let registry = ConnectionRegistry::new();
        let user_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();

        let (tx, mut rx) = mpsc::channel::<String>(32);
        registry.register(user_id, device_id, tx);

        // Different user entirely — must not touch anything.
        registry.disconnect_device(Uuid::new_v4(), device_id);
        // Same user, unrelated device id — must not touch anything either.
        registry.disconnect_device(user_id, Uuid::new_v4());

        registry.notify_changes(user_id, 7, None);
        assert_eq!(rx.recv().await.as_deref(), Some(r#"{"type":"changes_available","cursor":7}"#));
    }
}
