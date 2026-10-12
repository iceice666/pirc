//! Which hosts the agent's browser may reach: a port of
//! `node/browser-hosts.ts` (its tests in `browser-hosts.test.ts`). Public
//! internet hosts only, unless the node operator allows private ones
//! (`PIRC_BROWSER_ALLOW_PRIVATE`); never the gateway itself unless named
//! explicitly; `PIRC_BROWSER_BLOCK_HOSTS` always. Names are resolved with
//! the system resolver (every address must pass), results cached 30 s.
//!
//! Chromium runs on the node outside the OS sandbox, so without this check
//! an agent could drive it into the gateway's own UI and API, cloud
//! metadata (169.254.169.254), the node's loopback services and the LAN.
//!
//! Limitation (as in TS): Chromium resolves names again on its own, so a
//! DNS-rebinding host could still answer a private address after passing
//! this check. The short cache narrows, but does not close, that window.
//!
//! Also kept from TS as they are (parity):
//!
//! - IPv6 ranges that reach other addresses are not classified:
//!   `64:ff9b:1::/48` (local-use NAT64, RFC 8215: on such a network
//!   `http://[64:ff9b:1::a00:1]/` reaches 10.0.0.1), `2001::/32` (Teredo),
//!   `::ffff:0:0:0/96` (SIIT) and `100::/64` (discard-only).
//! - The gateway is refused by name only: its IP literal, or another DNS
//!   name for it, passes the gateway rule (operators can list those in
//!   `PIRC_BROWSER_BLOCK_HOSTS`); and any allow rule matching its name, a
//!   `*.suffix` rule included, exempts it, not only an exact host rule.
//!
//! URLs are parsed with the `url` crate (WHATWG, as `new URL` is: e.g.
//! `http://2130706433/` is `127.0.0.1`).
//!
//! Owner: netio.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pirc_config::node::BrowserSettings;

use super::BoxFuture;
use crate::error::{ApiError, ApiResult};

/// Resolves a host name to all its addresses (`dns.lookup(host, {all:
/// true, verbatim: true})`); the error is the resolver's message.
pub type Resolver =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Vec<IpAddr>, String>> + Send + Sync>;

const CACHE_TTL: Duration = Duration::from_millis(30_000);
const CACHE_MAX: usize = 1_000;

/// Why an IP address is not public, or `None` when it is
/// (`privateAddressKind`).
pub fn private_address_kind(address: &str) -> Option<&'static str> {
    if let Some(v4) = parse_ipv4(address) {
        return ipv4_kind(v4);
    }
    ipv6_kind(&parse_ipv6(address)?)
}

/// `parseIPv4`: exactly four dot-separated decimal parts of 1–3 digits,
/// each at most 255 (leading zeros are decimal).
fn parse_ipv4(text: &str) -> Option<u32> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut value: u32 = 0;
    for part in parts {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let byte: u32 = part.parse().ok()?;
        if byte > 255 {
            return None;
        }
        value = value * 256 + byte;
    }
    Some(value)
}

const V4_RANGES: &[(&str, u32, &str)] = &[
    ("0.0.0.0", 8, "unspecified"),
    ("10.0.0.0", 8, "private"),
    ("100.64.0.0", 10, "carrier-grade NAT"),
    ("127.0.0.0", 8, "loopback"),
    ("169.254.0.0", 16, "link-local"),
    ("172.16.0.0", 12, "private"),
    ("192.0.0.0", 24, "reserved"),
    ("192.0.2.0", 24, "reserved"),
    ("192.88.99.0", 24, "reserved"),
    ("192.168.0.0", 16, "private"),
    ("198.18.0.0", 15, "reserved"),
    ("198.51.100.0", 24, "reserved"),
    ("203.0.113.0", 24, "reserved"),
    ("224.0.0.0", 4, "multicast"),
    ("240.0.0.0", 4, "reserved"),
];

fn in_v4(address: u32, base: u32, bits: u32) -> bool {
    bits == 0 || (address >> (32 - bits)) == (base >> (32 - bits))
}

fn ipv4_kind(address: u32) -> Option<&'static str> {
    V4_RANGES.iter().find_map(|&(base, bits, kind)| {
        let base = parse_ipv4(base).expect("valid range");
        in_v4(address, base, bits).then_some(kind)
    })
}

