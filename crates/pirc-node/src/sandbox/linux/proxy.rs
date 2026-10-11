//! The native sandbox's filtering proxy (spike C's, on tokio): HTTP
//! `CONNECT` tunnels and absolute-form `http://` requests from the
//! in-sandbox bridge, on a Unix socket, to the domains the session may
//! reach. Owner: **sandbox**.
//!
//! Matching follows srt's `matchesDomainPatternWithPort`: `*.example.com`
//! matches strict subdomains only (never an IP literal), other entries
//! match exactly, case-insensitively; an entry's `:port` restricts it to
//! that port. Hosts are canonicalized as WHATWG URLs do (the `url` crate;
//! srt's `canonicalizeHost`), so `127.1` is `127.0.0.1`. Denied domains win.

use std::net::IpAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio::task::JoinSet;

/// Longest request head (srt answered 431 past Node's limit).
const MAX_HEAD: usize = 64 * 1024;
/// Connections one session may hold open through the proxy.
const MAX_CONNECTIONS: usize = 256;
/// How long a client may take to send its request head, and the proxy to
/// reach the destination.
const TIMEOUT: Duration = Duration::from_secs(30);

/// srt's denial (`rawDenied` with `ALLOWLIST_DENY`).
const DENIED: &[u8] = b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Proxy-Error: blocked-by-allowlist\r\nConnection: close\r\n\r\nConnection blocked by network allowlist";

/// The domains a session may reach: its policy's, and the ones approved
/// since, which replace each other as srt's settings lines did.
pub struct Allowlist {
    allowed: Vec<String>,
    denied: Vec<String>,
    approved: RwLock<Vec<String>>,
}

impl Allowlist {
    pub fn new(allowed: Vec<String>, denied: Vec<String>) -> Self {
        Self {
            allowed,
            denied,
            approved: RwLock::new(Vec::new()),
        }
    }

    /// Every domain approved so far.
    pub fn set_approved(&self, approved: &[String]) {
        *self.approved.write().unwrap_or_else(|p| p.into_inner()) = approved.to_vec();
    }

    /// Whether `host` (canonical, lowercase) may be reached on `port`.
    pub fn allows(&self, host: &str, port: u16) -> bool {
        if self.denied.iter().any(|entry| matches(host, port, entry)) {
            return false;
        }
        self.allowed.iter().any(|entry| matches(host, port, entry))
            || self
                .approved
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .any(|entry| matches(host, port, entry))
    }
}

/// srt's `splitDomainPatternPort` for the entries `DOMAIN_PATTERN` admits
/// (no IPv6): a strictly numeric suffix in 1–65535 is a port.
fn split_port(entry: &str) -> (&str, Option<u16>) {
    let Some((host, port)) = entry.rsplit_once(':') else {
        return (entry, None);
    };
    let numeric = !port.is_empty()
        && port.len() <= 5
        && !port.starts_with('0')
        && port.bytes().all(|b| b.is_ascii_digit());
    match port.parse::<u16>() {
        Ok(port) if numeric && port > 0 && !host.contains(':') => (host, Some(port)),
        _ => (entry, None),
    }
}

/// srt's `matchesDomainPatternWithPort`.
fn matches(host: &str, port: u16, entry: &str) -> bool {
    let (pattern, entry_port) = split_port(entry);
    if entry_port.is_some_and(|entry_port| entry_port != port) {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    if let Some(base) = pattern.strip_prefix("*.") {
        if host.parse::<IpAddr>().is_ok() {
            return false;
        }
        return host
            .strip_suffix(&base.to_ascii_lowercase())
            .is_some_and(|rest| rest.ends_with('.'));
    }
    host.eq_ignore_ascii_case(pattern)
}

/// `host` and `port` of an `http://` URL (or a CONNECT authority made into
/// one), canonical: lowercase, IPv4 normalized, no trailing dot. IPv6
/// literals and anything unusual are refused (no entry can name them).
fn destination(url: &str, default_port: u16) -> Option<(String, u16)> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = match parsed.host()? {
        url::Host::Domain(domain) => domain.strip_suffix('.').unwrap_or(domain).to_owned(),
        url::Host::Ipv4(address) => address.to_string(),
        url::Host::Ipv6(_) => return None,
    };
    let valid = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_');
    valid.then(|| (host, parsed.port().unwrap_or(default_port)))
}

