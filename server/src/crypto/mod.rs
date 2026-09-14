use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Hash a password with Argon2id using a fresh random salt.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("password hashing failed: {e}"))?;
    Ok(hash.to_string())
}

/// Verify a password against a stored Argon2id hash.
pub fn verify_password(password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Async wrapper around `hash_password` that runs the actual Argon2id work
/// (tens of milliseconds of solid CPU by design — that's what makes it
/// resistant to offline cracking) on a blocking-pool thread instead of a
/// Tokio worker thread. Every handler here is called directly inside an
/// async fn with no `.await` in between it and the CPU-bound hash, so
/// without this every register/login/password-change request would stall
/// whatever else is scheduled on that worker for the hash's full duration —
/// on the 1-2 vCPU deployments this project targets, a handful of
/// concurrent auth requests would be enough to starve the runtime.
pub async fn hash_password_async(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| anyhow::anyhow!("password hashing task panicked: {e}"))?
}

/// Async counterpart to `verify_password` — see `hash_password_async` for
/// why this must never run directly on a Tokio worker thread. Panics in the
/// blocking task (which should not happen; `verify_password` has no known
/// panic path) are treated as a failed verification rather than propagated,
/// consistent with `verify_password`'s own error handling.
pub async fn verify_password_async(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false)
}

/// Generate a cryptographically secure random opaque token, returned as a
/// URL-safe base64 string for transport and a SHA-256 hash for storage.
pub fn generate_opaque_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
    let hash = hash_token(&token);
    (token, hash)
}

/// Deterministic hash of an opaque token for storage/lookup (never store the
/// raw token itself).
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Generate a random per-account salt for client-side password-based
/// encryption key derivation (docs/encryption.md §2). Handed to every
/// device at registration so each one derives the same encryption root key
/// from the account password locally, without a device-to-device
/// authorization handshake.
pub fn generate_encryption_salt() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_roundtrip() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
    }

    #[test]
    fn opaque_token_hash_is_deterministic() {
        let (token, hash) = generate_opaque_token();
        assert_eq!(hash_token(&token), hash);
    }
}