/// `parseIPv6`: eight 16-bit groups, or `None`. Accepts `::`, embedded
/// dotted IPv4, brackets and zone ids.
fn parse_ipv6(text: &str) -> Option<[u16; 8]> {
    let mut raw = text.trim();
    if raw.starts_with('[') && raw.ends_with(']') && raw.len() >= 2 {
        raw = &raw[1..raw.len() - 1];
    }
    // `.replace(/%.*$/, '')`: `.` stops at line terminators.
    let mut raw = match raw.find('%') {
        Some(at) if !raw[at..].contains(['\n', '\r', '\u{2028}', '\u{2029}']) => {
            raw[..at].to_owned()
        }
        Some(_) => return None,
        None => raw.to_owned(),
    };
    if !raw.contains(':') {
        return None;
    }
    let mut tail: Vec<u32> = Vec::new();
    let last_colon = raw.rfind(':').expect("has a colon");
    let last = &raw[last_colon + 1..];
    if last.contains('.') {
        let v4 = parse_ipv4(last)?;
        tail = vec![v4 / 65536, v4 % 65536];
        // `::ffff:1.2.3.4` → `::ffff` + two groups; `::1.2.3.4` → `::` + two groups.
        raw.truncate(last_colon);
        if raw.ends_with(':') {
            raw.push(':');
        }
    }
    let halves: Vec<&str> = raw.split("::").collect();
    if halves.len() > 2 {
        return None;
    }
    let groups = |part: &str| -> Option<Vec<u32>> {
        if part.is_empty() {
            return Some(Vec::new());
        }
        part.split(':')
            .map(|item| {
                (!item.is_empty() && item.len() <= 4 && item.bytes().all(|b| b.is_ascii_hexdigit()))
                    .then(|| u32::from_str_radix(item, 16).expect("hex"))
            })
            .collect()
    };
    let a = groups(halves[0])?;
    let mut b = if halves.len() == 2 {
        groups(halves[1])?
    } else {
        Vec::new()
    };
    b.extend(tail);
    let missing = 8 - a.len() as i64 - b.len() as i64;
    if (halves.len() == 1 && missing != 0) || (halves.len() == 2 && missing < 1) {
        return None;
    }
    let mut out = [0u16; 8];
    let all = a
        .iter()
        .copied()
        .chain(std::iter::repeat_n(0, missing.max(0) as usize))
        .chain(b);
    for (slot, value) in out.iter_mut().zip(all) {
        *slot = value as u16;
    }
    Some(out)
}

fn ipv6_kind(g: &[u16; 8]) -> Option<&'static str> {
    let embedded = |hi: u16, lo: u16| ipv4_kind(u32::from(hi) * 65536 + u32::from(lo));
    if g.iter().all(|&x| x == 0) {
        return Some("unspecified");
    }
    if g[..7].iter().all(|&x| x == 0) && g[7] == 1 {
        return Some("loopback");
    }
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the IPv4 rules apply.
    if g[..5].iter().all(|&x| x == 0) && (g[5] == 0xffff || g[5] == 0) {
        return embedded(g[6], g[7]).or(if g[5] == 0 { Some("reserved") } else { None });
    }
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address too.
    if g[0] == 0x64 && g[1] == 0xff9b && g[2..6].iter().all(|&x| x == 0) {
        return embedded(g[6], g[7]);
    }
    if g[0] == 0x2002 {
        return embedded(g[1], g[2]);
    }
    let first = g[0];
    if first & 0xfe00 == 0xfc00 {
        return Some("unique-local");
    }
    if first & 0xffc0 == 0xfe80 {
        return Some("link-local");
    }
    if first & 0xffc0 == 0xfec0 {
        return Some("site-local");
    }
    if first & 0xff00 == 0xff00 {
        return Some("multicast");
    }
    if first == 0x2001 && g[1] == 0x0db8 {
        return Some("reserved");
    }
    None
}

