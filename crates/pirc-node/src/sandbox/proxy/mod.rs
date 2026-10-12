//! The native sandboxes' filtering proxy, shared by the Linux backend (a
//! Unix socket the in-sandbox bridge exposes as `127.0.0.1:3128` and
//! `:1080`) and the macOS backend (a loopback TCP port the Seatbelt profile
//! allows). Owner: **network**. Ported from sandbox-runtime 0.0.78
//! `mux-proxy.js`, `http-proxy.js`, `socks-proxy.js` and
//! `sandbox-manager.js` `filterNetworkRequest` (Apache-2.0, see
//! `crates/pirc-node/NOTICE`), for the settings pirc passes (`srtSettings`
//! in `node/sandbox.ts`): no TLS termination, MITM socket, credential
//! masking, parent proxy (the node drops `*_PROXY` from srt's environment)
//! or ask callback (the srt CLI has none; approvals arrive as new settings,
//! here [`Allowlist::set_approved`]).
//!
//! - One listener, srt's mux: a first byte of `0x04` or `0x05` is SOCKS
//!   ([`socks`]), anything else HTTP ([`http`]).
//! - Every client presents the session's [`ProxyAuth`] token, as srt does
//!   by default (`proxyAuthToken`, only absent when an external proxy port
//!   is configured): HTTP `Proxy-Authorization: Basic`, SOCKS5 RFC 1929.
//!   On macOS the proxy's port is reachable by every local process (and by
//!   other sessions with `allowLocalBinding`); on Linux the socket sits in
//!   the session's 0700 temp directory, and the token is defence in depth.
//! - A destination passes [`Allowlist::check`] (`filterNetworkRequest`:
//!   [`pattern::is_valid_host`], canonicalization, denied entries first,
//!   then allowed and approved ones), then a host name is resolved and its
//!   addresses vetted by [`address::Guard`] before the proxy connects.
//!
//! `allowLocalBinding` and `allowUnixSockets` are not the proxy's: on
//! Linux the agent has its own network namespace, so it may bind and
//! connect to its own loopback freely (no host service is reachable there)
//! and `allowLocalBinding` changes nothing; Unix sockets are not filtered
//! (pirc runs srt with `allowAllUnixSockets` on Linux, so no seccomp), only
//! hidden by the read rules. On macOS both are Seatbelt rules in the
//! profile (`allowLocalBinding` also opens `localhost:*` outbound, which is
//! why the token matters there); the proxy only needs its port
//! ([`ProxyListener::loopback`]).
//!
//! Beyond srt (M6): per-session and node-wide connection caps, since this
//! proxy shares the node's fd table; a 30 s deadline for request heads and
//! SOCKS handshakes (Node's server had its own header timeouts, the SOCKS
//! library none).

mod address;
mod env;
mod http;
mod pattern;
mod socks;

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use subtle::ConstantTimeEq;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf,
};
use tokio::net::{TcpListener, TcpStream, UnixListener};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub use env::{EnvPlatform, NO_PROXY, PROXY_USER, basic_authorization, env_vars};

