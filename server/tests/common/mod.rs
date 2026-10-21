//! Shared test-only helpers for the integration suite.
//!
//! `authKey` (SEC-01) is an opaque 32-byte secret as far as the server is
//! concerned — it's derived client-side (Argon2id + HKDF) from the account
//! password, and the server never re-derives or validates it against
//! anything. Tests therefore don't need real KDF logic: any 32 bytes,
//! base64url-encoded (no padding), is a valid `authKey`. The server only
//! checks the shape of `kdf_salt` (16 bytes of base64url), `kdf_params`
//! (bounded `m`/`t`/`p`) and `wrapped_ak` (a length cap), so fixed
//! placeholders of the right shape are fine.

use sha2::{Digest, Sha256};

/// A deterministic, valid `authKey` for `seed` — 32 bytes (SHA-256 of the
/// seed string), base64url-encoded with no padding. Deterministic so tests
/// that log in with "the same password" twice can just reuse the same seed.
#[allow(dead_code)]
pub fn test_auth_key(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, digest)
}

/// Placeholder `kdfSalt` for tests: bytes 0..16, base64url without padding,
/// the shape the server requires of a real salt.
#[allow(dead_code)]
pub fn test_kdf_salt() -> &'static str {
    "AAECAwQFBgcICQoLDA0ODw"
}

/// Placeholder `kdfParams` for tests — opaque to the server, must be valid JSON.
#[allow(dead_code)]
pub fn test_kdf_params() -> serde_json::Value {
    serde_json::json!({ "m": 19456, "t": 2, "p": 1 })
}

/// Placeholder `wrappedAk` for tests — opaque to the server.
#[allow(dead_code)]
pub fn test_wrapped_ak() -> &'static str {
    "test-wrapped-account-key"
}

/// The `recoveryAuthKey` every test registration uses. Like `authKey`, any
/// 32 bytes of base64url pass; a test that recovers an account derives
/// other codes with `test_auth_key`.
#[allow(dead_code)]
pub fn test_recovery_auth_key() -> String {
    test_auth_key("test recovery code")
}

/// Placeholder `recoveryWrappedAk` for tests — opaque to the server.
#[allow(dead_code)]
pub fn test_recovery_wrapped_ak() -> &'static str {
    "test-recovery-wrapped-account-key"
}
