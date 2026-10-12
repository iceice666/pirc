//! The proxy's SOCKS5 side. Ported from sandbox-runtime 0.0.78
//! `socks-proxy.js` and the parts of `@pondwader/socks5-server` 1.0.10
//! (MIT) it drives (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! Authentication is always on (srt's default `proxyAuthToken`):
//!
//! - A greeting offering user/password (RFC 1929) gets it; the user must
//!   be `srt` or `srt.<label>` and the password the session's token
//!   (`1 0`), else `1 1` and the connection closes.
//! - A greeting without it is refused without ever dialing (srt's
//!   `refuseUnauthenticated`): the proxy selects "no authentication", reads
//!   the `CONNECT` (5 s), and answers "connection not allowed", except on
//!   port 22, where it answers success and speaks just enough SSH to
//!   disconnect with the reason (the deny list's, else that the proxy
//!   needs authentication), which OpenSSH prints. This is what macOS's
//!   `nc -X 5` `GIT_SSH_COMMAND` gets.
//!
//! Then `CONNECT` only (`BIND` and `UDP ASSOCIATE` answer 7) to an IPv4,
//! domain or IPv6 destination; the destination passes the same allowlist
//! and resolved-address guard as HTTP. Replies carry a zero IPv4 bind
//! address: 0 granted, 2 not allowed (allowlist or guard), 4 unreachable.
//! A first byte of `0x04` (SOCKS4) reaches here and is closed.

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::pattern::{canonicalize_host, is_valid_host};
use super::{DialError, Gate, Reader, Session, TIMEOUT, Writer, dial, relay};

const VERSION: u8 = 0x05;
const NO_AUTH: u8 = 0x00;
const USER_PASSWORD: u8 = 0x02;
const CONNECT: u8 = 0x01;

const GRANTED: u8 = 0x00;
const NOT_ALLOWED: u8 = 0x02;
const HOST_UNREACHABLE: u8 = 0x04;
const COMMAND_NOT_SUPPORTED: u8 = 0x07;

/// How long an unauthenticated client may take to send its `CONNECT`.
const UNAUTHENTICATED_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// srt's refusal for a client that cannot authenticate.
const UNAUTHENTICATED_REASON: &str = "This proxy requires authentication, and this client did not offer an authentication method, so the connection was refused.";
/// srt's reason for a destination on the deny list (pirc passes no
/// `deniedDomainReasons`).
const DENY_LIST_REASON: &str = "host is on the deny list";