/// Host names that only ever mean something on this machine or network
/// (`localNameKind`).
pub fn local_name_kind(hostname: &str) -> Option<&'static str> {
    let lower = hostname.to_lowercase();
    let host = lower.strip_suffix('.').unwrap_or(&lower);
    if host == "localhost" || host.ends_with(".localhost") {
        return Some("loopback");
    }
    for suffix in [
        ".local",
        ".internal",
        ".home.arpa",
        ".lan",
        ".intranet",
        ".corp",
    ] {
        if host.ends_with(suffix) || host == &suffix[1..] {
            return Some("local network");
        }
    }
    None
}

/// One `PIRC_BROWSER_ALLOW_PRIVATE` entry (`AllowRule`).
#[derive(Clone, Debug)]
pub enum AllowRule {
    /// Every address is IPv4 (or IPv4-mapped) inside the range.
    V4 { base: u32, bits: u32 },
    /// Every address is IPv6 inside the range.
    V6 { base: [u16; 8], bits: u32 },
    /// The URL host itself.
    Host(String),
    /// `*.suffix`: the URL host ends with `.suffix`.
    Suffix(String),
}

impl AllowRule {
    pub fn matches(&self, host: &str, addresses: &[String]) -> bool {
        match self {
            Self::V4 { base, bits } => {
                !addresses.is_empty()
                    && addresses.iter().all(|address| {
                        parse_ipv4(address)
                            .or_else(|| mapped_v4(address))
                            .is_some_and(|value| in_v4(value, *base, *bits))
                    })
            }
            Self::V6 { base, bits } => {
                !addresses.is_empty()
                    && addresses.iter().all(|address| {
                        parse_ipv6(address).is_some_and(|value| prefix_equal(&value, base, *bits))
                    })
            }
            Self::Host(entry) => normalize_host(host) == *entry,
            Self::Suffix(suffix) => normalize_host(host).ends_with(suffix.as_str()),
        }
    }
}

/// JavaScript's `Number(text)` for the prefix length of a CIDR entry
/// (`Number('')` is 0, whitespace is trimmed, `0x`/`0o`/`0b` prefixes).
fn js_number(text: Option<&str>) -> f64 {
    let Some(text) = text else {
        return f64::NAN; // `Number(undefined)`
    };
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix)
                .ok()
                .filter(|_| !digits.starts_with(['+', '-']))
                .map_or(f64::NAN, |value| value as f64);
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// The prefix length for `cidr`: the default when absent, else an integer
/// in `0..=max` (`Number.isInteger(bits) && 0 <= bits <= max`).
fn prefix_bits(text: Option<&str>, max: u32) -> Option<u32> {
    let Some(text) = text else {
        return Some(max);
    };
    let bits = js_number(Some(text));
    (bits.is_finite() && bits.fract() == 0.0 && (0.0..=f64::from(max)).contains(&bits))
        .then_some(bits as u32)
}

fn cidr(text: &str) -> Option<AllowRule> {
    // `text.split('/')` destructured to `[base, bitsText]`: later parts are ignored.
    let mut parts = text.split('/');
    let base = parts.next().filter(|base| !base.is_empty())?;
    let bits_text = parts.next();
    if let Some(v4) = parse_ipv4(base) {
        let bits = prefix_bits(bits_text, 32)?;
        return Some(AllowRule::V4 { base: v4, bits });
    }
    if let Some(v6) = parse_ipv6(base) {
        let bits = prefix_bits(bits_text, 128)?;
        return Some(AllowRule::V6 { base: v6, bits });
    }
    None
}

fn mapped_v4(address: &str) -> Option<u32> {
    let g = parse_ipv6(address)?;
    if !g[..5].iter().all(|&x| x == 0) || g[5] != 0xffff {
        return None;
    }
    Some(u32::from(g[6]) * 65536 + u32::from(g[7]))
}

fn prefix_equal(a: &[u16; 8], b: &[u16; 8], bits: u32) -> bool {
    let mut bits = bits as i64;
    let mut i = 0;
    while i < 8 && bits > 0 {
        let mask: u16 = if bits >= 16 {
            0xffff
        } else {
            ((0xffffu32 << (16 - bits)) & 0xffff) as u16
        };
        if a[i] & mask != b[i] & mask {
            return false;
        }
        i += 1;
        bits -= 16;
    }
    true
}

/// The parsed `PIRC_BROWSER_ALLOW_PRIVATE` entries (`parseAllowRules`).
#[derive(Clone, Debug, Default)]
pub struct AllowRules {
    /// `*`: no private-address check at all.
    pub any: bool,
    pub rules: Vec<AllowRule>,
}

