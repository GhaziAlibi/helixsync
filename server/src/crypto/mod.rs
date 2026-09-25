use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

/// Max Argon2 jobs running at once, process-wide. Each one burns tens of ms
/// of CPU, so a burst of logins could otherwise pin every core. Extra
/// requests wait for a permit.
pub const ARGON2_CONCURRENCY_LIMIT: usize = 4;

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
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Runs `hash_password` on the blocking pool so the CPU-heavy hash doesn't
/// stall a Tokio worker. Holds an `ARGON2_CONCURRENCY_LIMIT` permit while it runs.
pub async fn hash_password_async(
    password: String,
    semaphore: &Semaphore,
) -> anyhow::Result<String> {
    let _permit = semaphore
        .acquire()
        .await
        .expect("argon2 semaphore is never closed");
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| anyhow::anyhow!("password hashing task panicked: {e}"))?
}

/// Async version of `verify_password`; see `hash_password_async`.
/// A panic in the task counts as a failed check.
pub async fn verify_password_async(password: String, hash: String, semaphore: &Semaphore) -> bool {
    let _permit = match semaphore.acquire().await {
        Ok(permit) => permit,
        Err(_) => return false,
    };
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false)
}

/// Generate a cryptographically secure random opaque token, returned as a
/// URL-safe base64 string for transport and a SHA-256 hash for storage.
pub fn generate_opaque_token() -> (String, String) {
    let token = random_urlsafe_token::<32>();
    let hash = hash_token(&token);
    (token, hash)
}

/// `N` cryptographically secure random bytes as URL-safe base64 (no padding).
pub fn random_urlsafe_token<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

/// Deterministic hash of an opaque token for storage/lookup (never store the
/// raw token itself).
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Random per-account salt for client-side key derivation
/// (docs/encryption.md §2). Every device gets the same salt.
pub fn generate_encryption_salt() -> String {
    random_urlsafe_token::<16>()
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
