//! Host names and allowlist entries. Ported from sandbox-runtime 0.0.78
//! `domain-pattern.js` and the host helpers of `parent-proxy.js`
//! (`isValidHost`, `canonicalizeHost`, `stripBrackets`, `formatAuthority`)
//! (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! Hosts are canonicalized as WHATWG URLs do (the `url` crate stands in for
//! Node's `URL`), so `127.1`, `0x7f.0.0.1` and `2130706433` are all
//! `127.0.0.1`, IPv6 is compressed, and an IPv4-mapped IPv6 literal is
//! spelled as the IPv4 address it connects to.

use std::net::{IpAddr, Ipv6Addr};

use super::address::mapped_ipv4;

/// `stripBrackets`: `[::1]` is `::1`.
pub fn strip_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
}

/// Node's `isIP` without zone identifiers, which every caller drops or
/// refuses first: dotted-decimal IPv4 without leading zeros, or IPv6.
pub fn parse_ip(text: &str) -> Option<IpAddr> {
    text.parse().ok()
}

/// srt's `isValidHost`: a DNS name of `[A-Za-z0-9._-]` or an IP literal
/// (bracketed or not), at most 255 bytes, never a zone identifier. Keeps
/// control characters (SOCKS5 `DOMAINNAME` is raw bytes) and zone-ID
/// tricks away from the matcher and the resolver.
pub fn is_valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 255 {
        return false;
    }
    let bare = strip_brackets(host);
    if bare.contains('%') {
        return false;
    }
    if parse_ip(bare).is_some() {
        return true;
    }
    !bare.is_empty()
        && bare
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// srt's `canonicalizeHost`: the host as the WHATWG URL parser spells it,
/// without brackets or a trailing dot; an IPv4-mapped IPv6 literal becomes
/// its IPv4 address. `None` when it is not a valid URL host.
pub fn canonicalize_host(host: &str) -> Option<String> {
    let bare = strip_brackets(host);
    let input = if bare.parse::<Ipv6Addr>().is_ok() {
        format!("[{bare}]")
    } else {
        bare.to_owned()
    };
    match url::Host::parse(&input).ok()? {
        url::Host::Ipv4(address) => Some(address.to_string()),
        url::Host::Ipv6(address) => Some(match mapped_ipv4(&address) {
            Some(v4) => v4.to_string(),
            None => strip_brackets(&url::Host::<String>::Ipv6(address).to_string()).to_owned(),
        }),
        url::Host::Domain(domain) => Some(domain.strip_suffix('.').unwrap_or(&domain).to_owned()),
    }
}

/// `formatAuthority`: `host[:port]` for a Host header or URL authority,
/// IPv6 bracketed, the default port left out.
pub fn format_authority(host: &str, port: u16, default_port: u16) -> String {
    let host = if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    if port == default_port {
        host
    } else {
        format!("{host}:{port}")
    }
}

/// `splitDomainPatternPort`: an entry's host pattern and optional port.
/// Only a strictly numeric suffix in 1–65535 without leading zeros is a
/// port. IPv6 literals must be bracketed to carry one (`[::1]:443`); an
/// unbracketed entry with two or more colons is an address, never split.
/// IPv6 host patterns come back canonical, so they compare equal to a
/// canonical destination.
pub fn split_port(entry: &str) -> (String, Option<u16>) {
    if let Some(inner) = entry.strip_prefix('[') {
        let Some(close) = inner.find(']') else {
            return (entry.to_owned(), None);
        };
        let address = drop_zone(&inner[..close]);
        let host = canonicalize_host(address).unwrap_or_else(|| address.to_owned());
        let rest = &inner[close + 1..];
        if rest.is_empty() {
            return (host, None);
        }
        return match rest.strip_prefix(':').and_then(parse_port_suffix) {
            Some(port) => (host, Some(port)),
            None => (entry.to_owned(), None),
        };
    }
    let Some(colon) = entry.rfind(':') else {
        return (entry.to_owned(), None);
    };
    if entry.find(':') != Some(colon) {
        let host = drop_zone(entry);
        return (
            canonicalize_host(host).unwrap_or_else(|| host.to_owned()),
            None,
        );
    }
    match parse_port_suffix(&entry[colon + 1..]) {
        Some(port) => (entry[..colon].to_owned(), Some(port)),
        None => (entry.to_owned(), None),
    }
}

/// srt's `domainPortPatternSchema` (`sandbox-config.js`), which srt's
/// settings put every `allowedDomains` entry through: an IPv6 literal is
/// bracketed (`hasValidIpv6Bracketing`), and the host pattern passes
/// `isValidDomainPattern` (a bracketed IPv6 address, `localhost`, a name
/// with a dot, or `*.` and a base with a dot; no scheme, path or other
/// wildcard).
pub fn is_valid_allowed_entry(entry: &str) -> bool {
    let bracketed = entry.matches(':').count() < 2 || entry.starts_with('[');
    bracketed && is_valid_domain_pattern(&split_port(entry).0)
}

