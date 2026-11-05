//! Login with device (docs/protocol.md §7.4, docs/encryption.md §9.2),
//! modeled on Bitwarden's: a dashboard or a new browser asks to sign in
//! without the password, and an already-connected extension approves it.
//!
//! A `reset` request (docs/encryption.md §9.4) resets a forgotten password
//! and needs two different connected extensions to approve; only the second
//! approval carries the account key.
//!
//! A dashboard approval only starts a web session; the dashboard never holds
//! the account key. A new-browser approval also carries the account key,
//! encrypted by the approving extension to the requester's one-time public
//! key, so the server never sees it.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::Json;
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::extractors::{write_web_session_cache_entry, AuthenticatedDevice};
use crate::auth::request_email;
use crate::crypto::{
    generate_opaque_token, hash_password_async, hash_token, token_hash_matches,
    validate_ecdh_public_key,
};
use crate::devices::routes::{
    insert_device, user_agent_from_headers, validate_device_info, validate_device_name,
    validate_kdf_params, validate_kdf_salt, validate_wrapped_key, NewDevice,
};
use crate::error::{AppError, AppResult};
use crate::middleware::client_ip::{client_ip, rate_limit_ip_key};
use crate::middleware::rate_limit::{
    enforce, AUTH_REQUEST_DEVICE_LIMIT, AUTH_REQUEST_EMAIL_LIMIT, AUTH_REQUEST_LIMIT,
    AUTH_REQUEST_POLL_LIMIT, AUTH_REQUEST_RESET_LIMIT,
};
use crate::state::AppState;

use super::routes::{finish_login, validate_request_auth_key};

/// How long a request waits for an answer, as in Bitwarden.
const AUTH_REQUEST_TTL_SECS: i64 = 15 * 60;

/// Upper bound on the encrypted account key an approver sends. A real one
/// (a JSON envelope around a 32-byte key, 24-byte nonce and 16-byte tag, in
/// base64url) is under 200 bytes.
const MAX_ENCRYPTED_ACCOUNT_KEY_LEN: usize = 1024;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum AuthRequestKind {
    Web,
    Device,
    Reset,
}