/// Connections one session may hold open through the proxy. Each costs
/// the node two fds (client and upstream): srt's proxy lived in the
/// session's own process, this one shares the node's fd table.
const MAX_CONNECTIONS: usize = 64;
/// Connections all sessions' proxies may hold open together: 1024 fds,
/// small next to the soft `RLIMIT_NOFILE` the node raises to its hard limit
/// at start-up (systemd's default hard limit is 524288), so sandboxed
/// agents cannot starve the link, the database, terminals or other
/// sessions' spawns of fds.
pub const MAX_NODE_CONNECTIONS: usize = 512;
/// Pause after a failed `accept` (`EMFILE` and the like), so the loop does
/// not spin while the condition lasts.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// How long a client may take to send its request head or finish its SOCKS
/// handshake, and the proxy to reach the destination (srt's
/// `CONNECT_TIMEOUT_MS`).
const TIMEOUT: Duration = Duration::from_secs(30);
/// srt's mux: how long a client may wait before its first byte.
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(10);

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

    fn approved(&self) -> Vec<String> {
        self.approved
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Whether `host` may be reached on `port` ([`Self::check`]).
    pub fn allows(&self, host: &str, port: u16) -> bool {
        self.check(host, port).is_some()
    }

    /// srt's `filterNetworkRequest`: the canonical spelling of `host`
    /// (the one to connect to) when it may be reached on `port`.
    pub fn check(&self, host: &str, port: u16) -> Option<String> {
        if !pattern::is_valid_host(host) {
            return None;
        }
        let canonical = pattern::canonicalize_host(host).unwrap_or_else(|| host.to_owned());
        if self.is_denied(&canonical, port) {
            return None;
        }
        let allowed = self
            .allowed
            .iter()
            .chain(&self.approved())
            .any(|entry| pattern::matches(&canonical, port, entry));
        allowed.then_some(canonical)
    }

    /// Whether a denied entry matches (`canonical` is canonical already).
    fn is_denied(&self, canonical: &str, port: u16) -> bool {
        self.denied
            .iter()
            .any(|entry| pattern::matches(canonical, port, entry))
    }

    /// The resolved-address guard for one dial: the lists as they are now,
    /// this host's addresses as they are now.
    fn guard(&self) -> address::Guard {
        let mut allowed = self.allowed.clone();
        allowed.extend(self.approved());
        address::Guard::new(&allowed, &self.denied, address::local_addresses())
    }
}

/// The credential a session's clients present (srt's `proxyAuthToken`:
/// 16 random bytes in hex, generated when the proxy starts, exported only
/// into the sandbox's environment).
pub struct ProxyAuth {
    token: String,
}

impl ProxyAuth {
    pub fn generate() -> Self {
        let bytes = crate::util::random_bytes::<16>();
        Self {
            token: bytes.iter().map(|b| format!("{b:02x}")).collect(),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn is_token(&self, password: &[u8]) -> bool {
        bool::from(self.token.as_bytes().ct_eq(password))
    }

    /// `checkAuth`: a `Basic` credential whose password is the token (any
    /// non-empty user, as srt; the user is only an attribution label).
    fn accepts_basic(&self, header: Option<&str>) -> bool {
        use base64::Engine as _;
        let Some(header) = header else {
            return false;
        };
        let Some((scheme, encoded)) = header
            .trim_start()
            .split_once(|c: char| c.is_ascii_whitespace())
        else {
            return false;
        };
        let encoded = encoded.trim();
        let well_formed = scheme.eq_ignore_ascii_case("basic")
            && !encoded.is_empty()
            && encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
        if !well_formed {
            return false;
        }
        // Node's base64 decoding is lenient about padding.
        let lenient = base64::engine::GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                .with_decode_allow_trailing_bits(true),
        );
        let Ok(decoded) = lenient.decode(encoded.trim_end_matches('=')) else {
            return false;
        };
        match decoded.iter().position(|b| *b == b':') {
            Some(sep) if sep > 0 => self.is_token(&decoded[sep + 1..]),
            _ => false,
        }
    }

    /// The SOCKS5 user/password check: user `srt` or `srt.<label>`.
    fn accepts_socks(&self, user: &[u8], password: &[u8]) -> bool {
        let user_ok =
            user == PROXY_USER.as_bytes() || user.starts_with(format!("{PROXY_USER}.").as_bytes());
        user_ok & self.is_token(password)
    }
}

/// Where a session's proxy listens.
pub enum ProxyListener {
    /// Linux: a Unix socket in the session's temp directory, bound into
    /// the sandbox and bridged to `127.0.0.1:{3128,1080}`.
    Unix(UnixListener),
    /// macOS: a loopback TCP port, the only outbound address the Seatbelt
    /// profile allows.
    Tcp(TcpListener),
}

/// A client connection, whichever listener it came from.
trait Client: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Client for T {}

type Reader = BufReader<ReadHalf<Box<dyn Client>>>;
type Writer = WriteHalf<Box<dyn Client>>;

impl ProxyListener {
    /// A TCP listener on `127.0.0.1` and a free port, as srt's mux listens
    /// (macOS), with that port.
    pub async fn loopback() -> std::io::Result<(Self, u16)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        Ok((Self::Tcp(listener), port))
    }