/// `isValidDomainPattern`.
fn is_valid_domain_pattern(pattern: &str) -> bool {
    if pattern.parse::<Ipv6Addr>().is_ok() {
        return true;
    }
    if pattern.contains("://") || pattern.contains('/') || pattern.contains(':') {
        return false;
    }
    if pattern == "localhost" {
        return true;
    }
    if let Some(base) = pattern.strip_prefix("*.") {
        return base.contains('.')
            && !base.starts_with('.')
            && !base.ends_with('.')
            && base.split('.').all(|part| !part.is_empty());
    }
    !pattern.contains('*')
        && pattern.contains('.')
        && !pattern.starts_with('.')
        && !pattern.ends_with('.')
}

fn drop_zone(host: &str) -> &str {
    host.split_once('%').map_or(host, |(address, _)| address)
}

/// `/^[1-9][0-9]{0,4}$/`, at most 65535.
fn parse_port_suffix(suffix: &str) -> Option<u16> {
    let well_formed = (1..=5).contains(&suffix.len())
        && !suffix.starts_with('0')
        && suffix.bytes().all(|b| b.is_ascii_digit());
    well_formed.then(|| suffix.parse().ok()).flatten()
}

/// `matchesDomainPattern`: `*` matches everything, `*.example.com` strict
/// subdomains only (never an IP literal), anything else exactly,
/// case-insensitively.
pub fn matches_pattern(host: &str, pattern: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if pattern == "*" {
        return true;
    }
    if let Some(base) = pattern.strip_prefix("*.") {
        if parse_ip(strip_brackets(&host)).is_some() {
            return false;
        }
        return host.ends_with(&format!(".{}", base.to_ascii_lowercase()));
    }
    host == pattern.to_ascii_lowercase()
}

/// `matchesDomainPatternWithPort`: an entry with a port matches only that
/// port.
pub fn matches(host: &str, port: u16, entry: &str) -> bool {
    let (pattern, entry_port) = split_port(entry);
    if entry_port.is_some_and(|entry_port| entry_port != port) {
        return false;
    }
    matches_pattern(host, &pattern)
}

