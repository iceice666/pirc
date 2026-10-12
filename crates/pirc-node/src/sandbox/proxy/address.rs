//! What an allowed host name may resolve to. Ported from sandbox-runtime
//! 0.0.78 `resolved-address-guard.js` and `address.js` (Apache-2.0, see
//! `crates/pirc-node/NOTICE`).
//!
//! The allowlist decides by name, but whoever controls a permitted name's
//! DNS (or any label under a permitted wildcard) decides where it points.
//! So a name is resolved once, the addresses it may not use are dropped,
//! and the proxy connects to one that survived: the address checked is the
//! address dialed. A name may not resolve to loopback, unspecified,
//! link-local, multicast, broadcast or cloud metadata addresses, nor to an
//! address of this host's own interfaces (a service bound to `0.0.0.0`
//! answers there as on loopback), unless that address (and port) is itself
//! an allowlist entry; an IP literal on the deny list is refused by name
//! too. `localhost` and names under `.localhost` must resolve to loopback
//! (or an allowed literal). IP-literal destinations are never re-judged:
//! listing one is an explicit choice. Private ranges (RFC 1918, ULA,
//! CGNAT) are allowed, as in srt: allow-listing an intranet name is
//! legitimate, and pirc passes no `deniedResolvedAddresses`. IPv4 rules
//! also catch the IPv6 forms that carry an IPv4 address (mapped,
//! compatible, translated, NAT64 `64:ff9b::/96`, 6to4).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use super::pattern::{ip_literal_rules, parse_ip};

/// An address and prefix length, IPv4-mapped rules stored as IPv4.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    address: IpAddr,
    prefix: u8,
}

impl Range {
    /// `parseAddressRange`: an IP literal or CIDR range (`10.0.0.0/8`,
    /// `fc00::/7`, `::1`); a zone ID is dropped and an IPv4-mapped range is
    /// the IPv4 range it stands for.
    pub fn parse(entry: &str) -> Option<Self> {
        let (address, prefix) = match entry.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (entry, None),
        };
        let address = address.split_once('%').map_or(address, |(a, _)| a);
        let address = parse_ip(address)?;
        let max = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => max,
            Some(text) => {
                let digits =
                    (1..=3).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit());
                let value: u8 = text.parse().ok().filter(|_| digits)?;
                if value > max {
                    return None;
                }
                value
            }
        };
        if let IpAddr::V6(v6) = address
            && let Some(v4) = mapped_ipv4(&v6)
        {
            return (prefix >= 96).then(|| Self {
                address: IpAddr::V4(v4),
                prefix: prefix - 96,
            });
        }
        Some(Self { address, prefix })
    }

    /// `BlockList.check`: IPv4 rules match the IPv4-mapped spelling too.
    pub fn contains(&self, address: IpAddr) -> bool {
        let address = unmap(address);
        let prefix = u32::from(self.prefix);
        match (self.address, address) {
            (IpAddr::V4(rule), IpAddr::V4(address)) => {
                let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
                u32::from(rule) & mask == u32::from(address) & mask
            }
            (IpAddr::V6(rule), IpAddr::V6(address)) => {
                let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
                u128::from(rule) & mask == u128::from(address) & mask
            }
            _ => false,
        }
    }
}

fn unmap(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => mapped_ipv4(&v6).map_or(address, IpAddr::V4),
        v4 => v4,
    }
}

/// `mappedIPv4`: the IPv4 address of `::ffff:a.b.c.d`.
pub fn mapped_ipv4(address: &Ipv6Addr) -> Option<Ipv4Addr> {
    let g = address.segments();
    (g[..5].iter().all(|x| *x == 0) && g[5] == 0xffff).then(|| low_ipv4(&g))
}