    async fn accept(&self) -> std::io::Result<Box<dyn Client>> {
        match self {
            Self::Unix(listener) => Ok(Box::new(listener.accept().await?.0)),
            Self::Tcp(listener) => {
                let (stream, _) = listener.accept().await?;
                let _ = stream.set_nodelay(true);
                Ok(Box::new(stream))
            }
        }
    }
}

/// What every connection of a session's proxy shares.
struct Session {
    allowlist: Arc<Allowlist>,
    auth: Arc<ProxyAuth>,
}

/// Serve the session's proxy until the task is aborted (the session's
/// cleanup), which also ends every connection. `node` bounds the
/// connections of every session's proxy together.
pub async fn serve(
    listener: ProxyListener,
    allowlist: Arc<Allowlist>,
    auth: Arc<ProxyAuth>,
    node: Arc<Semaphore>,
) {
    let session = Arc::new(Session { allowlist, auth });
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok(client) = accepted else {
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                };
                if connections.len() >= MAX_CONNECTIONS {
                    drop(client);
                    continue;
                }
                let Ok(permit) = node.clone().try_acquire_owned() else {
                    drop(client);
                    continue;
                };
                let session = session.clone();
                connections.spawn(async move {
                    let _ = handle(client, &session).await;
                    drop(permit);
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// srt's mux: peek the first byte, then SOCKS or HTTP.
async fn handle(client: Box<dyn Client>, session: &Session) -> std::io::Result<()> {
    let (reader, writer) = tokio::io::split(client);
    let mut reader = BufReader::new(reader);
    let first = match tokio::time::timeout(FIRST_BYTE_TIMEOUT, reader.fill_buf()).await {
        Ok(Ok(buffer)) => buffer.first().copied(),
        Ok(Err(_)) | Err(_) => None,
    };
    match first {
        None => Ok(()),
        Some(0x04 | 0x05) => socks::handle(reader, writer, session).await,
        Some(_) => http::handle(reader, writer, session).await,
    }
}

/// Why a destination could not be reached.
enum DialError {
    /// The resolved-address guard refused every address (srt's
    /// `ResolvedAddressDeniedError`: a policy denial, not a failure).
    Denied(String),
    Failed,
}

/// `dialDirect` with the guard's lookup: an IP literal is connected to as
/// it is; a name is resolved once, its addresses vetted, and the survivors
/// tried in the resolver's order (Node's family fallback).
async fn dial(host: &str, port: u16, allowlist: &Allowlist) -> Result<TcpStream, DialError> {
    let attempt = async {
        let addresses: Vec<IpAddr> = match pattern::parse_ip(host) {
            Some(address) => vec![address],
            None => {
                let resolved = tokio::net::lookup_host((host, port))
                    .await
                    .map_err(|_| DialError::Failed)?;
                let resolved: Vec<IpAddr> = resolved.map(|address| address.ip()).collect();
                allowlist
                    .guard()
                    .vet(host, port, &resolved)
                    .map_err(|denied| DialError::Denied(denied.message))?
            }
        };
        for address in addresses {
            if let Ok(stream) = TcpStream::connect(SocketAddr::new(address, port)).await {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
        }
        Err(DialError::Failed)
    };
    tokio::time::timeout(TIMEOUT, attempt)
        .await
        .unwrap_or(Err(DialError::Failed))
}

/// An established tunnel: each direction relayed on its own, so a client
/// that half-closes still gets the reply; once the destination is done
/// (or the client fails), the connection ends, as srt's `close` handlers
/// do.
async fn relay(mut reader: Reader, mut writer: Writer, upstream: TcpStream) {
    let (mut upstream_read, mut upstream_write) = upstream.into_split();
    let upload = async {
        if tokio::io::copy(&mut reader, &mut upstream_write)
            .await
            .is_ok()
        {
            let _ = upstream_write.shutdown().await;
            std::future::pending::<()>().await;
        }
    };
    let download = async {
        let _ = tokio::io::copy(&mut upstream_read, &mut writer).await;
        let _ = writer.shutdown().await;
    };
    tokio::select! {
        () = upload => {}
        () = download => {}
    }
}

#[cfg(test)]
mod tests;
