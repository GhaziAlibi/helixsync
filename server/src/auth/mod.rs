pub mod account;
pub mod extractors;
pub mod model;
pub mod requests;
pub mod routes;
pub mod session;
pub mod tokens;

use crate::error::{AppError, AppResult};

/// Longest email accepted, in bytes (the SMTP path limit).
pub const MAX_EMAIL_LEN: usize = 320;

/// Trims and lowercases an email. Used for DB lookups and rate-limit keys so
/// stray spaces or casing can't create a second bucket or a lookup miss.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// [`normalize_email`] for an email taken from a request. Over-long ones are
/// refused before they become a rate-limit key, which the limiter keeps in
/// memory for a whole window. No account can have such an email, so the
/// refusal says nothing about which accounts exist.
pub fn request_email(email: &str) -> AppResult<String> {
    let email = normalize_email(email);
    if email.len() > MAX_EMAIL_LEN {
        return Err(AppError::Validation("invalid email".into()));
    }
    Ok(email)
}
