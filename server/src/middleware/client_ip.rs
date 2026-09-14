use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

/// Determines the address to key per-client rate limiting on.
///
/// In this codebase's production topology (docker-compose.yml), the
/// `server` binary has no published port and is only ever reachable through
/// the `web` service's nginx, which proxies `/api/` over the internal
/// docker network and sets `X-Real-IP`/`X-Forwarded-For` (web/nginx.conf).
/// Axum's `ConnectInfo<SocketAddr>` in that setup always resolves to
/// nginx's own container IP, not the real client — so keying rate limits
/// on it directly collapses every user/device on the server into a single
/// shared bucket (e.g. one global 10-logins/min limit for everyone).
///
/// When `behind_proxy` is true, trust the proxy-set headers instead:
/// `X-Forwarded-For`'s *first* entry is the original client (nginx's
/// `$proxy_add_x_forwarded_for` appends to any inbound value, so the first
/// entry is left-most/oldest), falling back to `X-Real-IP`, falling back
/// further to the raw connection address if neither header is present or
/// parses as a valid IP. When `behind_proxy` is false (the default — local
/// dev, tests, or any deployment not sitting behind a trusted proxy),
/// these headers are attacker-controlled on a direct connection, so they
/// are never trusted and `ConnectInfo` is used unconditionally.
pub fn client_ip(headers: &HeaderMap, addr: SocketAddr, behind_proxy: bool) -> IpAddr {
    if !behind_proxy {
        return addr.ip();
    }

    if let Some(forwarded_for) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(first) = forwarded_for
            .split(',')
            .next()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if let Ok(ip) = first.parse::<IpAddr>() {
                return ip;
            }
        }
    }

    if let Some(real_ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = real_ip.trim().parse::<IpAddr>() {
            return ip;
        }
    }

    addr.ip()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr() -> SocketAddr {
        "10.0.0.1:12345".parse().unwrap()
    }

    #[test]
    fn not_behind_proxy_always_uses_connect_info() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.5".parse().unwrap());
        assert_eq!(client_ip(&headers, addr(), false), addr().ip());
    }

    #[test]
    fn behind_proxy_uses_first_forwarded_for_entry() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "203.0.113.5, 172.18.0.9".parse().unwrap(),
        );
        assert_eq!(
            client_ip(&headers, addr(), true),
            "203.0.113.5".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn behind_proxy_falls_back_to_real_ip_when_forwarded_for_missing() {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", "203.0.113.7".parse().unwrap());
        assert_eq!(
            client_ip(&headers, addr(), true),
            "203.0.113.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn behind_proxy_falls_back_to_connect_info_when_headers_absent() {
        let headers = HeaderMap::new();
        assert_eq!(client_ip(&headers, addr(), true), addr().ip());
    }

    #[test]
    fn behind_proxy_falls_back_to_connect_info_when_headers_unparseable() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
        headers.insert("x-real-ip", "also-not-an-ip".parse().unwrap());
        assert_eq!(client_ip(&headers, addr(), true), addr().ip());
    }
}