impl AllowRules {
    fn matches(&self, host: &str, addresses: &[String]) -> bool {
        self.rules.iter().any(|rule| rule.matches(host, addresses))
    }
}

/// `PIRC_BROWSER_ALLOW_PRIVATE` entries: `*` (no private-address check at
/// all), an exact host name (`nas.lan`), a `*.suffix` wildcard, an IP
/// address or a CIDR range (`192.168.1.0/24`, `fd00::/8`). Ports are
/// ignored (`parseAllowRules`).
pub fn parse_allow_rules<S: AsRef<str>>(entries: &[S]) -> AllowRules {
    let mut allow = AllowRules::default();
    for raw in entries {
        let entry = raw.as_ref().trim().to_lowercase();
        if entry.is_empty() {
            continue;
        }
        if entry == "*" {
            allow.any = true;
            continue;
        }
        // `entry.replace(/^\[|\]$/g, '')`
        let unbracketed = entry.strip_prefix('[').unwrap_or(&entry);
        let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
        if let Some(range) = cidr(unbracketed) {
            allow.rules.push(range);
            // An IP literal may also appear as the URL host itself.
            if !entry.contains('/') {
                allow.rules.push(AllowRule::Host(normalize_host(&entry)));
            }
            continue;
        }
        match entry.strip_prefix('*') {
            Some(suffix) if suffix.starts_with('.') => {
                allow.rules.push(AllowRule::Suffix(suffix.to_owned()));
            }
            _ => allow.rules.push(AllowRule::Host(entry)),
        }
    }
    allow
}

/// `normalizeHost`: lower case, without brackets or the final dot.
fn normalize_host(host: &str) -> String {
    let lower = host.to_lowercase();
    let host = lower.strip_prefix('[').unwrap_or(&lower);
    let host = host.strip_suffix(']').unwrap_or(host);
    host.strip_suffix('.').unwrap_or(host).to_owned()
}

/// The system resolver: `getaddrinfo` (tokio's `lookup_host`), every
/// address in its order (as Node's `verbatim: true`), duplicates (one per
/// socket type) dropped.
pub fn system_resolver() -> Resolver {
    Arc::new(|host: String| {
        Box::pin(async move {
            let found = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| error.to_string())?;
            let mut seen = HashSet::new();
            Ok(found
                .map(|address| address.ip())
                .filter(|ip| seen.insert(*ip))
                .collect())
        })
    })
}

/// Decides, with a short cache, whether the browser may contact a URL's
/// host (`BrowserHostGuard`).
pub struct HostGuard {
    allow: AllowRules,
    gateway: HashSet<String>,
    resolver: Resolver,
    cache: Mutex<HashMap<String, (Instant, Option<String>)>>,
    /// By frame id: the redirect hop the guard refused in the frame's
    /// latest navigation, and why (see [`HostGuard::refused_hop`]).
    refused_hops: Mutex<HashMap<String, (String, String)>>,
}

/// How many frames' refused hops are kept before they are all forgotten.
const REFUSED_HOPS_MAX: usize = 1_000;

impl HostGuard {
    pub fn new(settings: &BrowserSettings) -> Self {
        Self::with_resolver(settings, system_resolver())
    }

    /// With another resolver (tests).
    pub fn with_resolver(settings: &BrowserSettings, resolver: Resolver) -> Self {
        Self::from_policy(
            &settings.allow_private_hosts,
            Some(&settings.gateway_host),
            &settings.blocked_hosts,
            resolver,
        )
    }

    /// From the policy's parts (`BrowserHostPolicy`): the allowlist, the
    /// gateway's host and the further blocked names (entries may carry a
    /// port, which is ignored).
    pub fn from_policy<S: AsRef<str>>(
        allow_private_hosts: &[S],
        gateway_host: Option<&str>,
        blocked_hosts: &[S],
        resolver: Resolver,
    ) -> Self {
        let gateway = gateway_host
            .into_iter()
            .chain(blocked_hosts.iter().map(AsRef::as_ref))
            .filter(|host| !host.trim().is_empty())
            .map(|host| normalize_host(strip_port(host.trim())))
            .collect();
        Self {
            allow: parse_allow_rules(allow_private_hosts),
            gateway,
            resolver,
            cache: Mutex::default(),
            refused_hops: Mutex::default(),
        }
    }

