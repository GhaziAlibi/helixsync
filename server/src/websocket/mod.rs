use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use chrono::Utc;
use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::extractors::{cached_device_active, write_device_revocation_cache_entry};
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

/// Connected websocket senders per user, used to push "changes_available".
/// Websocket is only a hint (docs/protocol.md §12); clients still poll.
/// So channels are bounded and a full channel just drops the message.
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

    /// Returns a connection id. Pass it to `unregister` when the socket closes.
    pub fn register(&self, user_id: Uuid, device_id: Uuid, sender: mpsc::Sender<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut entry = self.connections.entry(user_id).or_default();
        // Drop any old connection for this device first. Dropping its
        // sender makes the old task exit and unregister itself.
        // Other devices of the same user are not touched.
        entry.retain(|c| c.device_id != device_id);
        entry.push(Connection {
            id,
            device_id,
            sender,
        });
        id
    }

    /// Removes connection `id`, and the user's entry once it's empty.
    /// Called on every exit from `handle_socket`, including ping timeouts.
    pub fn unregister(&self, user_id: Uuid, id: u64) {
        self.remove_connections(user_id, |c| c.id == id);
    }

    /// Closes all connections for `device_id`. Called from `revoke_device`.
    ///
    /// Dropping the sender makes `rx.recv()` return `None` in
    /// `handle_socket`, which then exits and unregisters. No other signal
    /// is needed.
    pub fn disconnect_device(&self, user_id: Uuid, device_id: Uuid) {
        self.remove_connections(user_id, |c| c.device_id == device_id);
    }

    /// Removes the user's connections matching `matches`, and the user's
    /// entry once it's empty.
    fn remove_connections(&self, user_id: Uuid, matches: impl Fn(&Connection) -> bool) {
        if let Some(mut entry) = self.connections.get_mut(&user_id) {
            entry.retain(|c| !matches(c));
            let now_empty = entry.is_empty();
            drop(entry);
            if now_empty {
                // A fast reconnect may have added a new connection since we
                // dropped the guard. `remove_if` only removes if still empty.
                self.connections.remove_if(&user_id, |_, v| v.is_empty());
            }
        }
    }

    /// `exclude_device_id` skips the device that uploaded; it already knows.
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
                // Send can fail if the connection is closing (its task will
                // unregister it) or the channel is full (fine, it's only a
                // "go poll" hint). `try_send` never blocks.
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

/// Websocket upgrade handler. The client authenticates with its first text
/// frame (a device access token), not the URL, so tokens stay out of logs
/// (docs/protocol.md §12, docs/security.md §1.3).
///
/// Two rate limits:
/// - Here, per IP, before the upgrade (no device known yet). Limits raw
///   connection attempts with a plain 429.
/// - In `handle_socket`, per device, after auth. Limits reconnect storms.
pub async fn ws_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(
        &state.rate_limiter,
        WEBSOCKET_HANDSHAKE_LIMIT,
        &ip.to_string(),
    )?;

    // Clients only send the auth frame and pongs, so cap frame sizes well
    // below tungstenite's defaults (64 MiB) to reject big frames early.
    let ws = ws.max_message_size(64 * 1024).max_frame_size(16 * 1024);

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state)))
}

/// Checks if the device is active, using `device_revocation_cache` first
/// and the DB on a miss (same as `AuthenticatedDevice`). Used at connect
/// time and on every ping.
///
/// Returns `None` if the DB query failed, which is not the same as
/// `Some(false)` (revoked). On `None` the cache is left alone, so a DB blip
/// doesn't lock the device out of HTTP too.
async fn device_active_status(state: &AppState, device_id: Uuid, user_id: Uuid) -> Option<bool> {
    if let Some(active) = cached_device_active(&state.device_revocation_cache, device_id) {
        return Some(active);
    }

    // Taken before the DB query so a racing revocation always wins.
    let read_started_at = Instant::now();

    match sqlx::query_scalar!(
        "SELECT revoked_at IS NULL FROM devices WHERE id = $1 AND user_id = $2",
        device_id,
        user_id
    )
    .fetch_optional(&state.db)
    .await
    {
        Ok(row) => {
            let active = row.flatten().unwrap_or(false);
            write_device_revocation_cache_entry(
                &state.device_revocation_cache,
                device_id,
                read_started_at,
                active,
            );
            Some(active)
        }
        // Don't touch the cache on a DB error; see the doc comment.
        Err(_) => None,
    }
}

/// Connect-time check. A DB error rejects the connection but leaves the
/// cache alone.
async fn device_is_active(state: &AppState, device_id: Uuid, user_id: Uuid) -> bool {
    device_active_status(state, device_id, user_id)
        .await
        .unwrap_or(false)
}

