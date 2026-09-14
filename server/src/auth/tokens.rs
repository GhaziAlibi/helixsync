use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceAccessClaims {
    pub sub: Uuid, // device_id
    pub user_id: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub typ: String, // always "device_access"
}

pub fn issue_device_access_token(
    signing_key: &[u8],
    device_id: Uuid,
    user_id: Uuid,
    ttl_secs: i64,
) -> anyhow::Result<String> {
    let now = Utc::now().timestamp();
    let claims = DeviceAccessClaims {
        sub: device_id,
        user_id,
        iat: now,
        exp: now + ttl_secs,
        typ: "device_access".to_string(),
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(signing_key),
    )?;
    Ok(token)
}

pub fn verify_device_access_token(
    signing_key: &[u8],
    token: &str,
) -> anyhow::Result<DeviceAccessClaims> {
    let mut validation = Validation::default();
    validation.validate_exp = true;
    let data = decode::<DeviceAccessClaims>(
        token,
        &DecodingKey::from_secret(signing_key),
        &validation,
    )?;
    if data.claims.typ != "device_access" {
        anyhow::bail!("invalid token type");
    }
    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_token_roundtrip() {
        let key = b"0123456789abcdef0123456789abcdef";
        let device_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let token = issue_device_access_token(key, device_id, user_id, 900).unwrap();
        let claims = verify_device_access_token(key, &token).unwrap();
        assert_eq!(claims.sub, device_id);
        assert_eq!(claims.user_id, user_id);
    }

    #[test]
    fn expired_token_is_rejected() {
        let key = b"0123456789abcdef0123456789abcdef";
        let device_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let token = issue_device_access_token(key, device_id, user_id, -120).unwrap();
        assert!(verify_device_access_token(key, &token).is_err());
    }
}