fn low_ipv4(g: &[u16; 8]) -> Ipv4Addr {
    let [a, b] = g[6].to_be_bytes();
    let [c, d] = g[7].to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

/// `embeddedIPv4`: the IPv4 address an IPv6 address is delivered to:
/// IPv4-mapped and -compatible (`::ffff:0:0/96`, `::/96`), -translated
/// (`::ffff:0:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`).
pub fn embedded_ipv4(address: IpAddr) -> Option<Ipv4Addr> {
    let IpAddr::V6(v6) = address else {
        return None;
    };
    let g = v6.segments();
    let zero = |range: std::ops::Range<usize>| g[range].iter().all(|x| *x == 0);
    if g[0] == 0x2002 {
        let [a, b] = g[1].to_be_bytes();
        let [c, d] = g[2].to_be_bytes();
        return Some(Ipv4Addr::new(a, b, c, d));
    }
    if (g[0] == 0x64 && g[1] == 0xff9b && zero(2..6))
        || (zero(0..5) && (g[5] == 0 || g[5] == 0xffff))
        || (zero(0..4) && g[4] == 0xffff && g[5] == 0)
    {
        return Some(low_ipv4(&g));
    }
    None
}

/// `isLoopbackName`: `localhost` and names under `.localhost` (RFC 6761).
pub fn is_loopback_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    host == "localhost" || host.ends_with(".localhost")
}

const LOOPBACK: &[&str] = &["127.0.0.0/8", "::1"];

/// `isLoopbackAddress`.
pub fn is_loopback_address(address: IpAddr) -> bool {
    LOOPBACK.iter().any(|range| in_range(range, address))
}

fn in_range(entry: &str, address: IpAddr) -> bool {
    Range::parse(entry).is_some_and(|range| range.contains(address))
}

/// srt's `DENIED_CLASSES`, in its order.
const DENIED_CLASSES: &[(&str, &[&str])] = &[
    ("a loopback address", LOOPBACK),
    ("an unspecified address", &["0.0.0.0/8", "::"]),
    ("a link-local address", &["169.254.0.0/16", "fe80::/10"]),
    ("a multicast address", &["224.0.0.0/4", "ff00::/8"]),
    ("the broadcast address", &["255.255.255.255"]),
    (
        "a cloud metadata address",
        &[
            "100.100.100.200",
            "168.63.129.16",
            "192.0.0.192",
            "fd00:ec2::/32",
            "fd20:ce::254",
            "fd00:c1::a9fe:a9fe",
            "fd00:42::42",
            "fd00:a9fe:a9fe::1",
            "fd00:100::100:200",
        ],
    ),
];

const DENY_LISTED: &str = "a deny-listed address";
const LOCAL: &str = "one of this host's addresses";
const NOT_LOOPBACK: &str = "a non-loopback address";

/// `REASON_ORDER`, so a refusal reads the same whatever the resolver's
/// order (`a listed address` and `an unparsable address` cannot occur:
/// pirc passes no `deniedResolvedAddresses`, and resolved addresses are
/// parsed already).
fn reason_rank(reason: &str) -> usize {
    std::iter::once(DENY_LISTED)
        .chain(DENIED_CLASSES.iter().map(|(why, _)| *why))
        .chain([LOCAL, NOT_LOOPBACK])
        .position(|why| why == reason)
        .unwrap_or(usize::MAX)
}

/// IP-literal rules of an allow or deny list.
struct RuleSet(Vec<(Range, Option<u16>)>);

impl RuleSet {
    fn new(entries: &[String]) -> Self {
        Self(
            ip_literal_rules(entries)
                .into_iter()
                .filter_map(|(address, port)| {
                    Range::parse(&address.to_string()).map(|range| (range, port))
                })
                .collect(),
        )
    }

    fn contains(&self, address: IpAddr, port: u16) -> bool {
        self.0
            .iter()
            .any(|(range, only)| only.is_none_or(|only| only == port) && range.contains(address))
    }
}

/// A host name resolved only to addresses it may not use (`ResolvedAddressDeniedError`).
#[derive(Debug, PartialEq, Eq)]
pub struct Denied {
    /// srt's message: `Connection to <host> blocked: resolved to <classes>`.
    /// The classes, never the addresses: the sandboxed client does not
    /// learn them from a refusal.
    pub message: String,
}

