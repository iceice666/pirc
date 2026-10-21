//! A small IMAP4rev1 client (RFC 3501), only what a read-only email source
//! needs: `LOGIN`, `EXAMINE` (a mailbox opened read-only, so nothing is
//! marked read), `UID SEARCH`, `FETCH` with `BODY.PEEK`, `LOGOUT`. Gmail's
//! `X-GM-RAW` search and `X-GM-THRID` come as plain arguments. Over TLS
//! (implicit, port 993) with the platform's roots; plain text only to a
//! loopback address (tests).

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

/// One read or connect, at most.
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// One response line, and one literal, at most.
const LINE_MAX: usize = 64 * 1024;
const LITERAL_MAX: usize = 4 * 1024 * 1024;
/// All of one response (a FETCH of many headers), at most.
const RESPONSE_MAX: usize = 8 * 1024 * 1024;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImapError {
    /// The server refused the login.
    pub auth: bool,
    pub message: String,
}

impl ImapError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            auth: false,
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, ImapError>;

/// A parsed piece of a response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Token {
    Atom(String),
    Str(Vec<u8>),
    List(Vec<Token>),
    Nil,
}

impl Token {
    pub fn text(&self) -> Option<String> {
        match self {
            Self::Atom(atom) => Some(atom.clone()),
            Self::Str(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }
}

/// An argument of a command: sent quoted, or as a literal when it cannot be.
enum Part<'a> {
    Raw(&'a str),
    Arg(&'a str),
}

pub struct Session {
    io: BufReader<Box<dyn Io>>,
    tag: u32,
}

/// What `EXAMINE` says of a mailbox.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mailbox {
    pub exists: u32,
    pub uid_validity: u32,
    pub uid_next: Option<u32>,
}

/// One message of a `FETCH`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fetched {
    pub seq: u32,
    pub uid: Option<u32>,
    pub flags: Vec<String>,
    pub internal_date: Option<String>,
    /// The first `BODY[...]` section returned.
    pub body: Option<Vec<u8>>,
    /// Gmail's thread id (`X-GM-THRID`).
    pub thread: Option<String>,
}

impl Fetched {
    pub fn seen(&self) -> bool {
        self.flags
            .iter()
            .any(|flag| flag.eq_ignore_ascii_case("\\Seen"))
    }
}

fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn tls_config() -> Result<Arc<rustls::ClientConfig>> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| ImapError::new(error.to_string()))?
        .with_platform_verifier()
        .map_err(|error| ImapError::new(error.to_string()))?
        .with_no_client_auth();
    Ok(Arc::new(config))
}

async fn timed<T>(future: impl Future<Output = std::io::Result<T>>) -> Result<T> {
    match tokio::time::timeout(IO_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(ImapError::new(format!("connection failed: {error}"))),
        Err(_) => Err(ImapError::new("the mail server did not answer in time")),
    }
}

impl Session {
    /// Connect and read the greeting. `tls: false` only to loopback.
    pub async fn connect(host: &str, port: u16, tls: bool) -> Result<Self> {
        if !tls && !loopback(host) {
            return Err(ImapError::new(
                "Plain-text IMAP is only allowed to this machine; use TLS (port 993)",
            ));
        }
        let address = format!(
            "{}:{port}",
            host.trim_start_matches('[').trim_end_matches(']')
        );
        let tcp = timed(TcpStream::connect(address)).await?;
        let io: Box<dyn Io> = if tls {
            let name = rustls::pki_types::ServerName::try_from(host.to_owned())
                .map_err(|_| ImapError::new(format!("{host} is not a valid host name")))?;
            let connector = tokio_rustls::TlsConnector::from(tls_config()?);
            Box::new(timed(connector.connect(name, tcp)).await?)
        } else {
            Box::new(tcp)
        };
        let mut session = Self {
            io: BufReader::new(io),
            tag: 0,
        };
        let greeting = session.read_response().await?;
        let tokens = parse(&greeting);
        match tokens.get(1).and_then(Token::text).as_deref() {
            Some(word)
                if word.eq_ignore_ascii_case("OK") || word.eq_ignore_ascii_case("PREAUTH") =>
            {
                Ok(session)
            }
            _ => Err(ImapError::new(format!(
                "the mail server refused the connection: {}",
                String::from_utf8_lossy(&greeting).trim()
            ))),
        }
    }