/// `socket.send` with a timeout. A client that stops reading could
/// otherwise block this task forever. A timeout is treated like a send error.
async fn send_with_timeout(
    socket: &mut WebSocket,
    msg: Message,
    timeout: Duration,
) -> Result<(), ()> {
    match tokio::time::timeout(timeout, socket.send(msg)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) | Err(_) => Err(()),
    }
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let send_timeout = Duration::from_secs(state.config.websocket_send_timeout_secs);

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
            let _ = send_with_timeout(
                &mut socket,
                Message::Text(serde_json::json!({"type": "auth_error"}).to_string()),
                send_timeout,
            )
            .await;
            let _ = socket.close().await;
            return;
        }
    };

    // Rate limit before touching the DB, so reconnect storms don't use up
    // pool connections.
    if let Err(retry_after) = enforce_with_retry_after(
        &state.rate_limiter,
        WEBSOCKET_CONNECT_LIMIT,
        &claims.sub.to_string(),
    ) {
        // Tell the client when to retry, so it doesn't reconnect in a loop.
        let _ = send_with_timeout(
            &mut socket,
            Message::Text(
                serde_json::json!({
                    "type": "rate_limited",
                    "retryAfterMs": retry_after.as_millis() as u64,
                })
                .to_string(),
            ),
            send_timeout,
        )
        .await;
        let _ = socket.close().await;
        return;
    }

    // Make sure the device isn't revoked (cache first, like HTTP auth).
    if !device_is_active(&state, claims.sub, claims.user_id).await {
        let _ = socket.close().await;
        return;
    }

    // Bounded: messages are just "go poll" hints, so drop them if the client
    // is slow.
    let (tx, mut rx) = mpsc::channel::<String>(32);
    let conn_id = state.ws_registry.register(claims.user_id, claims.sub, tx);

    let _ = send_with_timeout(
        &mut socket,
        Message::Text(serde_json::json!({"type": "connected"}).to_string()),
        send_timeout,
    )
    .await;

    // Heartbeat, so clients that vanish without closing (sleep, NAT drop)
    // are detected and cleaned up.
    let mut ping_interval = tokio::time::interval(Duration::from_secs(
        state.config.websocket_ping_interval_secs,
    ));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Start at now, so the first tick doesn't close a fresh connection.
    let mut last_pong = Instant::now();
    // Allow a couple of missed pongs before closing.
    let pong_timeout = Duration::from_secs(90);

    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        if send_with_timeout(&mut socket, Message::Text(msg), send_timeout)
                            .await
                            .is_err()
                        {
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
                    Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                        // Clients shouldn't send data after auth. Close the
                        // connection.
                        let _ = socket.close().await;
                        break;
                    }
                    Some(Ok(Message::Ping(_))) => {} // axum answers Pings automatically
                }
            }
            _ = ping_interval.tick() => {
                if last_pong.elapsed() > pong_timeout {
                    break;
                }
                // On every tick, re-check token expiry and revocation so an
                // open socket stops getting pushes once the device loses
                // access. `claims.exp` was verified at connect, so a
                // timestamp compare is enough.
                let token_expired = claims.exp <= Utc::now().timestamp();
                // `None` means the DB query failed, not that the device is
                // revoked. Keep the socket and try again next tick.
                let revoked = match device_active_status(&state, claims.sub, claims.user_id).await
                {
                    Some(active) => !active,
                    None => false,
                };
                if token_expired || revoked {
                    let _ = send_with_timeout(
                        &mut socket,
                        Message::Text(
                            serde_json::json!({"type": "session_expired"}).to_string(),
                        ),
                        send_timeout,
                    )
                    .await;
                    let _ = socket.close().await;
                    break;
                }
                if send_with_timeout(&mut socket, Message::Ping(Vec::new()), send_timeout)
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }

    // Every exit from the loop ends here, so this is where we unregister.
    state.ws_registry.unregister(claims.user_id, conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Like `revoke_device`: the connection is removed and its channel
    // closes, which is what makes `handle_socket` exit.
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

        // The channel closed, so `handle_socket` would exit.
        assert_eq!(rx.recv().await, None);

        // The user's other device is untouched.
        registry.notify_changes(user_id, 1, None);
        assert_eq!(
            other_rx.recv().await.as_deref(),
            Some(r#"{"type":"changes_available","cursor":1}"#)
        );

        // The registry no longer lists the revoked device.
        let conns = registry.connections.get(&user_id).unwrap();
        assert!(conns.iter().all(|c| c.device_id != device_id));
    }

    // A reconnect for the same device must replace the old connection.
    #[tokio::test]
    async fn register_evicts_stale_connection_for_same_device() {
        let registry = ConnectionRegistry::new();
        let user_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();
        let other_device_id = Uuid::new_v4();

        let (tx, mut rx) = mpsc::channel::<String>(32);
        registry.register(user_id, device_id, tx);

        let (other_tx, mut other_rx) = mpsc::channel::<String>(32);
        registry.register(user_id, other_device_id, other_tx);

        let (new_tx, mut new_rx) = mpsc::channel::<String>(32);
        registry.register(user_id, device_id, new_tx);

        // The old channel closed, so its `handle_socket` would exit.
        assert_eq!(rx.recv().await, None);

        // Only the new connection gets notifications.
        registry.notify_changes(user_id, 1, None);
        assert_eq!(
            new_rx.recv().await.as_deref(),
            Some(r#"{"type":"changes_available","cursor":1}"#)
        );

        // The user's other device is untouched.
        assert_eq!(
            other_rx.recv().await.as_deref(),
            Some(r#"{"type":"changes_available","cursor":1}"#)
        );
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
        assert_eq!(
            rx.recv().await.as_deref(),
            Some(r#"{"type":"changes_available","cursor":7}"#)
        );
    }
}