impl AuthRequestKind {
    fn as_str(self) -> &'static str {
        match self {
            AuthRequestKind::Web => "web",
            AuthRequestKind::Device => "device",
            AuthRequestKind::Reset => "reset",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateAuthRequest {
    email: String,
    kind: AuthRequestKind,
    public_key: String,
    device_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateAuthRequestResponse {
    id: Uuid,
    secret: String,
    expires_at: DateTime<Utc>,
}

/// Starts a request and pings the account's connected extensions. The
/// response carries a secret only the requester holds, needed to collect the
/// answer. An unknown email gets the same response with nothing stored, so
/// this can't be used to find out which emails have accounts (as with
/// `prelogin`); polling it just never leaves `pending`.
pub(crate) async fn create_auth_request(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<CreateAuthRequest>,
) -> AppResult<Json<CreateAuthRequestResponse>> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(
        &state.rate_limiter,
        AUTH_REQUEST_LIMIT,
        &rate_limit_ip_key(ip),
    )?;

    let email = request_email(&req.email)?;
    enforce(&state.rate_limiter, AUTH_REQUEST_EMAIL_LIMIT, &email)?;

    validate_ecdh_public_key(&req.public_key).map_err(|e| AppError::Validation(e.to_string()))?;
    // Only a new browser registers under a name; a dashboard login has none.
    let device_name = match req.kind {
        AuthRequestKind::Device => {
            let name = req
                .device_name
                .ok_or_else(|| AppError::Validation("deviceName is required".into()))?;
            validate_device_name(&name)?;
            Some(name)
        }
        AuthRequestKind::Web | AuthRequestKind::Reset => None,
    };

    let (secret, secret_hash) = generate_opaque_token();
    let expires_at = Utc::now() + Duration::seconds(AUTH_REQUEST_TTL_SECS);

    let user_agent = user_agent_from_headers(&headers);

    let user_id = sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_optional(&state.db)
        .await?;
    let Some(user_id) = user_id else {
        // The same statement and audit write as a real request, but selecting
        // from no user, so nothing is stored and the timing doesn't reveal
        // whether the email exists.
        sqlx::query(
            r#"
            INSERT INTO auth_requests
                (user_id, kind, secret_hash, public_key, device_name, request_ip, user_agent, expires_at)
            SELECT id, $1, $2, $3, $4, $5, $6, $7 FROM users WHERE FALSE
            "#,
        )
        .bind(req.kind.as_str())
        .bind(&secret_hash)
        .bind(&req.public_key)
        .bind(&device_name)
        .bind(ip.to_string())
        .bind(&user_agent)
        .bind(expires_at)
        .execute(&state.db)
        .await?;
        crate::audit::log(&state, None, None, "auth_request_created").await;

        return Ok(Json(CreateAuthRequestResponse {
            id: Uuid::new_v4(),
            secret,
            expires_at,
        }));
    };

    let id = sqlx::query_scalar!(
        r#"
        INSERT INTO auth_requests
            (user_id, kind, secret_hash, public_key, device_name, request_ip, user_agent, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        "#,
        user_id,
        req.kind.as_str(),
        secret_hash,
        req.public_key,
        device_name,
        ip.to_string(),
        user_agent,
        expires_at
    )
    .fetch_one(&state.db)
    .await?;

    state.ws_registry.notify_auth_request(user_id);
    crate::audit::log(&state, Some(user_id), None, "auth_request_created").await;

    Ok(Json(CreateAuthRequestResponse {
        id,
        secret,
        expires_at,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PollAuthRequest {
    secret: String,
    // A new browser's details for its device row. Its name was fixed when
    // the request was created, since that is what the approver saw.
    browser: Option<String>,
    browser_version: Option<String>,
    platform: Option<String>,
    extension_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceApprovalResponse {
    device_id: Uuid,
    access_token: String,
    refresh_token: String,
    access_token_expires_at: DateTime<Utc>,
    api_version: &'static str,
    protocol_version: u32,
    minimum_supported_protocol_version: u32,
    // The account key, encrypted by the approver to the request's public
    // key, and the approver's one-time public key needed to decrypt it.
    encrypted_account_key: String,
    approver_public_key: String,
    account_key_version: i32,
}

fn status_only(status: &str) -> Json<serde_json::Value> {
    Json(json!({ "status": status }))
}

fn approved(body: impl Serialize) -> AppResult<Json<serde_json::Value>> {
    let mut value = serde_json::to_value(body).map_err(|e| AppError::Internal(e.into()))?;
    value["status"] = json!("approved");
    Ok(Json(value))
}

/// Collects the answer. `pending`, `denied` and `expired` are plain
/// statuses; an unknown id or a wrong secret also reads as `pending`. An
/// approval is handed out once, then reads as `expired`: for a dashboard it
/// starts a web session (cookies and CSRF token, like login), for a new
/// browser it registers the device and returns its credentials plus the
/// encrypted account key.
pub(crate) async fn poll_auth_request(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(id): Path<Uuid>,
    Json(req): Json<PollAuthRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(
        &state.rate_limiter,
        AUTH_REQUEST_POLL_LIMIT,
        &rate_limit_ip_key(ip),
    )?;

    let row = sqlx::query!(
        "SELECT kind, secret_hash, status, expires_at, consumed_at FROM auth_requests WHERE id = $1",
        id
    )
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row.filter(|row| token_hash_matches(&req.secret, &row.secret_hash)) else {
        return Ok((jar, status_only("pending")));
    };
    if row.consumed_at.is_some() || row.expires_at <= Utc::now() {
        return Ok((jar, status_only("expired")));
    }
    if row.status != "approved" {
        return Ok((jar, status_only(&row.status)));
    }

    if row.kind == "web" {
        collect_web_approval(&state, jar, headers, id, ip).await
    } else if row.kind == "reset" {
        let body = collect_reset_approval(&state, id).await?;
        Ok((jar, body))
    } else {
        validate_device_info(
            req.browser.as_deref(),
            req.browser_version.as_deref(),
            req.platform.as_deref(),
            req.extension_version.as_deref(),
        )?;
        let body = collect_device_approval(&state, id, req).await?;
        Ok((jar, body))
    }
}

async fn collect_web_approval(
    state: &AppState,
    jar: CookieJar,
    headers: HeaderMap,
    id: Uuid,
    ip: std::net::IpAddr,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    let claimed = sqlx::query!(
        r#"
        UPDATE auth_requests r SET consumed_at = now()
        FROM users u
        WHERE r.id = $1 AND r.user_id = u.id AND r.status = 'approved'
          AND r.consumed_at IS NULL AND r.expires_at > now()
        RETURNING u.id, u.email, u.wrapped_account_key, u.kdf_salt, u.kdf_params, u.account_key_version
        "#,
        id
    )
    .fetch_optional(&state.db)
    .await?;
    let Some(user) = claimed else {
        // Another poll collected it first.
        return Ok((jar, status_only("expired")));
    };

    crate::audit::log(state, Some(user.id), None, "login_with_device_succeeded").await;

    let (jar, Json(auth)) = finish_login(
        state,
        jar,
        headers,
        user.id,
        user.email,
        user.wrapped_account_key,
        user.kdf_salt,
        user.kdf_params,
        user.account_key_version,
        ip,
    )
    .await?;
    Ok((jar, approved(auth)?))
}

/// A reset approval is read without consuming it: the dashboard decrypts the
/// account key, lets the user pick a new password, and `complete_reset`
/// consumes the request. Only an approved request has key material (the
/// second approval sets it).
async fn collect_reset_approval(state: &AppState, id: Uuid) -> AppResult<Json<serde_json::Value>> {
    let row = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        r#"
        SELECT encrypted_account_key, approver_public_key FROM auth_requests
        WHERE id = $1 AND kind = 'reset' AND status = 'approved'
          AND consumed_at IS NULL AND expires_at > now()
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let Some((Some(encrypted_account_key), Some(approver_public_key))) = row else {
        return Ok(status_only("expired"));
    };
    approved(json!({
        "encryptedAccountKey": encrypted_account_key,
        "approverPublicKey": approver_public_key,
    }))
}

async fn collect_device_approval(
    state: &AppState,
    id: Uuid,
    req: PollAuthRequest,
) -> AppResult<Json<serde_json::Value>> {
    // Claiming the approval and registering the device share a transaction,
    // so an account at its device cap keeps the approval collectable once a
    // device is revoked.
    let mut tx = state.db.begin().await?;

    let claimed = sqlx::query!(
        r#"
        UPDATE auth_requests r SET consumed_at = now()
        FROM users u
        WHERE r.id = $1 AND r.user_id = u.id AND r.status = 'approved'
          AND r.consumed_at IS NULL AND r.expires_at > now()
        RETURNING r.user_id, r.device_name, r.encrypted_account_key, r.approver_public_key,
                  u.account_key_version
        "#,
        id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(claimed) = claimed else {
        return Ok(status_only("expired"));
    };
    // All three are set for every device request `respond_auth_request` approved.
    let (Some(device_name), Some(encrypted_account_key), Some(approver_public_key)) = (
        claimed.device_name,
        claimed.encrypted_account_key,
        claimed.approver_public_key,
    ) else {
        return Err(AppError::Internal(anyhow::anyhow!(
            "approved device request {id} is missing its key material"
        )));
    };

    let new_device = NewDevice {
        name: device_name,
        browser: req.browser,
        browser_version: req.browser_version,
        platform: req.platform,
        extension_version: req.extension_version,
    };
    let Some(issued) = insert_device(state, &mut tx, claimed.user_id, new_device).await? else {
        tx.rollback().await?;
        crate::audit::log(
            state,
            Some(claimed.user_id),
            None,
            "device_registration_limit_reached",
        )
        .await;
        return Err(AppError::Conflict("device_limit_reached".into()));
    };

    tx.commit().await?;

    crate::audit::log(
        state,
        Some(claimed.user_id),
        Some(issued.device_id),
        "device_registered",
    )
    .await;
    crate::audit::log(
        state,
        Some(claimed.user_id),
        Some(issued.device_id),
        "login_with_device_succeeded",
    )
    .await;

    approved(DeviceApprovalResponse {
        device_id: issued.device_id,
        access_token: issued.access_token,
        refresh_token: issued.refresh_token,
        access_token_expires_at: issued.access_token_expires_at,
        api_version: "v1",
        protocol_version: state.config.protocol_version,
        minimum_supported_protocol_version: state.config.minimum_supported_protocol_version,
        encrypted_account_key,
        approver_public_key,
        account_key_version: claimed.account_key_version,
    })
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthRequestPublic {
    id: Uuid,
    kind: String,
    public_key: String,
    device_name: Option<String>,
    request_ip: Option<String>,
    user_agent: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    /// Devices that have approved so far (only a `reset` request collects
    /// more than one; it needs two).
    approvals: i64,
}

/// The account's unanswered, unexpired requests, for a connected extension
/// to show. The extension derives each one's fingerprint phrase from
/// `publicKey` and the user compares it with the requester's screen.
pub(crate) async fn list_auth_requests(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<AuthRequestPublic>>> {
    enforce(
        &state.rate_limiter,
        AUTH_REQUEST_DEVICE_LIMIT,
        &device.device_id.to_string(),
    )?;

    // A reset request this device already approved stays hidden from it.
    let requests = sqlx::query_as::<_, AuthRequestPublic>(
        r#"
        SELECT r.id, r.kind, r.public_key, r.device_name, r.request_ip, r.user_agent,
               r.created_at, r.expires_at,
               (SELECT count(*) FROM auth_request_approvals a WHERE a.request_id = r.id) AS approvals
        FROM auth_requests r
        WHERE r.user_id = $1 AND r.status = 'pending' AND r.expires_at > now()
          AND NOT EXISTS (
              SELECT 1 FROM auth_request_approvals a
              WHERE a.request_id = r.id AND a.device_id = $2
          )
        ORDER BY r.created_at DESC
        "#,
    )
    .bind(device.user_id)
    .bind(device.device_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(requests))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RespondAuthRequest {
    approve: bool,
    encrypted_account_key: Option<String>,
    approver_public_key: Option<String>,
}

/// Approves or denies a request on behalf of the account. Approving a new
/// browser must include the account key encrypted to the request's public
/// key; a dashboard approval must not, since the dashboard never holds the
/// account key. `404` once the request is answered or expired.
pub(crate) async fn respond_auth_request(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<RespondAuthRequest>,
) -> AppResult<Json<serde_json::Value>> {
    enforce(
        &state.rate_limiter,
        AUTH_REQUEST_DEVICE_LIMIT,
        &device.device_id.to_string(),
    )?;

    let kind = sqlx::query_scalar!(
        "SELECT kind FROM auth_requests WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now()",
        id,
        device.user_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    if req.approve && kind == "reset" {
        return approve_reset(&state, &device, id, req).await;
    }

    let (encrypted_account_key, approver_public_key) = if req.approve && kind == "device" {
        let (encrypted_account_key, approver_public_key) = require_key_material(
            req.encrypted_account_key,
            req.approver_public_key,
            "approving a new browser",
        )?;
        (Some(encrypted_account_key), Some(approver_public_key))
    } else {
        if req.encrypted_account_key.is_some() || req.approver_public_key.is_some() {
            return Err(AppError::Validation(
                "only an approved new browser receives the account key".into(),
            ));
        }
        (None, None)
    };

    let status = if req.approve { "approved" } else { "denied" };
    let updated = sqlx::query!(
        r#"
        UPDATE auth_requests
        SET status = $1, responded_by_device_id = $2, responded_at = now(),
            encrypted_account_key = $3, approver_public_key = $4
        WHERE id = $5 AND user_id = $6 AND status = 'pending' AND expires_at > now()
        "#,
        status,
        device.device_id,
        encrypted_account_key,
        approver_public_key,
        id,
        device.user_id
    )
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        // Answered by another device, or expired, since the lookup above.
        return Err(AppError::NotFound);
    }

    // The account's other extensions drop the request from their lists.
    state.ws_registry.notify_auth_request(device.user_id);
    crate::audit::log(
        &state,
        Some(device.user_id),
        Some(device.device_id),
        if req.approve {
            "auth_request_approved"
        } else {
            "auth_request_denied"
        },
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}

/// The approver's encrypted account key and one-time public key, both
/// required and well-formed.
fn require_key_material(
    encrypted_account_key: Option<String>,
    approver_public_key: Option<String>,
    what: &str,
) -> AppResult<(String, String)> {
    let (Some(encrypted_account_key), Some(approver_public_key)) =
        (encrypted_account_key, approver_public_key)
    else {
        return Err(AppError::Validation(format!(
            "{what} needs encryptedAccountKey and approverPublicKey"
        )));
    };
    if encrypted_account_key.is_empty()
        || encrypted_account_key.len() > MAX_ENCRYPTED_ACCOUNT_KEY_LEN
    {
        return Err(AppError::Validation("invalid encryptedAccountKey".into()));
    }
    validate_ecdh_public_key(&approver_public_key)
        .map_err(|e| AppError::Validation(e.to_string()))?;
    Ok((encrypted_account_key, approver_public_key))
}

/// Approves a `reset` request. The first device's approval is only recorded
/// and must carry no key material; the request stays `pending`. A second,
/// different device's approval must carry the account key and makes the
/// request `approved`. One device approving twice is a `409`. Locking the
/// request row makes two simultaneous approvals take turns, so exactly one
/// of them is the second.
async fn approve_reset(
    state: &AppState,
    device: &AuthenticatedDevice,
    id: Uuid,
    req: RespondAuthRequest,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;

    let locked = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT id FROM auth_requests
        WHERE id = $1 AND user_id = $2 AND kind = 'reset' AND status = 'pending'
          AND expires_at > now()
        FOR UPDATE
        "#,
    )
    .bind(id)
    .bind(device.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if locked.is_none() {
        return Err(AppError::NotFound);
    }

    let approvers = sqlx::query_scalar::<_, Uuid>(
        "SELECT device_id FROM auth_request_approvals WHERE request_id = $1",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    if approvers.contains(&device.device_id) {
        return Err(AppError::Conflict("already_approved".into()));
    }

    if approvers.is_empty() {
        if req.encrypted_account_key.is_some() || req.approver_public_key.is_some() {
            return Err(AppError::Validation(
                "the first approval of a password reset carries no key".into(),
            ));
        }
        sqlx::query("INSERT INTO auth_request_approvals (request_id, device_id) VALUES ($1, $2)")
            .bind(id)
            .bind(device.device_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        // The approver's other extensions now show "1 of 2" instead.
        state.ws_registry.notify_auth_request(device.user_id);
        crate::audit::log(
            state,
            Some(device.user_id),
            Some(device.device_id),
            "password_reset_first_approval",
        )
        .await;
        return Ok(Json(json!({ "ok": true, "approvals": 1 })));
    }

    let (encrypted_account_key, approver_public_key) = require_key_material(
        req.encrypted_account_key,
        req.approver_public_key,
        "the second approval of a password reset",
    )?;
    sqlx::query("INSERT INTO auth_request_approvals (request_id, device_id) VALUES ($1, $2)")
        .bind(id)
        .bind(device.device_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        UPDATE auth_requests
        SET status = 'approved', responded_by_device_id = $1, responded_at = now(),
            encrypted_account_key = $2, approver_public_key = $3
        WHERE id = $4
        "#,
    )
    .bind(device.device_id)
    .bind(encrypted_account_key)
    .bind(approver_public_key)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    state.ws_registry.notify_auth_request(device.user_id);
    crate::audit::log(
        state,
        Some(device.user_id),
        Some(device.device_id),
        "auth_request_approved",
    )
    .await;
    Ok(Json(json!({ "ok": true, "approvals": 2 })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteResetRequest {
    secret: String,
    new_auth_key: String,
    new_kdf_salt: String,
    new_kdf_params: serde_json::Value,
    new_wrapped_ak: String,
    new_recovery_auth_key: String,
    new_recovery_wrapped_ak: String,
}

/// Finishes a two-device password reset (docs/encryption.md §9.4): the
/// dashboard decrypted the account key from the approval, and wraps it under
/// a new password and a new recovery code. Needs the request's secret, and
/// the request approved, unconsumed, unexpired and approved by two distinct
/// devices that are still active. In one transaction it consumes the request,
/// swaps in the new fields, marks the new recovery code unconfirmed and
/// revokes every web session; device credentials are left alone. An unknown
/// id, a wrong secret and a request that isn't completable are the same `401`.
pub(crate) async fn complete_reset(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<CompleteResetRequest>,
) -> AppResult<axum::http::StatusCode> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(
        &state.rate_limiter,
        AUTH_REQUEST_RESET_LIMIT,
        &rate_limit_ip_key(ip),
    )?;

    validate_request_auth_key(&req.new_auth_key)?;
    validate_request_auth_key(&req.new_recovery_auth_key)?;
    validate_kdf_salt("newKdfSalt", &req.new_kdf_salt)?;
    validate_kdf_params("newKdfParams", &req.new_kdf_params)?;
    validate_wrapped_key("newWrappedAk", &req.new_wrapped_ak)?;
    validate_wrapped_key("newRecoveryWrappedAk", &req.new_recovery_wrapped_ak)?;

    let secret_hash = sqlx::query_scalar::<_, String>(
        "SELECT secret_hash FROM auth_requests WHERE id = $1 AND kind = 'reset'",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    if !secret_hash.is_some_and(|hash| token_hash_matches(&req.secret, &hash)) {
        return Err(AppError::Unauthorized);
    }

    let new_hash = hash_password_async(req.new_auth_key, &state.argon2_semaphore)
        .await
        .map_err(AppError::Internal)?;

    let mut tx = state.db.begin().await?;

    // The single claim: approved, unconsumed, unexpired and two distinct
    // active approving devices, all checked in the statement that consumes it.
    let user_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        UPDATE auth_requests r SET consumed_at = now()
        WHERE r.id = $1 AND r.kind = 'reset' AND r.status = 'approved'
          AND r.consumed_at IS NULL AND r.expires_at > now()
          AND (
              SELECT count(DISTINCT a.device_id)
              FROM auth_request_approvals a
              JOIN devices d ON d.id = a.device_id AND d.revoked_at IS NULL
              WHERE a.request_id = r.id
          ) >= 2
        RETURNING r.user_id
        "#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(user_id) = user_id else {
        return Err(AppError::Unauthorized);
    };

    sqlx::query(
        r#"
        UPDATE users
        SET password_hash = $1, kdf_salt = $2, kdf_params = $3, wrapped_account_key = $4,
            recovery_auth_hash = $5, recovery_wrapped_account_key = $6,
            recovery_code_confirmed_at = NULL, updated_at = now()
        WHERE id = $7
        "#,
    )
    .bind(new_hash)
    .bind(&req.new_kdf_salt)
    .bind(&req.new_kdf_params)
    .bind(&req.new_wrapped_ak)
    .bind(hash_token(&req.new_recovery_auth_key))
    .bind(&req.new_recovery_wrapped_ak)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    let revoked_sessions = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE web_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING session_hash
        "#,
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    // Tombstones, not removals; see `revoke_session`.
    let revoked_at = std::time::Instant::now();
    for session_hash in revoked_sessions {
        write_web_session_cache_entry(&state.web_session_cache, session_hash, revoked_at, None);
    }

    crate::audit::log(&state, Some(user_id), None, "password_reset_by_devices").await;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
