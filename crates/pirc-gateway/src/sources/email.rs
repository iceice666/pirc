//! Email sources: a mailbox over IMAP with a password (for Gmail, an app
//! password), opened read-only (`EXAMINE`, `BODY.PEEK`: nothing is marked
//! read). A poll reads the headers of what arrived since the last one;
//! Gmail's own search (`X-GM-RAW`) is used when the server is Gmail's.

use chrono_tz::Tz;
use mail_parser::{Address, Message, MessageParser, MimeHeaders};
use serde_json::{Value, json};

use super::imap::{Fetched, Mailbox, Session};
use super::store::{NewItem, Source};
use super::{Polled, SourceError, clip, stamp};

const GMAIL: &str = "imap.gmail.com";
/// What a first poll keeps, and any poll at most.
const BASELINE: u32 = 20;
const NEW_MAX: usize = 50;
/// A message read at most (the rest is left out).
const READ_BYTES: usize = 512 * 1024;
const BODY_CHARS: usize = 20_000;
const LISTED: usize = 50;

/// An email source's configuration from the API: `{host, port?, username,
/// mailbox?, tls?}` with `secret.password`.
pub fn configure(config: &Value, secret: &Value) -> Result<(Value, Value), String> {
    let field = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let host = field(config, "host")
        .unwrap_or_else(|| GMAIL.to_owned())
        .to_ascii_lowercase();
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err(format!("{host} is not a host name"));
    }
    let username =
        field(config, "username").ok_or("The user name (the email address) is required")?;
    let password = field(secret, "password")
        .ok_or("The password (secret.password; for Gmail, an app password) is required")?;
    let tls = config.get("tls").and_then(Value::as_bool).unwrap_or(true);
    if !tls && !super::net::loopback(&host) {
        return Err("Only TLS (port 993) is allowed".to_owned());
    }
    let port = match config.get("port") {
        None | Some(Value::Null) => 993,
        Some(port) => port
            .as_u64()
            .filter(|port| (1..=65535).contains(port))
            .ok_or("`port` is a port number")? as u16,
    };
    let mailbox = field(config, "mailbox").unwrap_or_else(|| "INBOX".to_owned());
    if !mailbox.is_ascii() || mailbox.len() > 200 {
        return Err("The mailbox name must be ASCII (like INBOX or [Gmail]/All Mail)".to_owned());
    }
    Ok((
        json!({ "host": host, "port": port, "username": username, "mailbox": mailbox, "tls": tls }),
        json!({ "password": password.replace(' ', "") }),
    ))
}

fn gmail(source: &Source) -> bool {
    source.config_str("host") == Some(GMAIL)
}

async fn open(source: &Source, secret: &Value) -> Result<(Session, Mailbox), SourceError> {
    let host = source.config_str("host").unwrap_or(GMAIL);
    let port = source
        .config
        .get("port")
        .and_then(Value::as_u64)
        .unwrap_or(993) as u16;
    let tls = source
        .config
        .get("tls")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut session = Session::connect(host, port, tls).await?;
    session
        .login(
            source.config_str("username").unwrap_or_default(),
            secret
                .get("password")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .await?;
    let mailbox = session
        .examine(source.config_str("mailbox").unwrap_or("INBOX"))
        .await?;
    Ok((session, mailbox))
}

fn header_items(source: &Source) -> &'static str {
    if gmail(source) {
        "(UID FLAGS INTERNALDATE X-GM-THRID BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)])"
    } else {
        "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)])"
    }
}

/// `Name <address>`, or one of them.
fn address(address: Option<&Address<'_>>) -> Option<String> {
    let addresses: Vec<String> = address?
        .iter()
        .filter_map(|addr| match (addr.name(), addr.address()) {
            (Some(name), Some(address)) if !name.is_empty() => Some(format!("{name} <{address}>")),
            (_, Some(address)) => Some(address.to_owned()),
            (Some(name), None) => Some(name.to_owned()),
            (None, None) => None,
        })
        .collect();
    (!addresses.is_empty()).then(|| addresses.join(", "))
}