/// `socksReply`: a status with a zero IPv4 bind address.
fn reply(status: u8) -> [u8; 10] {
    [VERSION, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

/// How the greeting and authentication ended.
enum Greeting {
    /// Authenticated with the session's token.
    Authenticated,
    /// The client offered no user/password: refuse it.
    Unauthenticated,
    /// Answered and done (bad credentials, garbage).
    Closed,
}

pub(super) async fn handle(
    mut reader: Reader,
    mut writer: Writer,
    session: &Session,
    gate: &mut Gate,
) -> io::Result<()> {
    // Until it authenticates, the client is under the unauthenticated
    // cap and deadline ([`Gate`]).
    let greeting =
        tokio::time::timeout_at(gate.deadline, greet(&mut reader, &mut writer, session)).await;
    match greeting {
        Err(_) => return Ok(()),
        Ok(greeting) => match greeting? {
            Greeting::Closed => return Ok(()),
            Greeting::Unauthenticated => {
                return refuse_unauthenticated(reader, writer, session).await;
            }
            Greeting::Authenticated => {}
        },
    }
    if !gate.admit() {
        return Ok(());
    }
    let (host, port) = match tokio::time::timeout(TIMEOUT, request(&mut reader, &mut writer)).await
    {
        Ok(Ok(Some(destination))) => destination,
        Err(_) | Ok(Ok(None)) => return Ok(()),
        Ok(Err(error)) => return Err(error),
    };
    // The ruleset validator: a malformed or off-list host is not allowed.
    let Some(host) = session.allowlist.check(&host, port) else {
        return writer.write_all(&reply(NOT_ALLOWED)).await;
    };
    match dial(&host, port, &session.allowlist).await {
        Ok(upstream) => {
            writer.write_all(&reply(GRANTED)).await?;
            relay(reader, writer, upstream).await;
            Ok(())
        }
        Err(DialError::Denied(_)) => writer.write_all(&reply(NOT_ALLOWED)).await,
        Err(DialError::Failed) => writer.write_all(&reply(HOST_UNREACHABLE)).await,
    }
}

/// The library's greeting and authentication, as it reads them.
async fn greet(
    reader: &mut Reader,
    writer: &mut Writer,
    session: &Session,
) -> io::Result<Greeting> {
    // srt's `readSocksGreeting` (only SOCKS5), then the library's checks.
    if reader.read_u8().await? != VERSION {
        return Ok(Greeting::Closed);
    }
    let count = reader.read_u8().await?;
    let mut methods = vec![0u8; usize::from(count)];
    reader.read_exact(&mut methods).await?;
    if !methods.contains(&USER_PASSWORD) {
        return Ok(Greeting::Unauthenticated);
    }
    if count > 128 {
        return Ok(Greeting::Closed);
    }
    writer.write_all(&[VERSION, USER_PASSWORD]).await?;
    // RFC 1929; the library ignores the subnegotiation's version byte.
    reader.read_u8().await?;
    let user = read_counted(reader).await?;
    let password = read_counted(reader).await?;
    if !session.auth.accepts_socks(&user, &password) {
        writer.write_all(&[0x01, 0x01]).await?;
        return Ok(Greeting::Closed);
    }
    writer.write_all(&[0x01, 0x00]).await?;
    Ok(Greeting::Authenticated)
}

/// The library's request, as it reads it: the destination of a `CONNECT`;
/// `None` once answered and done (unsupported command, garbage).
async fn request(reader: &mut Reader, writer: &mut Writer) -> io::Result<Option<(String, u16)>> {
    // The library ignores the request's version and reserved bytes.
    reader.read_u8().await?;
    let command = reader.read_u8().await?;
    if !(1..=3).contains(&command) {
        return Ok(None);
    }
    reader.read_u8().await?;
    let Some(host) = read_address(reader, ipv6_padded).await? else {
        return Ok(None);
    };
    let port = reader.read_u16().await?;
    if command != CONNECT {
        writer.write_all(&[VERSION, COMMAND_NOT_SUPPORTED]).await?;
        return Ok(None);
    }
    Ok(Some((host, port)))
}

async fn read_counted(reader: &mut Reader) -> io::Result<Vec<u8>> {
    let length = reader.read_u8().await?;
    let mut bytes = vec![0u8; usize::from(length)];
    reader.read_exact(&mut bytes).await?;
    Ok(bytes)
}

/// The library's IPv6 spelling: every byte as two hex digits, a colon
/// every two bytes (`0000:0000:…:0001`).
fn ipv6_padded(bytes: &[u8; 16]) -> String {
    bytes
        .chunks(2)
        .map(|pair| format!("{:02x}{:02x}", pair[0], pair[1]))
        .collect::<Vec<_>>()
        .join(":")
}

/// `readSocksConnect`'s IPv6 spelling: groups in hex without padding.
fn ipv6_groups(bytes: &[u8; 16]) -> String {
    bytes
        .chunks(2)
        .map(|pair| format!("{:x}", u16::from_be_bytes([pair[0], pair[1]])))
        .collect::<Vec<_>>()
        .join(":")
}

/// `ATYP` and the address: IPv4, a domain (raw bytes, decoded lossily as
/// Node does) or IPv6; `None` for another type.
async fn read_address(
    reader: &mut Reader,
    ipv6: fn(&[u8; 16]) -> String,
) -> io::Result<Option<String>> {
    Ok(Some(match reader.read_u8().await? {
        0x01 => {
            let mut octets = [0u8; 4];
            reader.read_exact(&mut octets).await?;
            std::net::Ipv4Addr::from(octets).to_string()
        }
        0x03 => String::from_utf8_lossy(&read_counted(reader).await?).into_owned(),
        0x04 => {
            let mut bytes = [0u8; 16];
            reader.read_exact(&mut bytes).await?;
            ipv6(&bytes)
        }
        _ => return Ok(None),
    }))
}

/// srt's `refuseUnauthenticated`: learn the destination, never dial it.
async fn refuse_unauthenticated(
    mut reader: Reader,
    mut writer: Writer,
    session: &Session,
) -> io::Result<()> {
    writer.write_all(&[VERSION, NO_AUTH]).await?;
    let request = async {
        let mut start = [0u8; 3];
        reader.read_exact(&mut start).await?;
        if start[0] != VERSION || start[1] != CONNECT {
            return Ok(None);
        }
        let Some(host) = read_address(&mut reader, ipv6_groups).await? else {
            return Ok(None);
        };
        let port = reader.read_u16().await?;
        io::Result::Ok(Some((host, port)))
    };
    let Ok(Ok(Some((host, port)))) = tokio::time::timeout(UNAUTHENTICATED_TIMEOUT, request).await
    else {
        return Ok(());
    };
    if !is_valid_host(&host) || port != 22 {
        writer.write_all(&reply(NOT_ALLOWED)).await?;
        return writer.shutdown().await;
    }
    // Explicit deny rules only: an unauthenticated peer learns nothing
    // about the allowlist.
    let canonical = canonicalize_host(&host).unwrap_or(host);
    let reason = if session.allowlist.is_denied(&canonical, port) {
        DENY_LIST_REASON
    } else {
        UNAUTHENTICATED_REASON
    };
    writer.write_all(&reply(GRANTED)).await?;
    writer.write_all(b"SSH-2.0-policy_refusal\r\n").await?;
    writer.write_all(&ssh_disconnect_packet(reason)).await?;
    writer.shutdown().await
}

/// `sshDisconnectPacket`: a plaintext `SSH_MSG_DISCONNECT` (legal before key
/// exchange, RFC 4253) with reason code 1 (`HOST_NOT_ALLOWED_TO_CONNECT`);
/// control characters collapsed, at most 1000 characters.
fn ssh_disconnect_packet(description: &str) -> Vec<u8> {
    let mut text = String::new();
    let mut in_control = false;
    for c in description.chars() {
        let control = matches!(u32::from(c), 0x00..=0x1f | 0x7f..=0x9f);
        if control {
            if !in_control {
                text.push(' ');
            }
        } else {
            text.push(c);
        }
        in_control = control;
    }
    let text: String = text.chars().take(1000).collect();
    let mut payload = vec![0x01];
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(&u32::try_from(text.len()).unwrap_or(0).to_be_bytes());
    payload.extend_from_slice(text.as_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    // (4 + packet_length) is a multiple of 8, padding at least 4.
    let mut padding = 8 - ((4 + 1 + payload.len()) % 8);
    if padding < 4 {
        padding += 8;
    }
    let mut packet = Vec::new();
    packet.extend_from_slice(
        &u32::try_from(1 + payload.len() + padding)
            .unwrap_or(0)
            .to_be_bytes(),
    );
    packet.push(u8::try_from(padding).unwrap_or(4));
    packet.extend_from_slice(&payload);
    packet.extend(std::iter::repeat_n(0u8, padding));
    packet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv6_spellings() {
        let mut bytes = [0u8; 16];
        bytes[15] = 1;
        bytes[0] = 0x20;
        bytes[1] = 0x01;
        assert_eq!(
            ipv6_padded(&bytes),
            "2001:0000:0000:0000:0000:0000:0000:0001"
        );
        assert_eq!(ipv6_groups(&bytes), "2001:0:0:0:0:0:0:1");
        assert_eq!(canonicalize_host(&ipv6_padded(&bytes)).unwrap(), "2001::1");
    }

    #[test]
    fn disconnect_packets_are_framed_as_ssh_wants() {
        let packet = ssh_disconnect_packet("no\r\n\u{85}way\x07");
        let length = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
        assert_eq!(packet.len(), 4 + length);
        assert_eq!(packet.len() % 8, 0);
        let padding = usize::from(packet[4]);
        assert!(padding >= 4);
        assert_eq!(packet[5], 1, "SSH_MSG_DISCONNECT");
        assert_eq!(&packet[6..10], &1u32.to_be_bytes());
        let text_length = u32::from_be_bytes(packet[10..14].try_into().unwrap()) as usize;
        assert_eq!(&packet[14..14 + text_length], b"no way ");
        let long = ssh_disconnect_packet(&"x".repeat(2000));
        assert_eq!(u32::from_be_bytes(long[10..14].try_into().unwrap()), 1000);
    }
}