    /// One response: a line, with the literals it announces and the lines
    /// after them.
    async fn read_response(&mut self) -> Result<Vec<u8>> {
        let mut response = Vec::new();
        loop {
            let mut line = Vec::new();
            let read = timed(
                (&mut self.io)
                    .take(LINE_MAX as u64)
                    .read_until(b'\n', &mut line),
            )
            .await?;
            if read == 0 {
                return Err(ImapError::new("the mail server closed the connection"));
            }
            if !line.ends_with(b"\n") {
                return Err(ImapError::new("the mail server sent a line too long"));
            }
            response.extend_from_slice(&line);
            if response.len() > RESPONSE_MAX {
                return Err(ImapError::new("the mail server's answer is too long"));
            }
            let Some(length) = literal_length(&line) else {
                return Ok(response);
            };
            if length > LITERAL_MAX {
                return Err(ImapError::new("the mail server's answer is too long"));
            }
            let mut literal = vec![0; length];
            timed(self.io.read_exact(&mut literal)).await?;
            response.extend_from_slice(&literal);
        }
    }

    /// Send a command and read until its tagged status: the untagged
    /// responses, parsed. `NO` and `BAD` are errors.
    async fn command(&mut self, parts: &[Part<'_>]) -> Result<Vec<Vec<Token>>> {
        self.tag += 1;
        let tag = format!("p{}", self.tag);
        let mut pending = format!("{tag} ").into_bytes();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                pending.push(b' ');
            }
            match part {
                Part::Raw(text) => pending.extend_from_slice(text.as_bytes()),
                Part::Arg(text) if quotable(text) => {
                    pending.push(b'"');
                    for byte in text.bytes() {
                        if byte == b'"' || byte == b'\\' {
                            pending.push(b'\\');
                        }
                        pending.push(byte);
                    }
                    pending.push(b'"');
                }
                Part::Arg(text) => {
                    pending.extend_from_slice(format!("{{{}}}\r\n", text.len()).as_bytes());
                    timed(self.io.get_mut().write_all(&pending)).await?;
                    timed(self.io.get_mut().flush()).await?;
                    pending.clear();
                    let reply = self.read_response().await?;
                    if !reply.starts_with(b"+") {
                        return Err(ImapError::new(format!(
                            "the mail server refused: {}",
                            String::from_utf8_lossy(&reply).trim()
                        )));
                    }
                    pending.extend_from_slice(text.as_bytes());
                }
            }
        }
        pending.extend_from_slice(b"\r\n");
        timed(self.io.get_mut().write_all(&pending)).await?;
        timed(self.io.get_mut().flush()).await?;
        let mut untagged = Vec::new();
        loop {
            let response = self.read_response().await?;
            let tokens = parse(&response);
            match tokens.first().and_then(Token::text) {
                Some(first) if first == "*" => untagged.push(tokens),
                Some(first) if first == tag => {
                    let status = tokens.get(1).and_then(Token::text).unwrap_or_default();
                    if status.eq_ignore_ascii_case("OK") {
                        return Ok(untagged);
                    }
                    let text = String::from_utf8_lossy(&response);
                    let said = text
                        .trim()
                        .split_once(' ')
                        .map_or("", |(_, rest)| rest)
                        .split_once(' ')
                        .map_or("", |(_, rest)| rest)
                        .to_owned();
                    return Err(ImapError::new(said));
                }
                // A continuation or another tag: not ours to answer.
                _ => {}
            }
        }
    }

    pub async fn login(&mut self, user: &str, password: &str) -> Result<()> {
        self.command(&[Part::Raw("LOGIN"), Part::Arg(user), Part::Arg(password)])
            .await
            .map(drop)
            .map_err(|error| ImapError {
                auth: true,
                message: if error.message.is_empty() {
                    "the mail server refused the login".to_owned()
                } else {
                    format!("the mail server refused the login: {}", error.message)
                },
            })
    }

    /// Open a mailbox read-only.
    pub async fn examine(&mut self, mailbox: &str) -> Result<Mailbox> {
        let untagged = self
            .command(&[Part::Raw("EXAMINE"), Part::Arg(mailbox)])
            .await?;
        let mut found = Mailbox::default();
        for tokens in untagged {
            match (
                tokens.get(1).and_then(Token::text),
                tokens.get(2).and_then(Token::text),
            ) {
                (Some(count), Some(word)) if word.eq_ignore_ascii_case("EXISTS") => {
                    found.exists = count.parse().unwrap_or(0);
                }
                (Some(ok), Some(code)) if ok.eq_ignore_ascii_case("OK") => {
                    let code = code
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .to_owned();
                    let mut words = code.split_whitespace();
                    match (words.next(), words.next()) {
                        (Some(key), Some(value)) if key.eq_ignore_ascii_case("UIDVALIDITY") => {
                            found.uid_validity = value.parse().unwrap_or(0);
                        }
                        (Some(key), Some(value)) if key.eq_ignore_ascii_case("UIDNEXT") => {
                            found.uid_next = value.parse().ok();
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Ok(found)
    }

    /// `UID SEARCH` with raw criteria (`UNSEEN`, `UID 5:*`), or one
    /// argument after them (`X-GM-RAW <query>`, `TEXT <words>`).
    pub async fn uid_search(&mut self, criteria: &str, argument: Option<&str>) -> Result<Vec<u32>> {
        let mut parts = Vec::new();
        let utf8 = argument.is_some_and(|argument| !argument.is_ascii());
        parts.push(Part::Raw(if utf8 {
            "UID SEARCH CHARSET UTF-8"
        } else {
            "UID SEARCH"
        }));
        parts.push(Part::Raw(criteria));
        if let Some(argument) = argument {
            parts.push(Part::Arg(argument));
        }
        let untagged = self.command(&parts).await?;
        let mut uids = Vec::new();
        for tokens in untagged {
            if tokens
                .get(1)
                .and_then(Token::text)
                .is_some_and(|word| word.eq_ignore_ascii_case("SEARCH"))
            {
                uids.extend(
                    tokens[2..]
                        .iter()
                        .filter_map(|token| token.text()?.parse::<u32>().ok()),
                );
            }
        }
        uids.sort_unstable();
        Ok(uids)
    }

    /// `FETCH` (or `UID FETCH`) of a set with items (`(UID FLAGS ...)`).
    pub async fn fetch(&mut self, set: &str, items: &str, uid: bool) -> Result<Vec<Fetched>> {
        let command = if uid { "UID FETCH" } else { "FETCH" };
        let untagged = self
            .command(&[Part::Raw(command), Part::Raw(set), Part::Raw(items)])
            .await?;
        let mut fetched = Vec::new();
        for tokens in untagged {
            let (Some(seq), Some(word), Some(Token::List(attributes))) = (
                tokens.get(1).and_then(Token::text),
                tokens.get(2).and_then(Token::text),
                tokens.get(3),
            ) else {
                continue;
            };
            if !word.eq_ignore_ascii_case("FETCH") {
                continue;
            }
            let mut message = Fetched {
                seq: seq.parse().unwrap_or(0),
                ..Default::default()
            };
            for pair in attributes.chunks(2) {
                let (Some(key), Some(value)) = (pair[0].text(), pair.get(1)) else {
                    continue;
                };
                let key = key.to_ascii_uppercase();
                match key.as_str() {
                    "UID" => message.uid = value.text().and_then(|uid| uid.parse().ok()),
                    "FLAGS" => {
                        if let Token::List(flags) = value {
                            message.flags = flags.iter().filter_map(Token::text).collect();
                        }
                    }
                    "INTERNALDATE" => message.internal_date = value.text(),
                    "X-GM-THRID" => message.thread = value.text(),
                    _ if key.starts_with("BODY[")
                        || key.starts_with("RFC822") && key != "RFC822.SIZE" =>
                    {
                        if message.body.is_none()
                            && let Token::Str(bytes) = value
                        {
                            message.body = Some(bytes.clone());
                        }
                    }
                    _ => {}
                }
            }
            fetched.push(message);
        }
        Ok(fetched)
    }

    pub async fn logout(mut self) {
        let _ = self.command(&[Part::Raw("LOGOUT")]).await;
    }
}

/// A quoted string can carry printable ASCII without CR or LF.
fn quotable(text: &str) -> bool {
    text.len() < 1000 && text.bytes().all(|byte| (0x20..0x7f).contains(&byte))
}

/// `{n}` (or `{n+}`) ending a line: a literal of n bytes follows.
fn literal_length(line: &[u8]) -> Option<usize> {
    let line = line
        .strip_suffix(b"\r\n")
        .or_else(|| line.strip_suffix(b"\n"))?;
    let line = line.strip_suffix(b"}")?;
    let open = line.iter().rposition(|byte| *byte == b'{')?;
    let digits = &line[open + 1..];
    let digits = digits.strip_suffix(b"+").unwrap_or(digits);
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// A response's tokens (its tag or `*` first).
pub fn parse(response: &[u8]) -> Vec<Token> {
    let mut parser = Parser {
        bytes: response,
        at: 0,
    };
    parser.sequence(None)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn sequence(&mut self, close: Option<u8>) -> Vec<Token> {
        let mut tokens = Vec::new();
        loop {
            while matches!(self.peek(), Some(b' ' | b'\r' | b'\n')) {
                self.at += 1;
            }
            match self.peek() {
                None => return tokens,
                Some(byte) if Some(byte) == close => {
                    self.at += 1;
                    return tokens;
                }
                Some(b')') => self.at += 1,
                Some(b'(') => {
                    self.at += 1;
                    tokens.push(Token::List(self.sequence(Some(b')'))));
                }
                Some(b'"') => tokens.push(self.quoted()),
                Some(b'{') => match self.literal() {
                    Some(token) => tokens.push(token),
                    None => tokens.push(self.atom()),
                },
                Some(_) => tokens.push(self.atom()),
            }
        }
    }

    fn quoted(&mut self) -> Token {
        self.at += 1;
        let mut out = Vec::new();
        while let Some(byte) = self.peek() {
            self.at += 1;
            match byte {
                b'\\' => {
                    if let Some(next) = self.peek() {
                        out.push(next);
                        self.at += 1;
                    }
                }
                b'"' => break,
                _ => out.push(byte),
            }
        }
        Token::Str(out)
    }

    fn literal(&mut self) -> Option<Token> {
        let start = self.at;
        let close = self.bytes[start..].iter().position(|byte| *byte == b'}')? + start;
        let digits = &self.bytes[start + 1..close];
        let digits = digits.strip_suffix(b"+").unwrap_or(digits);
        let length: usize = std::str::from_utf8(digits).ok()?.parse().ok()?;
        let mut body = close + 1;
        if self.bytes.get(body) == Some(&b'\r') {
            body += 1;
        }
        if self.bytes.get(body) != Some(&b'\n') {
            return None;
        }
        body += 1;
        let end = (body + length).min(self.bytes.len());
        self.at = end;
        Some(Token::Str(self.bytes[body..end].to_vec()))
    }

    /// An atom, with any `[...]` in it whole (`BODY[HEADER.FIELDS (FROM)]`,
    /// `[UIDVALIDITY 3]`).
    fn atom(&mut self) -> Token {
        let start = self.at;
        let mut depth = 0usize;
        while let Some(byte) = self.peek() {
            match byte {
                b'[' => depth += 1,
                b']' => depth = depth.saturating_sub(1),
                b' ' | b'(' | b')' | b'\r' | b'\n' if depth == 0 => break,
                b'\r' | b'\n' => break,
                _ => {}
            }
            self.at += 1;
        }
        if self.at == start {
            self.at += 1;
        }
        let atom = String::from_utf8_lossy(&self.bytes[start..self.at]).into_owned();
        if atom.eq_ignore_ascii_case("NIL") {
            Token::Nil
        } else {
            Token::Atom(atom)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(text: &str) -> Token {
        Token::Atom(text.to_owned())
    }

    #[test]
    fn parses_responses() {
        assert_eq!(
            parse(b"* OK [UIDVALIDITY 3857529045] UIDs valid\r\n"),
            [
                atom("*"),
                atom("OK"),
                atom("[UIDVALIDITY 3857529045]"),
                atom("UIDs"),
                atom("valid")
            ]
        );
        let fetch = b"* 12 FETCH (UID 345 FLAGS (\\Seen) INTERNALDATE \"17-Jul-1996 02:44:25 -0700\" X-GM-THRID 1278455344230334865 BODY[HEADER.FIELDS (FROM SUBJECT)] {28}\r\nSubject: hi\r\nFrom: a@b.c\r\n\r\n)\r\n";
        let tokens = parse(fetch);
        assert_eq!(tokens[..3], [atom("*"), atom("12"), atom("FETCH")]);
        let Token::List(attributes) = &tokens[3] else {
            panic!("{tokens:?}")
        };
        assert_eq!(attributes[3], Token::List(vec![atom("\\Seen")]));
        assert_eq!(attributes[8], atom("BODY[HEADER.FIELDS (FROM SUBJECT)]"));
        assert_eq!(
            attributes[9],
            Token::Str(b"Subject: hi\r\nFrom: a@b.c\r\n\r\n".to_vec())
        );
        assert_eq!(
            parse(b"* 1 FETCH (BODY[] NIL)")[3],
            Token::List(vec![atom("BODY[]"), Token::Nil])
        );
        assert_eq!(
            parse(b"\"a \\\"q\\\" \\\\\"")[0],
            Token::Str(b"a \"q\" \\".to_vec())
        );
    }

    #[test]
    fn literals_at_the_end_of_lines() {
        assert_eq!(literal_length(b"* 1 FETCH (BODY[] {12}\r\n"), Some(12));
        assert_eq!(literal_length(b"* 1 FETCH (BODY[] {12+}\r\n"), Some(12));
        assert_eq!(literal_length(b"* OK {x}\r\n"), None);
        assert_eq!(literal_length(b"* OK done\r\n"), None);
        assert!(quotable("app pass\"word"));
        assert!(!quotable("密碼"));
    }

    /// A scripted server on loopback: the client's lines and the answers.
    #[tokio::test]
    async fn a_session_with_a_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            socket.get_mut().write_all(b"* OK ready\r\n").await.unwrap();
            let mut heard = Vec::new();
            loop {
                let mut line = String::new();
                if socket.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                heard.push(line.trim_end().to_owned());
                let tag = line.split(' ').next().unwrap().to_owned();
                let reply = if line.contains("{6}") {
                    // The password as a literal.
                    socket.get_mut().write_all(b"+ go\r\n").await.unwrap();
                    let mut rest = String::new();
                    socket.read_line(&mut rest).await.unwrap();
                    heard.push(rest.trim_end().to_owned());
                    format!("{tag} OK logged in\r\n")
                } else if line.contains("EXAMINE") {
                    format!(
                        "* 3 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 41] ok\r\n{tag} OK [READ-ONLY] done\r\n"
                    )
                } else if line.contains("SEARCH") {
                    format!("* SEARCH 40 38\r\n{tag} OK done\r\n")
                } else if line.contains("FETCH") {
                    format!(
                        "* 3 FETCH (UID 40 FLAGS () BODY[HEADER] {{13}}\r\nSubject: hi\r\n)\r\n{tag} OK done\r\n"
                    )
                } else if line.contains("LOGOUT") {
                    format!("* BYE\r\n{tag} OK bye\r\n")
                } else {
                    format!("{tag} BAD what\r\n")
                };
                socket.get_mut().write_all(reply.as_bytes()).await.unwrap();
            }
            heard
        });
        let mut session = Session::connect("127.0.0.1", port, false).await.unwrap();
        session.login("me@x", "密碼").await.unwrap();
        let mailbox = session.examine("INBOX").await.unwrap();
        assert_eq!(
            mailbox,
            Mailbox {
                exists: 3,
                uid_validity: 7,
                uid_next: Some(41)
            }
        );
        assert_eq!(session.uid_search("UNSEEN", None).await.unwrap(), [38, 40]);
        let fetched = session
            .fetch("40", "(UID FLAGS BODY.PEEK[HEADER])", true)
            .await
            .unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!((fetched[0].uid, fetched[0].seen()), (Some(40), false));
        assert_eq!(fetched[0].body.as_deref(), Some(&b"Subject: hi\r\n"[..]));
        assert!(session.command(&[Part::Raw("NOOP")]).await.is_err());
        session.logout().await;
        let heard = server.await.unwrap();
        assert_eq!(heard[0], "p1 LOGIN \"me@x\" {6}");
        assert_eq!(heard[1], "密碼");
        assert_eq!(heard[2], "p2 EXAMINE \"INBOX\"");
        assert!(Session::connect("example.com", 143, false).await.is_err());
    }
}
