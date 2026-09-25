use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use hmac::{Hmac, KeyInit, Mac};
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
    use std::fmt::Write;

    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    // Lowercase hex, the format already stored in `session_hash` and
    // `credential_hash`.
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
            hex
        })
}

/// The `authKey` the client sends instead of a password (SEC-01, docs/
/// encryption.md §2) must be exactly 32 bytes, base64url-encoded, no
/// padding — the same shape `toB64`/`fromB64` in the extension/web crypto
/// modules produce. Anything else means the caller sent something that
/// isn't an authKey (most importantly: a raw password by mistake), so this
/// is checked before the value ever reaches Argon2.
pub fn validate_auth_key(auth_key: &str) -> anyhow::Result<()> {
    let decoded =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, auth_key)
            .map_err(|_| anyhow::anyhow!("authKey must be base64url-encoded"))?;
    if decoded.len() != 32 {
        return Err(anyhow::anyhow!("authKey must decode to exactly 32 bytes"));
    }
    Ok(())
}

/// Domain-separation label for the key behind `fake_kdf_salt_for_unknown_email`.
/// Changing it changes every fake salt, which would make an unknown email's
/// salt differ between releases; bump the `-v1` suffix only deliberately.
const FAKE_SALT_KEY_LABEL: &[u8] = b"helixsync-prelogin-fake-salt-v1";

/// Deterministic fake `kdfSalt` for an email with no account, so
/// `POST /auth/prelogin` can't be used to enumerate which emails are
/// registered (docs/encryption.md §2) — a real lookup is indistinguishable
/// from this from the caller's side. Keyed from the server's own signing
/// key: already a required, ≥32-byte, server-only secret, so this needs no
/// new config value. The signing key is not used directly: a purpose-specific
/// subkey is derived first (F-05), so this HMAC output can never coincide
/// with any other use of the raw key (e.g. JWT signatures). Not a password
/// hash and never used to authenticate anything — purely there to make the
/// response shape stable per email.
///
/// Truncated to 16 bytes to match the length of a real `kdfSalt`
/// (`generateKdfSalt()` in web/extension crypto is `randomBytes(16)`) — a
/// full 32-byte HMAC digest would be a different, longer base64url string
/// and let the salt length alone distinguish real accounts from fake ones
/// (F-01).
pub fn fake_kdf_salt_for_unknown_email(jwt_signing_key: &[u8], email: &str) -> String {
    let mut subkey_mac =
        Hmac::<Sha256>::new_from_slice(jwt_signing_key).expect("HMAC accepts a key of any length");
    subkey_mac.update(FAKE_SALT_KEY_LABEL);
    let subkey = subkey_mac.finalize().into_bytes();

    let mut mac =
        Hmac::<Sha256>::new_from_slice(&subkey).expect("HMAC accepts a key of any length");
    mac.update(email.as_bytes());
    let digest = mac.finalize().into_bytes();
    base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        &digest[..16],
    )
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

    #[test]
    fn auth_key_validation_accepts_32_bytes_base64url() {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let encoded =
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes);
        assert!(validate_auth_key(&encoded).is_ok());
    }

    #[test]
    fn auth_key_validation_rejects_wrong_length_and_non_base64() {
        assert!(validate_auth_key("not-valid-base64url!!!").is_err());
        // 16 bytes, not 32.
        assert!(validate_auth_key(&base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            [0u8; 16]
        ))
        .is_err());
        // A plausible raw password must never pass as an authKey.
        assert!(validate_auth_key("correct horse battery staple").is_err());
    }

    #[test]
    fn fake_kdf_salt_is_deterministic_per_email_and_differs_across_emails() {
        let key = b"test-signing-key-at-least-32-bytes-long";
        let a1 = fake_kdf_salt_for_unknown_email(key, "a@example.com");
        let a2 = fake_kdf_salt_for_unknown_email(key, "a@example.com");
        let b = fake_kdf_salt_for_unknown_email(key, "b@example.com");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
    }

    #[test]
    fn fake_kdf_salt_known_answer_pins_the_derivation() {
        // HMAC-SHA256(HMAC-SHA256(key, label), email), first 16 bytes,
        // base64url. Pinned so an accidental change to the derivation (which
        // would shift every unknown email's salt between releases) fails here.
        let key = b"test-signing-key-at-least-32-bytes-long";
        assert_eq!(
            fake_kdf_salt_for_unknown_email(key, "a@example.com"),
            "sLm6ukDHiMZPTI4GCtBPuA"
        );
    }

    #[test]
    fn hash_token_is_lowercase_hex_sha256() {
        // Stored session and credential hashes use this exact format, so it
        // must not change with the digest crate. SHA-256("abc") test vector.
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn fake_kdf_salt_is_not_a_plain_hmac_of_the_raw_signing_key() {
        // F-05: HMAC(raw_key, email) (what this used to compute) must no
        // longer be reproducible by anyone holding only the raw key.
        let key = b"test-signing-key-at-least-32-bytes-long";
        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(b"a@example.com");
        let undifferentiated = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            &mac.finalize().into_bytes()[..16],
        );
        assert_eq!(undifferentiated, "5HcJH4eFDtU7z5XQEEVk5A");
        assert_ne!(
            fake_kdf_salt_for_unknown_email(key, "a@example.com"),
            undifferentiated
        );
    }

    #[test]
    fn fake_kdf_salt_differs_across_signing_keys() {
        let a = fake_kdf_salt_for_unknown_email(
            b"first-signing-key-at-least-32-bytes!!",
            "a@example.com",
        );
        let b = fake_kdf_salt_for_unknown_email(
            b"other-signing-key-at-least-32-bytes!!",
            "a@example.com",
        );
        assert_ne!(a, b);
    }

    #[test]
    fn fake_kdf_salt_matches_real_salt_length() {
        // Real salts are `randomBytes(16)` base64url-encoded (see
        // web/extension `generateKdfSalt()`), which is 22 characters with
        // no padding. F-01: a fake salt of a different length lets an
        // attacker distinguish real accounts from unknown emails.
        let key = b"test-signing-key-at-least-32-bytes-long";
        let fake = fake_kdf_salt_for_unknown_email(key, "nobody@example.com");
        let real =
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, [0u8; 16]);
        assert_eq!(fake.len(), real.len());
    }
}
