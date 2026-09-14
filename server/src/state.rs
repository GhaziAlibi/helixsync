use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::middleware::rate_limit::RateLimiter;
use crate::websocket::ConnectionRegistry;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub rate_limiter: Arc<RateLimiter>,
    pub ws_registry: Arc<ConnectionRegistry>,
}