/// The display name, else the address.
fn sender(message: &Message<'_>) -> Option<String> {
    let first = message.from()?.first()?;
    first
        .name()
        .filter(|name| !name.is_empty())
        .or(first.address())
        .map(str::to_owned)
}

struct Header {
    uid: u32,
    subject: String,
    from: Option<String>,
    sender: Option<String>,
    at: Option<i64>,
    seen: bool,
    thread: Option<String>,
}

fn header(fetched: &Fetched) -> Option<Header> {
    let uid = fetched.uid?;
    let parsed = fetched
        .body
        .as_deref()
        .and_then(|bytes| MessageParser::default().parse_headers(bytes));
    let subject = parsed
        .as_ref()
        .and_then(|message| message.subject())
        .map(|subject| subject.trim().to_owned())
        .filter(|subject| !subject.is_empty())
        .unwrap_or_else(|| "(no subject)".to_owned());
    Some(Header {
        uid,
        subject,
        from: parsed.as_ref().and_then(|message| address(message.from())),
        sender: parsed.as_ref().and_then(sender),
        at: parsed
            .as_ref()
            .and_then(|message| message.date())
            .map(|date| date.to_timestamp() * 1000),
        seen: fetched.seen(),
        thread: fetched.thread.clone(),
    })
}

fn message_url(source: &Source, header: &Header) -> Option<String> {
    let thread: u64 = header.thread.as_deref()?.parse().ok()?;
    gmail(source).then(|| {
        format!(
            "https://mail.google.com/mail/?authuser={}#all/{thread:x}",
            source.config_str("username").unwrap_or_default()
        )
    })
}

fn item(source: &Source, validity: u32, header: &Header) -> NewItem {
    let who = header.from.clone();
    let name = header
        .sender
        .clone()
        .or_else(|| who.clone())
        .unwrap_or_else(|| "(unknown sender)".to_owned());
    NewItem {
        external_id: format!("{validity}:{}", header.uid),
        kind: "message",
        title: clip(&header.subject, 300),
        who: who.map(|who| clip(&who, 300)),
        at: header.at,
        summary: clip(&format!("{name}: {}", header.subject), 600),
        url: message_url(source, header),
    }
}

/// Poll: the headers of what arrived since the last poll (a first poll,
/// or a mailbox whose UIDs were renumbered, keeps the latest 20).
pub async fn poll(source: &Source, secret: &Value) -> Result<Polled, SourceError> {
    let (mut session, mailbox) = open(source, secret).await?;
    let last = source.cursor.as_ref().and_then(|cursor| {
        let validity = cursor.get("uidValidity")?.as_u64()?;
        (validity == u64::from(mailbox.uid_validity)).then(|| cursor.get("lastUid")?.as_u64())?
    });
    let fetched = match last {
        None if mailbox.exists == 0 => Vec::new(),
        None => {
            let first = mailbox.exists.saturating_sub(BASELINE - 1).max(1);
            session
                .fetch(
                    &format!("{first}:{}", mailbox.exists),
                    header_items(source),
                    false,
                )
                .await?
        }
        Some(last) => {
            let mut found = session
                .fetch(&format!("{}:*", last + 1), header_items(source), true)
                .await?;
            // `n:*` answers the last message even when it is older.
            found.retain(|message| message.uid.is_some_and(|uid| u64::from(uid) > last));
            found
        }
    };
    session.logout().await;
    let mut headers: Vec<Header> = fetched.iter().filter_map(header).collect();
    headers.sort_by_key(|header| header.uid);
    let newest = headers.last().map(|header| u64::from(header.uid));
    let from_next = mailbox
        .uid_next
        .map(|next| u64::from(next.saturating_sub(1)));
    let last_uid = [last, newest, from_next]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(0);
    let skip = headers.len().saturating_sub(NEW_MAX);
    let items = headers[skip..]
        .iter()
        .map(|header| item(source, mailbox.uid_validity, header))
        .collect();
    Ok(Polled {
        baseline: source.cursor.is_none(),
        cursor: json!({ "uidValidity": mailbox.uid_validity, "lastUid": last_uid }),
        items,
        removed: Vec::new(),
    })
}

