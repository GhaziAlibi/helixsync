use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
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
    // HS256 only; `exp` is validated by default.
    let validation = Validation::new(Algorithm::HS256);
    let data =
        decode::<DeviceAccessClaims>(token, &DecodingKey::from_secret(signing_key), &validation)?;
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

    #[test]
    fn token_made_by_another_hs256_implementation_is_accepted() {
        // Built independently (HMAC-SHA256 over the standard JWT encoding), so
        // tokens issued before an upgrade of the JWT library stay valid.
        let key = b"0123456789abcdef0123456789abcdef";
        let token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJ1c2VyX2lkIjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwiaWF0Ijo0MTAyNDQzOTAwLCJleHAiOjQxMDI0NDQ4MDAsInR5cCI6ImRldmljZV9hY2Nlc3MifQ.r2RLcCEeqjP6ZiZsrd8_XX5VamEjMTGVXq-9WvmxQhk";
        let claims = verify_device_access_token(key, token).unwrap();
        assert_eq!(
            claims.sub.to_string(),
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(
            claims.user_id.to_string(),
            "22222222-2222-4222-8222-222222222222"
        );
        assert!(
            verify_device_access_token(b"a-different-signing-key-of-32-bytes!!", token).is_err()
        );
    }
}
