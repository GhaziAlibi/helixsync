use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::AppError;
use crate::middleware::rate_limit::{enforce_with_retry_after, WEBSOCKET_CONNECT_LIMIT};
use crate::state::AppState;

struct Connection {
    id: u64,
    device_id: Uuid,
    sender: mpsc::UnboundedSender<String>,
}

/// Per-user registry of connected WebSocket senders, used to fan out
/// "changes_available" notifications. WebSocket is a notification-only
/// optimization per docs/protocol.md §12 — losing a connection never loses
/// sync correctness, it only delays the client's poll.
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
        sender: mpsc::UnboundedSender<String>,
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
    /// permanently-empty `Vec` behind in the map.
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
                // A send failure here means the connection died without
                // its own cleanup task having run `unregister` yet (e.g.
                // the task hasn't been scheduled since the socket closed)
                // — harmless to ignore: that task's own `unregister` call
                // removes this entry for real shortly, and until then a
                // failed send costs nothing further.
                let _ = conn.sender.send(msg.clone());
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
pub async fn ws_handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
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
    let device_active = sqlx::query_scalar!(
        "SELECT revoked_at IS NULL FROM devices WHERE id = $1",
        claims.sub
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or(Some(false))
    .unwrap_or(false);

    if !device_active {
        let _ = socket.close().await;
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn_id = state.ws_registry.register(claims.user_id, claims.sub, tx);

    let _ = socket
        .send(Message::Text(
            serde_json::json!({"type": "connected"}).to_string(),
        ))
        .await;

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
                    _ => {} // ignore other client frames; this channel is server->client notification only
                }
            }
        }
    }

    // Every break above (clean close, send failure, recv error/EOF) ends up
    // here — this is the one place the connection's entry is ever removed
    // from the registry (see `ConnectionRegistry::register`'s docs for why
    // that matters).
    state.ws_registry.unregister(claims.user_id, conn_id);
}
