use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

/// Picks the IP address to rate-limit on.
///
/// In production the server sits behind nginx, so the TCP peer is always
/// nginx. When `behind_proxy` is true we use `X-Real-IP` (set by nginx and
/// can't be spoofed), then `X-Forwarded-For` (can be spoofed, kept for other
/// proxies), then the peer address.
///
/// When `behind_proxy` is false these headers are ignored, since any client
/// could set them.
pub fn client_ip(headers: &HeaderMap, addr: SocketAddr, behind_proxy: bool) -> IpAddr {
    if !behind_proxy {
        return addr.ip();
    }

    if let Some(real_ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = real_ip.trim().parse::<IpAddr>() {
            return ip;
        }
    }

    if let Some(forwarded_for) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
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

    addr.ip()
}

/// Rate-limit key for an IP. IPv4 uses the full address. IPv6 uses the /64
/// prefix, since one user can easily rotate through a whole /64.
pub fn rate_limit_ip_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            format!(
                "{:x}:{:x}:{:x}:{:x}::/64",
                segments[0], segments[1], segments[2], segments[3]
            )
        }
    }
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
    fn behind_proxy_falls_back_to_forwarded_for_when_real_ip_missing() {
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
    fn behind_proxy_uses_real_ip_when_forwarded_for_missing() {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", "203.0.113.7".parse().unwrap());
        assert_eq!(
            client_ip(&headers, addr(), true),
            "203.0.113.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn behind_proxy_prefers_real_ip_over_spoofed_forwarded_for() {
        // X-Forwarded-For can be spoofed, X-Real-IP can't. X-Real-IP must win.
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.199".parse().unwrap());
        headers.insert("x-real-ip", "198.51.100.1".parse().unwrap());
        assert_eq!(
            client_ip(&headers, addr(), true),
            "198.51.100.1".parse::<IpAddr>().unwrap()
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

    #[test]
    fn rate_limit_ip_key_keeps_ipv4_as_full_address() {
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        assert_eq!(rate_limit_ip_key(ip), "203.0.113.5");
    }

    #[test]
    fn rate_limit_ip_key_collapses_ipv6_to_slash_64() {
        // Addresses in the same /64 must share a key.
        let a: IpAddr = "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd".parse().unwrap();
        let b: IpAddr = "2001:db8:1234:5678:1111:2222:3333:4444".parse().unwrap();
        assert_eq!(rate_limit_ip_key(a), rate_limit_ip_key(b));
        assert_eq!(rate_limit_ip_key(a), "2001:db8:1234:5678::/64");
    }

    #[test]
    fn rate_limit_ip_key_distinguishes_different_ipv6_prefixes() {
        let a: IpAddr = "2001:db8:1234:5678::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1234:5679::1".parse().unwrap();
        assert_ne!(rate_limit_ip_key(a), rate_limit_ip_key(b));
    }
}