/// A connection test: the login and the mailbox.
pub async fn test(source: &Source, secret: &Value) -> Result<String, SourceError> {
    let (session, mailbox) = open(source, secret).await?;
    session.logout().await;
    Ok(format!(
        "{} holds {} message{}",
        source.config_str("mailbox").unwrap_or("INBOX"),
        mailbox.exists,
        if mailbox.exists == 1 { "" } else { "s" }
    ))
}

fn line(header: &Header, validity: u32, zone: Tz) -> String {
    format!(
        "[{validity}:{}] {} · {} · {}{}",
        header.uid,
        header.at.map_or_else(
            || "(no date)".to_owned(),
            |at| stamp(at, zone, "%a %Y-%m-%d %H:%M")
        ),
        header.from.as_deref().unwrap_or("(unknown sender)"),
        header.subject,
        if header.seen { "" } else { " (unread)" }
    )
}

async fn headers_of(
    session: &mut Session,
    source: &Source,
    uids: &[u32],
) -> Result<Vec<Header>, SourceError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let set: Vec<String> = uids.iter().map(u32::to_string).collect();
    let fetched = session
        .fetch(&set.join(","), header_items(source), true)
        .await?;
    let mut headers: Vec<Header> = fetched.iter().filter_map(header).collect();
    headers.sort_by_key(|header| std::cmp::Reverse(header.uid));
    Ok(headers)
}

/// `email_list`: the latest messages (or the unread ones), newest first.
pub async fn list(
    source: &Source,
    secret: &Value,
    n: usize,
    unread: bool,
    zone: Tz,
) -> Result<String, SourceError> {
    let n = n.clamp(1, LISTED);
    let (mut session, mailbox) = open(source, secret).await?;
    let headers = if unread {
        let uids = session.uid_search("UNSEEN", None).await?;
        let skip = uids.len().saturating_sub(n);
        headers_of(&mut session, source, &uids[skip..]).await?
    } else if mailbox.exists == 0 {
        Vec::new()
    } else {
        let first = mailbox.exists.saturating_sub(n as u32 - 1).max(1);
        let fetched = session
            .fetch(
                &format!("{first}:{}", mailbox.exists),
                header_items(source),
                false,
            )
            .await?;
        let mut headers: Vec<Header> = fetched.iter().filter_map(header).collect();
        headers.sort_by_key(|header| std::cmp::Reverse(header.uid));
        headers
    };
    session.logout().await;
    let mut text = format!(
        "{} ({}), {}:",
        source.name,
        source.config_str("mailbox").unwrap_or("INBOX"),
        if unread { "unread" } else { "latest" }
    );
    if headers.is_empty() {
        text.push_str(" none.");
    }
    for header in &headers {
        text.push('\n');
        text.push_str(&line(header, mailbox.uid_validity, zone));
    }
    Ok(text)
}

/// `email_search`: Gmail's own search on Gmail, the IMAP `TEXT` search
/// elsewhere; newest first.
pub async fn search(
    source: &Source,
    secret: &Value,
    query: &str,
    n: usize,
    zone: Tz,
) -> Result<String, SourceError> {
    let n = n.clamp(1, LISTED);
    let (mut session, mailbox) = open(source, secret).await?;
    let criteria = if gmail(source) { "X-GM-RAW" } else { "TEXT" };
    let uids = session.uid_search(criteria, Some(query)).await?;
    let skip = uids.len().saturating_sub(n);
    let headers = headers_of(&mut session, source, &uids[skip..]).await?;
    session.logout().await;
    let mut text = format!("{} found {} for {query:?}", source.name, uids.len());
    if uids.len() > n {
        text.push_str(&format!(" (the newest {n} here)"));
    }
    text.push(':');
    for header in &headers {
        text.push('\n');
        text.push_str(&line(header, mailbox.uid_validity, zone));
    }
    Ok(text)
}

