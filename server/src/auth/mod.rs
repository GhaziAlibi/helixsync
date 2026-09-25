pub mod extractors;
pub mod model;
pub mod routes;
pub mod session;
pub mod tokens;

/// Trims and lowercases an email. Used for DB lookups and rate-limit keys so
/// stray spaces or casing can't create a second bucket or a lookup miss.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}