    /// The redirect hop (its URL with the fragment, the reason) the request
    /// interception refused in frame `frame_id`'s latest navigation, if it
    /// refused one. TS let Playwright follow such a hop and named the
    /// frame's URL there in its error; the manager names this URL instead
    /// (see [`super::engine::network`]).
    pub fn refused_hop(&self, frame_id: &str) -> Option<(String, String)> {
        self.refused_hops.lock().unwrap().get(frame_id).cloned()
    }

    /// Remember that a navigation of `frame_id` was refused at a redirect
    /// hop to `url`.
    pub fn note_refused_hop(&self, frame_id: &str, url: String, reason: String) {
        if frame_id.is_empty() {
            return;
        }
        let mut hops = self.refused_hops.lock().unwrap();
        if hops.len() >= REFUSED_HOPS_MAX {
            hops.clear();
        }
        hops.insert(frame_id.to_owned(), (url, reason));
    }

    /// `frame_id` starts another navigation: forget its refused hop.
    pub fn forget_refused_hop(&self, frame_id: &str) {
        self.refused_hops.lock().unwrap().remove(frame_id);
    }

    /// Why `url` may not be opened, or `None` when it may.
    pub async fn blocked_reason(&self, url: &str) -> Option<String> {
        let Ok(parsed) = url::Url::parse(url) else {
            return Some("not a valid URL".into());
        };
        // Only network schemes reach a host; data:, blob:, about: never do.
        if !matches!(parsed.scheme(), "http" | "https" | "ws" | "wss") {
            return None;
        }
        let host = normalize_host(parsed.host_str().unwrap_or(""));
        if let Some((until, reason)) = self.cache.lock().unwrap().get(&host)
            && *until > Instant::now()
        {
            return reason.clone();
        }
        let reason = self.decide(&host).await;
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(host, (Instant::now() + CACHE_TTL, reason.clone()));
        reason
    }

    /// A clear, agent-facing error when the URL is refused (`check`).
    pub async fn check(&self, url: &str) -> ApiResult<()> {
        match self.blocked_reason(url).await {
            Some(reason) => Err(blocked_error(url, &reason)),
            None => Ok(()),
        }
    }

    async fn decide(&self, host: &str) -> Option<String> {
        let explicit = |addresses: &[String]| self.allow.matches(host, addresses);
        if self.gateway.contains(host) {
            return if explicit(&[]) {
                None
            } else {
                Some("it is the pirc gateway this node connects to".into())
            };
        }
        if host.is_empty() {
            return Some("it has no host".into());
        }
        let literal = private_address_kind(host);
        let addresses: Vec<String> = if parse_ipv4(host).is_some() || parse_ipv6(host).is_some() {
            vec![host.to_owned()]
        } else {
            if let Some(name) = local_name_kind(host) {
                return if self.allow.any || explicit(&[]) {
                    None
                } else {
                    Some(format!("{host} is a {name} name"))
                };
            }
            match (self.resolver)(host.to_owned()).await {
                Ok(addresses) if !addresses.is_empty() => {
                    addresses.iter().map(IpAddr::to_string).collect()
                }
                _ => return Some(format!("{host} could not be resolved")),
            }
        };
        if self.allow.any || explicit(&addresses) {
            return None;
        }
        if let Some(literal) = literal {
            return Some(format!("{host} is a {literal} address"));
        }
        addresses.iter().find_map(|address| {
            private_address_kind(address)
                .map(|kind| format!("{host} resolves to a {kind} address ({address})"))
        })
    }
}

/// `host.replace(/:\d+$/, '')`.
fn strip_port(host: &str) -> &str {
    match host.rfind(':') {
        Some(at) if at + 1 < host.len() && host[at + 1..].bytes().all(|b| b.is_ascii_digit()) => {
            &host[..at]
        }
        _ => host,
    }
}