/// `ipLiteralRules`: the IP-literal entries of a list, with their ports,
/// for the resolved-address check.
pub fn ip_literal_rules(entries: &[String]) -> Vec<(IpAddr, Option<u16>)> {
    entries
        .iter()
        .filter_map(|entry| {
            let (host, port) = split_port(entry);
            parse_ip(&host).map(|address| (address, port))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_hosts_as_srt_checks_them() {
        for good in [
            "example.com",
            "_dmarc.example.com",
            "a-b.c",
            "127.0.0.1",
            "::1",
            "[::1]",
            "0000:0000:0000:0000:0000:0000:0000:0001",
            "::ffff:1.2.3.4",
        ] {
            assert!(is_valid_host(good), "{good}");
        }
        for bad in [
            "",
            "evil.com\0.allowed.com",
            "a b",
            "a\r\nb",
            "fe80::1%eth0",
            "::ffff:1.2.3.4%x.allowed.com",
            "user@host",
            "héllo.com",
            "[]",
            &"a".repeat(256),
        ] {
            assert!(!is_valid_host(bad), "{bad:?}");
        }
    }

    #[test]
    fn canonical_hosts() {
        let canonical = |host: &str| canonicalize_host(host);
        assert_eq!(canonical("GitHub.COM."), Some("github.com".into()));
        assert_eq!(canonical("127.1"), Some("127.0.0.1".into()));
        assert_eq!(canonical("0x7f.0.0.1"), Some("127.0.0.1".into()));
        assert_eq!(canonical("2130706433"), Some("127.0.0.1".into()));
        assert_eq!(canonical("2852039166"), Some("169.254.169.254".into()));
        assert_eq!(canonical("127.0.0.1."), Some("127.0.0.1".into()));
        assert_eq!(canonical("0:0:0:0:0:0:0:1"), Some("::1".into()));
        assert_eq!(canonical("[0:0:0:0:0:0:0:1]"), Some("::1".into()));
        assert_eq!(
            canonical("0000:0000:0000:0000:0000:0000:0000:0001"),
            Some("::1".into())
        );
        assert_eq!(
            canonical("2001:DB8:0:0:1:0:0:1"),
            Some("2001:db8::1:0:0:1".into())
        );
        assert_eq!(canonical("::ffff:127.0.0.1"), Some("127.0.0.1".into()));
        assert_eq!(canonical("::ffff:7f00:1"), Some("127.0.0.1".into()));
        // IPv4-compatible and NAT64 forms stay IPv6 (the guard decodes them).
        assert_eq!(canonical("::127.0.0.1"), Some("::7f00:1".into()));
        assert_eq!(canonical("[evil.com]"), Some("evil.com".into()));
        assert_eq!(canonical("fe80::1%eth0"), None);
        assert_eq!(canonical("a b"), None);
    }

    #[test]
    fn splits_ports_as_split_domain_pattern_port() {
        let split = |entry: &str| split_port(entry);
        assert_eq!(
            split("api.github.com:443"),
            ("api.github.com".into(), Some(443))
        );
        assert_eq!(split("api.github.com"), ("api.github.com".into(), None));
        assert_eq!(split("[::1]:443"), ("::1".into(), Some(443)));
        assert_eq!(split("[2001:db8::1]"), ("2001:db8::1".into(), None));
        assert_eq!(
            split("[2001:DB8:0:0:0:0:0:1]:8443"),
            ("2001:db8::1".into(), Some(8443))
        );
        assert_eq!(split("[::ffff:7f00:1]:80"), ("127.0.0.1".into(), Some(80)));
        assert_eq!(split("[fe80::1%en0]:22"), ("fe80::1".into(), Some(22)));
        assert_eq!(split("::1:443"), ("::1:443".into(), None), "never split");
        assert_eq!(split("0:0:0:0:0:0:0:1"), ("::1".into(), None));
        for whole in [
            "a.com:0443",
            "a.com:0",
            "a.com:65536",
            "a.com:99999",
            "a.com:",
            "a.com:+1",
            "evil.com:443.allowed.com",
            "[::1]junk",
            "[::1]:0",
            "[::1",
        ] {
            assert_eq!(split(whole), (whole.to_owned(), None), "{whole}");
        }
        assert_eq!(split("*:22"), ("*".into(), Some(22)));
    }

    #[test]
    fn matches_as_domain_pattern_does() {
        assert!(matches_pattern("api.github.com", "*.github.com"));
        assert!(matches_pattern("a.b.github.com", "*.GitHub.com"));
        assert!(!matches_pattern("github.com", "*.github.com"));
        assert!(!matches_pattern("evilgithub.com", "*.github.com"));
        assert!(matches_pattern("GitHub.com", "github.COM"));
        assert!(!matches_pattern("github.com.evil.com", "github.com"));
        assert!(matches_pattern("anything", "*"));
        // Wildcards never match IP literals.
        assert!(!matches_pattern("1.2.3.4", "*.3.4"));
        assert!(!matches_pattern("::ffff:1.2.3.4", "*.3.4"));
        assert!(matches_pattern("::1", "::1"));

        assert!(matches("api.github.com", 443, "*.github.com:443"));
        assert!(!matches("api.github.com", 80, "*.github.com:443"));
        assert!(matches("ssh.example.com", 22, "*:22"));
        assert!(!matches("ssh.example.com", 2222, "*:22"));
        // IPv6 entries match canonical destinations, however written.
        assert!(matches("::1", 443, "[0:0:0:0:0:0:0:1]:443"));
        assert!(!matches("::1", 80, "[::1]:443"));
        assert!(matches("2001:db8::1", 80, "2001:DB8::0:1"));
        assert!(matches("127.0.0.1", 80, "[::ffff:127.0.0.1]"));
    }

    #[test]
    fn allowed_entries_as_srts_schema_takes_them() {
        for good in [
            "github.com",
            "*.github.com",
            "api.github.com:443",
            "*.crates.io:8443",
            "localhost",
            "localhost:3000",
            "127.0.0.1",
            "127.0.0.1:8080",
            "[::1]",
            "[2001:db8::1]:443",
        ] {
            assert!(is_valid_allowed_entry(good), "{good}");
        }
        for bad in [
            "*.localhost",
            "*.com",
            "*",
            "*:22",
            "myhost",
            "LOCALHOST",
            "::1",
            "2001:db8::1",
            "::1:443",
            "https://github.com",
            "github.com/x",
            "a.*.com",
            ".github.com",
            "github.com.",
            "*..com",
        ] {
            assert!(!is_valid_allowed_entry(bad), "{bad}");
        }
    }

    #[test]
    fn ip_literal_entries() {
        let entries: Vec<String> = [
            "github.com",
            "127.0.0.1:8080",
            "[::1]",
            "10.0.0.1",
            "*.example.com",
            "localhost:3000",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            ip_literal_rules(&entries),
            [
                ("127.0.0.1".parse().unwrap(), Some(8080)),
                ("::1".parse().unwrap(), None),
                ("10.0.0.1".parse().unwrap(), None),
            ]
        );
    }

    #[test]
    fn authorities() {
        assert_eq!(format_authority("a.com", 80, 80), "a.com");
        assert_eq!(format_authority("a.com", 8080, 80), "a.com:8080");
        assert_eq!(format_authority("::1", 80, 80), "[::1]");
        assert_eq!(format_authority("::1", 81, 80), "[::1]:81");
    }
}
