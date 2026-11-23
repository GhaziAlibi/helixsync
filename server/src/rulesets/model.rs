use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Largest accepted `envelope`, in bytes of its JSON.
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
/// Rulesets one account may have, Default included.
pub const MAX_RULESETS_PER_ACCOUNT: i64 = 100;
/// Most device ids one assignment request may carry.
pub const MAX_ASSIGNED_DEVICES: usize = 5_000;

/// `GET /rulesets` entry, for the dashboard.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesetEntry {
    pub id: Uuid,
    pub revision: i64,
    pub is_default: bool,
    /// `null` only for a Default nobody has edited yet.
    pub envelope: Option<Value>,
    pub device_ids: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub rulesets: Vec<RulesetEntry>,
}

/// `GET /rulesets/self` entry, for a device.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRuleset {
    pub id: Uuid,
    pub revision: i64,
    pub is_default: bool,
    pub envelope: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct SelfResponse {
    pub rulesets: Vec<DeviceRuleset>,
}

/// A ruleset row as the write routes return it (no device ids).
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RulesetMeta {
    pub id: Uuid,
    pub revision: i64,
    pub is_default: bool,
    pub envelope: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    /// Chosen by the client: the envelope's AAD binds it, so the client has
    /// to know it before encrypting.
    pub id: Uuid,
    pub envelope: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub envelope: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignRequest {
    pub device_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignResponse {
    pub device_ids: Vec<Uuid>,
}

/// Checks that `envelope` is a §6 envelope (docs/encryption.md) of a size we
/// accept. The server never reads the ciphertext; this only rejects things
/// that can't be an envelope, so a broken client can't store garbage that
/// every device would then fail to decrypt.
pub fn validate_envelope(envelope: &Value) -> AppResult<()> {
    let bad = |msg: &str| AppError::Validation(msg.to_string());
    let obj = envelope
        .as_object()
        .ok_or_else(|| bad("envelope must be an object"))?;
    let size = serde_json::to_vec(envelope)
        .map(|v| v.len())
        .unwrap_or(usize::MAX);
    if size > MAX_ENVELOPE_BYTES {
        return Err(bad("envelope is too large"));
    }
    if obj.get("v").and_then(Value::as_i64) != Some(2) {
        return Err(bad("envelope must be version 2"));
    }
    if !obj
        .get("keyVersion")
        .and_then(Value::as_i64)
        .is_some_and(|k| k >= 1)
    {
        return Err(bad("envelope keyVersion is invalid"));
    }
    if obj.get("alg").and_then(Value::as_str) != Some("xchacha20poly1305") {
        return Err(bad("envelope alg is not supported"));
    }
    if !obj
        .get("nonce")
        .and_then(Value::as_str)
        .is_some_and(|n| !n.is_empty())
    {
        return Err(bad("envelope nonce is missing"));
    }
    if !obj
        .get("ciphertext")
        .and_then(Value::as_str)
        .is_some_and(|c| !c.is_empty())
    {
        return Err(bad("envelope ciphertext is missing"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good() -> Value {
        json!({"v":2,"keyVersion":1,"alg":"xchacha20poly1305","nonce":"AAAA","ciphertext":"BBBB"})
    }

    #[test]
    fn accepts_an_envelope() {
        assert!(validate_envelope(&good()).is_ok());
    }

    #[test]
    fn rejects_non_objects_wrong_version_and_missing_fields() {
        assert!(validate_envelope(&json!("x")).is_err());
        assert!(validate_envelope(&json!([1])).is_err());
        let mut e = good();
        e["v"] = json!(1);
        assert!(validate_envelope(&e).is_err());
        for field in ["keyVersion", "alg", "nonce", "ciphertext"] {
            let mut e = good();
            e.as_object_mut().unwrap().remove(field);
            assert!(validate_envelope(&e).is_err(), "{field}");
        }
        let mut e = good();
        e["alg"] = json!("aes");
        assert!(validate_envelope(&e).is_err());
    }

    #[test]
    fn rejects_an_oversized_envelope() {
        let mut e = good();
        e["ciphertext"] = json!("A".repeat(MAX_ENVELOPE_BYTES));
        assert!(validate_envelope(&e).is_err());
    }
}