/// `createResolvedAddressGuard` for one dial: the session's lists as they
/// are now (approvals included) and this host's addresses.
pub struct Guard {
    refused: RuleSet,
    allowed: RuleSet,
    local: Vec<IpAddr>,
}

impl Guard {
    pub fn new(allowed: &[String], denied: &[String], local: Vec<IpAddr>) -> Self {
        Self {
            refused: RuleSet::new(denied),
            allowed: RuleSet::new(allowed),
            local,
        }
    }

    /// Why `host` (canonical) may not use `address` on `port`.
    fn denial(&self, host: &str, address: IpAddr, port: u16) -> Option<&'static str> {
        if parse_ip(host).is_some() {
            return None;
        }
        // A carried IPv4 address only adds denials: it never earns an
        // allowlist carve-out, nor stands in for the address in the
        // localhost rule.
        let v4 = embedded_ipv4(address).map(IpAddr::V4);
        let denies = |set: &dyn Fn(IpAddr) -> bool| set(address) || v4.is_some_and(set);
        if denies(&|a| self.refused.contains(a, port)) {
            return Some(DENY_LISTED);
        }
        if self.allowed.contains(address, port) {
            return None;
        }
        if is_loopback_name(host) {
            return (!is_loopback_address(address)).then_some(NOT_LOOPBACK);
        }
        for (why, ranges) in DENIED_CLASSES {
            if denies(&|a| ranges.iter().any(|range| in_range(range, a))) {
                return Some(why);
            }
        }
        let local = |a: IpAddr| self.local.iter().any(|own| unmap(*own) == unmap(a));
        denies(&local).then_some(LOCAL)
    }

    /// `lookupFor`: the addresses `host` may use, in the resolver's order,
    /// or why there are none. An empty answer is `Ok(empty)`.
    pub fn vet(&self, host: &str, port: u16, addresses: &[IpAddr]) -> Result<Vec<IpAddr>, Denied> {
        let mut kept = Vec::new();
        let mut reasons: Vec<&str> = Vec::new();
        for address in addresses {
            match self.denial(host, *address, port) {
                None => kept.push(*address),
                Some(why) => {
                    if !reasons.contains(&why) {
                        reasons.push(why);
                    }
                }
            }
        }
        if kept.is_empty() && !reasons.is_empty() {
            reasons.sort_by_key(|why| reason_rank(why));
            return Err(Denied {
                message: format!(
                    "Connection to {host} blocked: resolved to {}",
                    reasons.join(" / ")
                ),
            });
        }
        Ok(kept)
    }
}