/// `blockedError(url, reason)`: 403 `forbidden`, "The browser may not open
/// <url>: <reason>. Agent browsing is limited to …".
///
/// The URL is cut to its first 200 UTF-16 code units (`url.slice(0,
/// 200)`); where that would split a surrogate pair, the whole character is
/// dropped (JS would keep a lone surrogate, which a Rust string cannot
/// hold).
pub fn blocked_error(url: &str, reason: &str) -> ApiError {
    let mut units = 0;
    let end = url
        .char_indices()
        .find(|&(_, c)| {
            units += c.len_utf16();
            units > 200
        })
        .map_or(url.len(), |(at, _)| at);
    ApiError::forbidden(format!(
        "The browser may not open {}: {reason}. Agent browsing is limited to public \
         internet hosts; local, private and the pirc gateway itself are blocked unless the node \
         operator allows them (PIRC_BROWSER_ALLOW_PRIVATE).",
        &url[..end]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_non_public_ipv4_addresses() {
        for (address, kind) in [
            ("127.0.0.1", "loopback"),
            ("127.255.0.9", "loopback"),
            ("0.0.0.0", "unspecified"),
            ("10.1.2.3", "private"),
            ("172.16.0.1", "private"),
            ("172.31.255.255", "private"),
            ("192.168.1.1", "private"),
            ("100.64.0.1", "carrier-grade NAT"),
            ("100.127.255.254", "carrier-grade NAT"),
            ("169.254.169.254", "link-local"),
            ("224.0.0.1", "multicast"),
            ("255.255.255.255", "reserved"),
        ] {
            assert_eq!(private_address_kind(address), Some(kind), "{address}");
        }
    }

    #[test]
    fn passes_public_ipv4_addresses() {
        for address in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "172.15.255.255",
        ] {
            assert_eq!(private_address_kind(address), None, "{address}");
        }
    }

    #[test]
    fn flags_non_public_ipv6_addresses_including_embedded_ipv4() {
        for (address, kind) in [
            ("::1", "loopback"),
            ("[::1]", "loopback"),
            ("::", "unspecified"),
            ("fd00::1", "unique-local"),
            ("fc12:3456::9", "unique-local"),
            ("fe80::1%en0", "link-local"),
            ("ff02::1", "multicast"),
            ("::ffff:127.0.0.1", "loopback"),
            ("::ffff:7f00:1", "loopback"),
            ("::ffff:a9fe:a9fe", "link-local"),
            ("::ffff:192.168.0.1", "private"),
            ("64:ff9b::a00:1", "private"),
            ("2002:c0a8:0101::1", "private"),
        ] {
            assert_eq!(private_address_kind(address), Some(kind), "{address}");
        }
    }

    #[test]
    fn passes_public_ipv6_addresses() {
        for address in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert_eq!(private_address_kind(address), None, "{address}");
        }
    }

    #[test]
    fn flags_local_only_names() {
        assert_eq!(local_name_kind("localhost"), Some("loopback"));
        assert_eq!(local_name_kind("app.localhost."), Some("loopback"));
        assert_eq!(local_name_kind("printer.local"), Some("local network"));
        assert_eq!(
            local_name_kind("metadata.google.internal"),
            Some("local network")
        );
        assert_eq!(local_name_kind("router.home.arpa"), Some("local network"));
        assert_eq!(local_name_kind("example.com"), None);
        assert_eq!(local_name_kind("localhost.example.com"), None);
    }

    #[test]
    fn parses_the_allowlist() {
        assert!(parse_allow_rules(&["*"]).any);
        let allow = parse_allow_rules(&["nas.lan", "*.dev.test", "192.168.1.0/24", "fd00::/8"]);
        assert!(!allow.any);
        let allowed = |host: &str, addresses: &[&str]| {
            let addresses: Vec<String> = addresses.iter().map(|a| (*a).to_owned()).collect();
            allow.matches(host, &addresses)
        };
        assert!(allowed("nas.lan", &[]));
        assert!(allowed("a.dev.test", &[]));
        assert!(allowed("x", &["192.168.1.20"]));
        assert!(!allowed("x", &["192.168.1.20", "10.0.0.1"]));
        assert!(allowed("x", &["fd12::1"]));
        assert!(!allowed("x", &["192.168.2.1"]));
    }

    /// Edge cases of the JS parsing this port reproduces.
    #[test]
    fn keeps_the_javascript_parsing_quirks() {
        // `Number('')` is 0: an empty prefix length allows every IPv4 address.
        let allow = parse_allow_rules(&["10.0.0.0/"]);
        assert!(allow.matches("x", &["8.8.8.8".into()]));
        assert!(parse_allow_rules(&["10.0.0.0/33"]).rules.len() == 1); // a host rule
        assert!(parse_allow_rules(&["10.0.0.0/0x8"]).matches("x", &["10.9.9.9".into()]));
        // An IP literal is also matched as the URL host itself.
        assert!(parse_allow_rules(&["[::1]"]).matches("[::1]", &[]));
        // IPv4-mapped addresses match IPv4 ranges.
        assert!(parse_allow_rules(&["127.0.0.0/8"]).matches("x", &["::ffff:127.0.0.1".into()]));
        assert_eq!(parse_ipv4("010.0.0.1"), Some(0x0a00_0001));
        assert_eq!(parse_ipv4("1.2.3"), None);
        assert_eq!(parse_ipv6("1:2:3:4:5:6:7"), None);
        assert_eq!(parse_ipv6("1::2::3"), None);
        assert_eq!(
            parse_ipv6("1:2:3:4:5:6:7:8"),
            Some([1, 2, 3, 4, 5, 6, 7, 8])
        );
        assert_eq!(
            parse_ipv6("1:2:3:4:5:6:7::"),
            Some([1, 2, 3, 4, 5, 6, 7, 0])
        );
        assert_eq!(
            parse_ipv6("::1.2.3.4"),
            Some([0, 0, 0, 0, 0, 0, 0x102, 0x304])
        );
        assert_eq!(private_address_kind("::8.8.8.8"), Some("reserved"));
        assert_eq!(strip_port("ui.example:8443"), "ui.example");
        assert_eq!(strip_port("[::1]:80"), "[::1]");
    }

    fn resolver() -> Resolver {
        Arc::new(|host: String| {
            Box::pin(async move {
                let addresses: &[&str] = match host.as_str() {
                    "example.com" => &["93.184.215.14"],
                    "rebind.example" => &["127.0.0.1"],
                    "mixed.example" => &["93.184.215.14", "10.0.0.5"],
                    "nas.example" => &["192.168.1.10"],
                    "pirc.example" => &["203.0.114.7"],
                    _ => return Err("ENOTFOUND".to_owned()),
                };
                Ok(addresses.iter().map(|a| a.parse().unwrap()).collect())
            })
        })
    }

    fn guard(allow: &[&str], gateway: &str, blocked: &[&str]) -> HostGuard {
        let allow: Vec<String> = allow.iter().map(|s| (*s).to_owned()).collect();
        let blocked: Vec<String> = blocked.iter().map(|s| (*s).to_owned()).collect();
        HostGuard::from_policy(&allow, Some(gateway), &blocked, resolver())
    }

    async fn contains(guard: &HostGuard, url: &str, part: &str) {
        let reason = guard.blocked_reason(url).await;
        assert!(
            reason.as_deref().is_some_and(|r| r.contains(part)),
            "{url}: {reason:?} should contain {part:?}"
        );
    }

    #[tokio::test]
    async fn blocks_private_destinations_with_an_agent_readable_error() {
        let guard = guard(&[], "pirc.example", &["ui.example:8443"]);
        assert_eq!(guard.blocked_reason("https://example.com/").await, None);
        contains(&guard, "https://UI.example:8443/", "gateway").await;
        contains(&guard, "http://127.0.0.1:8787/api", "loopback").await;
        contains(&guard, "http://2130706433/", "loopback").await;
        contains(&guard, "http://[::1]:3000/", "loopback").await;
        contains(&guard, "http://169.254.169.254/latest", "link-local").await;
        contains(&guard, "http://rebind.example/", "resolves to a loopback").await;
        contains(&guard, "https://mixed.example/", "private").await;
        contains(&guard, "http://localhost:5173/", "loopback").await;
        contains(&guard, "http://printer.local/", "local network").await;
        contains(&guard, "https://pirc.example/", "gateway").await;
        contains(&guard, "wss://pirc.example/node/connect", "gateway").await;
        contains(&guard, "https://nowhere.example/", "could not be resolved").await;
        // Never a network host.
        assert_eq!(guard.blocked_reason("about:blank").await, None);
        assert_eq!(guard.blocked_reason("data:text/html,hi").await, None);
        let error = guard.check("http://10.0.0.1/").await.unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "forbidden");
        assert!(error.message.contains("PIRC_BROWSER_ALLOW_PRIVATE"));
    }

    #[tokio::test]
    async fn honours_the_node_allowlist_but_keeps_the_gateway_blocked_under_star() {
        let guard = guard(
            &["nas.example", "127.0.0.1", "localhost"],
            "pirc.example",
            &[],
        );
        assert_eq!(guard.blocked_reason("http://nas.example/").await, None);
        assert_eq!(guard.blocked_reason("http://127.0.0.1:3000/").await, None);
        assert_eq!(guard.blocked_reason("http://localhost:3000/").await, None);
        contains(&guard, "http://10.0.0.1/", "private").await;
        let all = self::guard(&["*"], "pirc.example", &[]);
        assert_eq!(all.blocked_reason("http://10.0.0.1/").await, None);
        assert_eq!(all.blocked_reason("http://printer.local/").await, None);
        contains(&all, "https://pirc.example/", "gateway").await;
        let explicit = self::guard(&["pirc.example"], "pirc.example", &[]);
        assert_eq!(explicit.blocked_reason("https://pirc.example/").await, None);
    }

    #[tokio::test]
    async fn words_its_reasons_and_error_as_ts() {
        let guard = guard(&[], "", &[]);
        assert_eq!(
            guard.blocked_reason("http://10.0.0.1/").await.as_deref(),
            Some("10.0.0.1 is a private address")
        );
        assert_eq!(
            guard
                .blocked_reason("http://mixed.example/")
                .await
                .as_deref(),
            Some("mixed.example resolves to a private address (10.0.0.5)")
        );
        assert_eq!(
            guard
                .blocked_reason("http://printer.local./")
                .await
                .as_deref(),
            Some("printer.local is a local network name")
        );
        assert_eq!(
            guard.blocked_reason("http://[fe80::1]/").await.as_deref(),
            Some("fe80::1 is a link-local address")
        );
        assert_eq!(
            guard.blocked_reason("not a url").await.as_deref(),
            Some("not a valid URL")
        );
        assert_eq!(guard.blocked_reason("file:///etc/passwd").await, None);
        let error = blocked_error(&format!("http://a/{}", "é".repeat(300)), "why");
        assert_eq!(
            error.body(),
            serde_json::json!({ "error": { "code": "forbidden", "message": format!(
                "The browser may not open http://a/{}: why. Agent browsing is limited to public \
                 internet hosts; local, private and the pirc gateway itself are blocked unless \
                 the node operator allows them (PIRC_BROWSER_ALLOW_PRIVATE).",
                "é".repeat(191)
            ) } })
        );
    }

    #[tokio::test]
    async fn caches_verdicts_per_host() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let resolver: Resolver = Arc::new(move |_host| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Ok(vec!["8.8.8.8".parse().unwrap()]) })
        });
        let guard = HostGuard::from_policy::<&str>(&[], None, &[], resolver);
        assert_eq!(guard.blocked_reason("https://a.example/x").await, None);
        assert_eq!(guard.blocked_reason("wss://A.example./y").await, None);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn remembers_a_frame_s_refused_hop_until_its_next_navigation() {
        let guard = guard(&[], "pirc.example", &[]);
        assert_eq!(guard.refused_hop("F1"), None);
        guard.note_refused_hop("F1", "http://10.0.0.1/#a".into(), "why".into());
        guard.note_refused_hop("", "http://10.0.0.2/".into(), "why".into());
        assert_eq!(
            guard.refused_hop("F1"),
            Some(("http://10.0.0.1/#a".into(), "why".into()))
        );
        assert_eq!(guard.refused_hop(""), None);
        guard.forget_refused_hop("F1");
        assert_eq!(guard.refused_hop("F1"), None);
        for index in 0..=REFUSED_HOPS_MAX {
            guard.note_refused_hop(&format!("F{index}"), String::new(), String::new());
        }
        assert!(guard.refused_hops.lock().unwrap().len() <= REFUSED_HOPS_MAX);
    }
}