/// `email_read`: one message, its headers and its text.
pub async fn read(
    source: &Source,
    secret: &Value,
    id: &str,
    zone: Tz,
) -> Result<String, SourceError> {
    let (validity, uid) = match id.split_once(':') {
        Some((validity, uid)) => (validity.parse::<u32>().ok(), uid),
        None => (None, id),
    };
    let uid: u32 = uid
        .trim()
        .parse()
        .map_err(|_| SourceError::new(format!("{id} is not a message id")))?;
    let (mut session, mailbox) = open(source, secret).await?;
    if validity.is_some_and(|validity| validity != mailbox.uid_validity) {
        session.logout().await;
        return Err(SourceError::new(
            "That message id is from before the mailbox was renumbered; list it again",
        ));
    }
    let fetched = session
        .fetch(
            &uid.to_string(),
            &format!("(UID FLAGS BODY.PEEK[]<0.{READ_BYTES}>)"),
            true,
        )
        .await?;
    session.logout().await;
    let Some(bytes) = fetched
        .into_iter()
        .find(|message| message.uid == Some(uid))
        .and_then(|message| message.body)
    else {
        return Err(SourceError::new(format!(
            "No message {id} in {}",
            source.id
        )));
    };
    let truncated = bytes.len() >= READ_BYTES;
    let Some(message) = MessageParser::default().parse(&bytes) else {
        return Err(SourceError::new("The message cannot be read"));
    };
    let mut text = String::new();
    for (label, value) in [
        ("From", address(message.from())),
        ("To", address(message.to())),
        ("Cc", address(message.cc())),
        (
            "Date",
            message
                .date()
                .map(|date| stamp(date.to_timestamp() * 1000, zone, "%a %Y-%m-%d %H:%M")),
        ),
        ("Subject", message.subject().map(str::to_owned)),
    ] {
        if let Some(value) = value {
            text.push_str(&format!("{label}: {value}\n"));
        }
    }
    let attachments: Vec<String> = message
        .attachments()
        .filter_map(|part| part.attachment_name().map(str::to_owned))
        .collect();
    if !attachments.is_empty() {
        text.push_str(&format!("Attachments: {}\n", attachments.join(", ")));
    }
    let body = message
        .body_text(0)
        .map(|body| body.trim().to_owned())
        .unwrap_or_default();
    text.push('\n');
    text.push_str(&clip(&body, BODY_CHARS));
    if truncated {
        text.push_str("\n\n(The message is longer; the rest is left out.)");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configurations() {
        let (config, secret) = configure(
            &json!({ "username": "me@gmail.com" }),
            &json!({ "password": "abcd efgh ijkl mnop" }),
        )
        .unwrap();
        assert_eq!(
            config,
            json!({ "host": "imap.gmail.com", "port": 993, "username": "me@gmail.com", "mailbox": "INBOX", "tls": true })
        );
        // Gmail shows app passwords in groups of four.
        assert_eq!(secret, json!({ "password": "abcdefghijklmnop" }));
        assert!(
            configure(
                &json!({ "username": "me", "tls": false, "host": "imap.example.com" }),
                &json!({ "password": "p" })
            )
            .is_err()
        );
        assert!(configure(&json!({ "username": "me" }), &json!({})).is_err());
        assert!(
            configure(
                &json!({ "username": "me", "mailbox": "收件匣" }),
                &json!({ "password": "p" })
            )
            .is_err()
        );
        assert!(
            configure(
                &json!({ "username": "me", "port": 0 }),
                &json!({ "password": "p" })
            )
            .is_err()
        );
    }

    #[test]
    fn headers_of_a_fetch() {
        let fetched = Fetched {
            seq: 1,
            uid: Some(42),
            flags: vec!["\\Seen".to_owned()],
            internal_date: None,
            body: Some(
                "From: =?UTF-8?B?5p6X5pWZ5o6I?= <lin@school.edu>\r\nSubject: =?UTF-8?Q?HW3_=E5=BB=B6=E6=9C=9F?=\r\nDate: Tue, 20 Oct 2026 09:00:00 +0800\r\n\r\n"
                    .as_bytes()
                    .to_vec(),
            ),
            thread: Some("1278455344230334865".to_owned()),
        };
        let header = header(&fetched).unwrap();
        assert_eq!(header.subject, "HW3 延期");
        assert_eq!(header.from.as_deref(), Some("林教授 <lin@school.edu>"));
        assert_eq!(header.sender.as_deref(), Some("林教授"));
        assert_eq!(header.at, Some(1_792_458_000_000));
        assert!(header.seen);
    }
}
