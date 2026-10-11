//! A minimal HTTP/1.1 client over the node's Unix socket: one request per
//! connection (`Connection: close`), responses framed by `chunked`,
//! `Content-Length` or the end of the connection. The peer is the node's
//! own inference server, so this needs no more of HTTP than that.

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Largest status line plus headers.
const HEAD_MAX_BYTES: usize = 64 * 1024;
/// Largest chunk-size or trailer line.
const LINE_MAX_BYTES: usize = 8 * 1024;
const READ_BYTES: usize = 64 * 1024;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

enum Framing {
    Length(u64),
    /// Expecting a chunk-size line.
    ChunkSize,
    /// Bytes left in the current chunk, then its CRLF.
    ChunkData(u64),
    Eof,
    Done,
}

pub struct Response {
    pub status: u16,
    stream: UnixStream,
    buffer: Vec<u8>,
    framing: Framing,
}

/// Send one request; the response once its head arrived.
pub async fn request(
    socket_path: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> io::Result<Response> {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: */*\r\n");
    for (name, value) in headers {
        // As fetch refuses them: a header value cannot end a line.
        if value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
            return Err(invalid("invalid header value"));
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    let mut stream = UnixStream::connect(socket_path).await?;
    let mut bytes = head.into_bytes();
    if let Some(body) = body {
        bytes.extend_from_slice(body);
    }
    stream.write_all(&bytes).await?;
    let mut response = Response {
        status: 0,
        stream,
        buffer: Vec::new(),
        framing: Framing::Done,
    };
    response.read_head(method).await?;
    Ok(response)
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Read more bytes; `false` at the end of the connection.
    async fn fill(&mut self) -> io::Result<bool> {
        let start = self.buffer.len();
        self.buffer.resize(start + READ_BYTES, 0);
        let read = self.stream.read(&mut self.buffer[start..]).await;
        let read = match read {
            Ok(read) => read,
            Err(error) => {
                self.buffer.truncate(start);
                return Err(error);
            }
        };
        self.buffer.truncate(start + read);
        Ok(read > 0)
    }

    async fn read_head(&mut self, method: &str) -> io::Result<()> {
        loop {
            let end = loop {
                if let Some(at) = find(&self.buffer, b"\r\n\r\n") {
                    break at;
                }
                if self.buffer.len() > HEAD_MAX_BYTES {
                    return Err(invalid("response head too large"));
                }
                if !self.fill().await? {
                    return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
                }
            };
            let head = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
            self.buffer.drain(..end + 4);
            let mut lines = head.split("\r\n");
            let status_line = lines.next().unwrap_or_default();
            let mut parts = status_line.splitn(3, ' ');
            if !parts.next().unwrap_or_default().starts_with("HTTP/1.") {
                return Err(invalid("not an HTTP/1 response"));
            }
            let status: u16 = parts
                .next()
                .and_then(|code| code.parse().ok())
                .ok_or_else(|| invalid("bad status line"))?;
            if (100..200).contains(&status) {
                // An informational response; the real one follows.
                continue;
            }
            let mut chunked = false;
            let mut length = None;
            for line in lines {
                let Some((name, value)) = line.split_once(':') else {
                    continue;
                };
                let value = value.trim();
                if name.eq_ignore_ascii_case("transfer-encoding") {
                    chunked = value
                        .rsplit(',')
                        .next()
                        .is_some_and(|coding| coding.trim().eq_ignore_ascii_case("chunked"));
                } else if name.eq_ignore_ascii_case("content-length") {
                    length = Some(
                        value
                            .parse::<u64>()
                            .map_err(|_| invalid("bad content-length"))?,
                    );
                }
            }
            self.status = status;
            self.framing = if method == "HEAD" || status == 204 || status == 304 {
                Framing::Length(0)
            } else if chunked {
                Framing::ChunkSize
            } else if let Some(length) = length {
                Framing::Length(length)
            } else {
                Framing::Eof
            };
            return Ok(());
        }
    }

    /// One CRLF-terminated line (without it).
    async fn line(&mut self) -> io::Result<Vec<u8>> {
        loop {
            if let Some(at) = find(&self.buffer, b"\r\n") {
                let line = self.buffer[..at].to_vec();
                self.buffer.drain(..at + 2);
                return Ok(line);
            }
            if self.buffer.len() > LINE_MAX_BYTES {
                return Err(invalid("chunk line too long"));
            }
            if !self.fill().await? {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
        }
    }

    fn take(&mut self, limit: u64) -> Vec<u8> {
        let count = self
            .buffer
            .len()
            .min(usize::try_from(limit).unwrap_or(usize::MAX));
        self.buffer.drain(..count).collect()
    }

    /// The next piece of the body, `None` at its end. A body cut short is
    /// an error.
    pub async fn chunk(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            match self.framing {
                Framing::Done | Framing::Length(0) => {
                    self.framing = Framing::Done;
                    return Ok(None);
                }
                Framing::Length(left) => {
                    if self.buffer.is_empty() && !self.fill().await? {
                        return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
                    }
                    let piece = self.take(left);
                    self.framing = Framing::Length(left - piece.len() as u64);
                    return Ok(Some(piece));
                }
                Framing::Eof => {
                    if self.buffer.is_empty() && !self.fill().await? {
                        self.framing = Framing::Done;
                        return Ok(None);
                    }
                    return Ok(Some(std::mem::take(&mut self.buffer)));
                }
                Framing::ChunkSize => {
                    let line = self.line().await?;
                    let line = String::from_utf8_lossy(&line);
                    let size = line.split(';').next().unwrap_or_default().trim();
                    let size =
                        u64::from_str_radix(size, 16).map_err(|_| invalid("bad chunk size"))?;
                    if size == 0 {
                        // Trailers, up to the empty line.
                        while !self.line().await?.is_empty() {}
                        self.framing = Framing::Done;
                        return Ok(None);
                    }
                    self.framing = Framing::ChunkData(size);
                }
                Framing::ChunkData(0) => {
                    if !self.line().await?.is_empty() {
                        return Err(invalid("chunk not followed by CRLF"));
                    }
                    self.framing = Framing::ChunkSize;
                }
                Framing::ChunkData(left) => {
                    if self.buffer.is_empty() && !self.fill().await? {
                        return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
                    }
                    let piece = self.take(left);
                    self.framing = Framing::ChunkData(left - piece.len() as u64);
                    return Ok(Some(piece));
                }
            }
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