/// `localInterfaceAddresses`: what this host's interfaces carry now
/// (nothing when they cannot be listed; the fixed classes still apply).
pub fn local_addresses() -> Vec<IpAddr> {
    let Ok(interfaces) = nix::ifaddrs::getifaddrs() else {
        return Vec::new();
    };
    interfaces
        .filter_map(|interface| {
            let address = interface.address?;
            if let Some(v4) = address.as_sockaddr_in() {
                Some(IpAddr::V4(v4.ip()))
            } else {
                address.as_sockaddr_in6().map(|v6| IpAddr::V6(v6.ip()))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn ranges() {
        let range = |entry: &str| Range::parse(entry).unwrap();
        assert!(range("10.0.0.0/8").contains(ip("10.9.8.7")));
        assert!(!range("10.0.0.0/8").contains(ip("11.0.0.1")));
        assert!(range("10.0.0.0/8").contains(ip("::ffff:10.1.2.3")));
        assert!(range("::ffff:10.0.0.0/104").contains(ip("10.1.2.3")));
        assert_eq!(range("::ffff:10.0.0.0/104"), range("10.0.0.0/8"));
        assert!(range("fe80::/10").contains(ip("fe80::1")));
        assert!(range("fe80::1%en0").contains(ip("fe80::1")));
        assert!(range("0.0.0.0/0").contains(ip("8.8.8.8")));
        assert!(!range("0.0.0.0/0").contains(ip("::1")));
        assert!(range("::/0").contains(ip("::1")));
        assert!(range("::").contains(ip("::")));
        assert!(!range("::").contains(ip("::1")));
        for bad in [
            "10.0.0.0/33",
            "::/129",
            "10.0.0.0/",
            "10.0.0.0/x",
            "::ffff:0:0/95",
            "a.com",
            "010.0.0.1",
        ] {
            assert_eq!(Range::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn embedded_ipv4_forms() {
        let embedded = |text: &str| embedded_ipv4(ip(text)).map(|v4| v4.to_string());
        assert_eq!(embedded("::ffff:127.0.0.1").as_deref(), Some("127.0.0.1"));
        assert_eq!(embedded("::127.0.0.1").as_deref(), Some("127.0.0.1"));
        assert_eq!(embedded("::1").as_deref(), Some("0.0.0.1"));
        assert_eq!(
            embedded("::ffff:0:a9fe:a9fe").as_deref(),
            Some("169.254.169.254")
        );
        assert_eq!(embedded("64:ff9b::7f00:1").as_deref(), Some("127.0.0.1"));
        assert_eq!(embedded("2002:7f00:1::5").as_deref(), Some("127.0.0.1"));
        assert_eq!(embedded("64:ff9b:1::7f00:1"), None, "local-use NAT64");
        assert_eq!(embedded("2001:db8::1"), None);
        assert_eq!(embedded("127.0.0.1"), None);
    }

    #[test]
    fn loopback_names_and_addresses() {
        assert!(is_loopback_name("localhost"));
        assert!(is_loopback_name("LocalHost."));
        assert!(is_loopback_name("app.localhost"));
        assert!(!is_loopback_name("localhost.example.com"));
        assert!(is_loopback_address(ip("127.8.9.10")));
        assert!(is_loopback_address(ip("::ffff:127.0.0.1")));
        assert!(is_loopback_address(ip("::1")));
        assert!(!is_loopback_address(ip("::2")));
    }

    #[test]
    fn names_may_not_resolve_to_internal_addresses() {
        let guard = Guard::new(
            &strings(&["*.example.com"]),
            &[],
            vec![ip("192.168.1.20"), ip("2001:db8::20")],
        );
        let refused = |address: &str| {
            guard
                .vet("a.example.com", 443, &[ip(address)])
                .unwrap_err()
                .message
        };
        let class = |address: &str| {
            refused(address)
                .strip_prefix("Connection to a.example.com blocked: resolved to ")
                .unwrap()
                .to_owned()
        };
        assert_eq!(class("127.0.0.1"), "a loopback address");
        assert_eq!(class("127.1.2.3"), "a loopback address");
        assert_eq!(class("::1"), "a loopback address");
        assert_eq!(class("::ffff:127.0.0.1"), "a loopback address");
        assert_eq!(class("::127.0.0.1"), "a loopback address");
        assert_eq!(class("64:ff9b::7f00:1"), "a loopback address");
        assert_eq!(class("2002:7f00:1::"), "a loopback address");
        assert_eq!(class("0.0.0.0"), "an unspecified address");
        assert_eq!(class("::"), "an unspecified address");
        assert_eq!(class("169.254.169.254"), "a link-local address");
        assert_eq!(class("fe80::1"), "a link-local address");
        assert_eq!(class("::ffff:169.254.169.254"), "a link-local address");
        assert_eq!(class("224.0.0.1"), "a multicast address");
        assert_eq!(class("ff02::1"), "a multicast address");
        assert_eq!(class("255.255.255.255"), "the broadcast address");
        assert_eq!(class("100.100.100.200"), "a cloud metadata address");
        assert_eq!(class("fd00:ec2::254"), "a cloud metadata address");
        assert_eq!(class("192.168.1.20"), "one of this host's addresses");
        assert_eq!(class("::ffff:192.168.1.20"), "one of this host's addresses");
        assert_eq!(class("2001:db8::20"), "one of this host's addresses");
        // Private ranges are not srt's business by default.
        for fine in [
            "10.0.0.5",
            "192.168.1.21",
            "172.16.0.1",
            "100.64.0.1",
            "fd12::1",
            "93.184.216.34",
        ] {
            assert_eq!(
                guard.vet("a.example.com", 443, &[ip(fine)]),
                Ok(vec![ip(fine)]),
                "{fine}"
            );
        }
    }

    #[test]
    fn denied_addresses_are_dropped_and_the_reason_is_stable() {
        let guard = Guard::new(&strings(&["a.com"]), &[], Vec::new());
        assert_eq!(
            guard.vet(
                "a.com",
                80,
                &[ip("127.0.0.1"), ip("93.184.216.34"), ip("::1")]
            ),
            Ok(vec![ip("93.184.216.34")])
        );
        let both = Guard::new(&[], &[], Vec::new());
        for order in [
            [ip("169.254.1.1"), ip("127.0.0.1")],
            [ip("127.0.0.1"), ip("169.254.1.1")],
        ] {
            assert_eq!(
                both.vet("a.com", 80, &order).unwrap_err().message,
                "Connection to a.com blocked: resolved to a loopback address / a link-local address"
            );
        }
        assert_eq!(both.vet("a.com", 80, &[]), Ok(Vec::new()));
    }

    #[test]
    fn listed_literals_carve_out_and_deny() {
        let guard = Guard::new(
            &strings(&["a.com", "127.0.0.1:8080", "[::1]", "169.254.169.254"]),
            &strings(&["10.0.0.0", "93.184.216.34:443", "*.bad.com"]),
            Vec::new(),
        );
        assert_eq!(
            guard.vet("a.com", 8080, &[ip("127.0.0.1")]),
            Ok(vec![ip("127.0.0.1")])
        );
        assert!(
            guard.vet("a.com", 80, &[ip("127.0.0.1")]).is_err(),
            "the port is the entry's"
        );
        assert_eq!(guard.vet("a.com", 80, &[ip("::1")]), Ok(vec![ip("::1")]));
        assert_eq!(
            guard.vet("a.com", 80, &[ip("::ffff:169.254.169.254")]),
            Ok(vec![ip("::ffff:169.254.169.254")]),
            "a mapped answer is the IPv4 address"
        );
        // The carried form never earns a carve-out: `::1` carries 0.0.0.1.
        let carve = Guard::new(&strings(&["a.com", "0.0.0.1"]), &[], Vec::new());
        assert!(carve.vet("a.com", 80, &[ip("::1")]).is_err());
        assert_eq!(
            guard
                .vet("a.com", 80, &[ip("10.0.0.0")])
                .unwrap_err()
                .message,
            "Connection to a.com blocked: resolved to a deny-listed address"
        );
        assert!(
            guard.vet("a.com", 80, &[ip("64:ff9b::a00:0")]).is_err(),
            "carried"
        );
        assert!(guard.vet("a.com", 443, &[ip("93.184.216.34")]).is_err());
        assert!(guard.vet("a.com", 80, &[ip("93.184.216.34")]).is_ok());
        // IP literal destinations are not re-judged.
        assert_eq!(
            guard.vet("127.0.0.1", 80, &[ip("127.0.0.1")]),
            Ok(vec![ip("127.0.0.1")])
        );
    }

    #[test]
    fn localhost_must_stay_loopback() {
        let guard = Guard::new(
            &strings(&["localhost", "10.1.1.1"]),
            &[],
            vec![ip("127.0.0.1")],
        );
        assert_eq!(
            guard.vet("localhost", 80, &[ip("::1"), ip("127.0.0.1")]),
            Ok(vec![ip("::1"), ip("127.0.0.1")])
        );
        assert_eq!(
            guard
                .vet("app.localhost", 80, &[ip("93.184.216.34")])
                .unwrap_err()
                .message,
            "Connection to app.localhost blocked: resolved to a non-loopback address"
        );
        assert!(
            guard.vet("localhost", 80, &[ip("10.1.1.1")]).is_ok(),
            "an allowed literal"
        );
    }

    #[test]
    fn lists_this_hosts_addresses() {
        let local = local_addresses();
        assert!(local.iter().any(|a| a.is_loopback()), "{local:?}");
    }
}