/// Serve the session's proxy until the task is aborted (the session's
/// cleanup), which also ends every connection.
pub async fn serve(listener: UnixListener, allowlist: Arc<Allowlist>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((client, _)) = accepted else {
                    continue;
                };
                if connections.len() >= MAX_CONNECTIONS {
                    drop(client);
                    continue;
                }
                let allowlist = allowlist.clone();
                connections.spawn(async move {
                    let _ = handle(client, &allowlist).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// The request head (through its blank line) and what followed it.
async fn read_head(client: &mut UnixStream) -> std::io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buffer.split_off(end + 4);
            return Ok(Some((buffer, rest)));
        }
        if buffer.len() > MAX_HEAD {
            client
                .write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
                .await?;
            return Ok(None);
        }
        let read = client.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

async fn handle(mut client: UnixStream, allowlist: &Allowlist) -> std::io::Result<()> {
    let Ok(head) = tokio::time::timeout(TIMEOUT, read_head(&mut client)).await else {
        return Ok(());
    };
    let Some((head, rest)) = head? else {
        return Ok(());
    };
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (method, target, version) = (
        request.next().unwrap_or_default(),
        request.next().unwrap_or_default(),
        request.next().unwrap_or("HTTP/1.1"),
    );
    let connect = method.eq_ignore_ascii_case("CONNECT");
    let (url, default_port) = if connect {
        (format!("http://{target}/"), 443)
    } else {
        (target.to_owned(), 80)
    };
    let scheme_ok = connect
        || target
            .get(..7)
            .is_some_and(|s| s.eq_ignore_ascii_case("http://"));
    let Some((host, port)) = destination(&url, default_port).filter(|_| scheme_ok) else {
        return client
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            .await;
    };
    if connect && !target.contains(':') {
        return client
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            .await;
    }
    if !allowlist.allows(&host, port) {
        return client.write_all(DENIED).await;
    }
    let upstream = tokio::time::timeout(TIMEOUT, TcpStream::connect((host.as_str(), port))).await;
    let Ok(Ok(mut upstream)) = upstream else {
        return client
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            .await;
    };
    if connect {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
    } else {
        // Origin form, without the proxy's own headers; one request per
        // connection, so what follows cannot reach another host unchecked.
        let parsed = url::Url::parse(target).map_err(std::io::Error::other)?;
        let path = match parsed.query() {
            Some(query) => format!("{}?{query}", parsed.path()),
            None => parsed.path().to_owned(),
        };
        let mut forwarded = format!("{method} {path} {version}\r\n");
        for line in lines.filter(|line| !line.is_empty()) {
            let name = line
                .split_once(':')
                .map_or(line, |(name, _)| name)
                .trim()
                .to_ascii_lowercase();
            if name.starts_with("proxy-") || name == "connection" || name == "keep-alive" {
                continue;
            }
            forwarded.push_str(line);
            forwarded.push_str("\r\n");
        }
        forwarded.push_str("Connection: close\r\n\r\n");
        upstream.write_all(forwarded.as_bytes()).await?;
    }
    if !rest.is_empty() {
        upstream.write_all(&rest).await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn matches_as_srt_does() {
        let list = Allowlist::new(
            vec![
                "github.com".into(),
                "*.example.com".into(),
                "api.test.io:8443".into(),
                "127.0.0.1:8080".into(),
            ],
            vec!["bad.example.com".into()],
        );
        assert!(list.allows("github.com", 443));
        assert!(!list.allows("api.github.com", 443));
        assert!(list.allows("a.b.example.com", 80));
        assert!(!list.allows("example.com", 80), "strict subdomains only");
        assert!(!list.allows("bad.example.com", 443), "denied wins");
        assert!(list.allows("api.test.io", 8443));
        assert!(!list.allows("api.test.io", 443));
        assert!(list.allows("127.0.0.1", 8080));
        assert!(!list.allows("127.0.0.1", 80));
        assert!(!list.allows("evil.com", 443));
        list.set_approved(&["evil.com".into()]);
        assert!(list.allows("evil.com", 443));
        list.set_approved(&[]);
        assert!(!list.allows("evil.com", 443));
        assert_eq!(split_port("a.com:0443"), ("a.com:0443", None));
        assert_eq!(split_port("a.com:99999"), ("a.com:99999", None));
    }

    #[test]
    fn destinations_are_canonical() {
        assert_eq!(
            destination("http://GitHub.COM./x", 80),
            Some(("github.com".into(), 80))
        );
        assert_eq!(
            destination("http://127.1:8080/", 80),
            Some(("127.0.0.1".into(), 8080))
        );
        assert_eq!(destination("http://[::1]/", 80), None);
        assert_eq!(destination("http://user@a.com/", 80), None);
        assert_eq!(destination("https://a.com/", 80), None);
        assert_eq!(destination("http://a%00b.com/", 80), None);
    }

    async fn upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let mut head = line.clone();
                    loop {
                        let mut next = String::new();
                        reader.read_line(&mut next).await.unwrap();
                        head.push_str(&next);
                        if next == "\r\n" || next.is_empty() {
                            break;
                        }
                    }
                    let body = head.replace("\r\n", "|");
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    reader
                        .into_inner()
                        .write_all(reply.as_bytes())
                        .await
                        .unwrap();
                });
            }
        });
        port
    }

    async fn ask(socket: &std::path::Path, request: &str) -> String {
        let mut stream = UnixStream::connect(socket).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn forwards_allowed_requests_and_refuses_the_rest() {
        let port = upstream().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("proxy.sock");
        let list = Arc::new(Allowlist::new(vec!["localhost".into()], Vec::new()));
        let task = tokio::spawn(serve(UnixListener::bind(&socket).unwrap(), list.clone()));

        let reply = ask(
            &socket,
            &format!(
                "GET http://localhost:{port}/a?b=1 HTTP/1.1\r\nHost: localhost:{port}\r\nProxy-Authorization: x\r\nConnection: keep-alive\r\n\r\n"
            ),
        )
        .await;
        assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
        assert!(
            reply.ends_with(&format!(
                "GET /a?b=1 HTTP/1.1|Host: localhost:{port}|Connection: close||"
            )),
            "{reply}"
        );

        let denied = ask(
            &socket,
            &format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n"),
        )
        .await;
        assert!(denied.starts_with("HTTP/1.1 403 Forbidden"), "{denied}");
        assert!(denied.ends_with("Connection blocked by network allowlist"));

        // CONNECT, once the address is approved.
        let mut tunnel = UnixStream::connect(&socket).await.unwrap();
        tunnel
            .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut answer = String::new();
        tunnel.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
        list.set_approved(&["127.0.0.1".into()]);
        let mut tunnel = UnixStream::connect(&socket).await.unwrap();
        tunnel
            .write_all(
                format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\nGET /t HTTP/1.1\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut answer = String::new();
        tunnel.read_to_string(&mut answer).await.unwrap();
        assert!(
            answer.starts_with("HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK"),
            "{answer}"
        );
        assert!(answer.ends_with("GET /t HTTP/1.1||"), "{answer}");

        let bad = ask(&socket, "GET /relative HTTP/1.1\r\n\r\n").await;
        assert!(bad.starts_with("HTTP/1.1 400"), "{bad}");
        let closed = ask(&socket, "GET http://localhost:1/ HTTP/1.1\r\n\r\n").await;
        assert!(closed.starts_with("HTTP/1.1 502"), "{closed}");
        task.abort();
    }
}
