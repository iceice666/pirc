//! Calendar sources: an ICS address (Google's secret iCal address, a
//! published Outlook calendar, Moodle's export), or a CalDAV calendar
//! collection with a password. A poll compares the events of the next 60
//! days with the last poll's (one item per event, not per instance, so a
//! weekly class does not change each week); the tools read the feed live.

use std::collections::{BTreeMap, BTreeSet};

use chrono_tz::Tz;
use serde_json::{Map, Value, json};

use super::ics::{self, Event};
use super::net::{self, check_url};
use super::store::{NewItem, Source};
use super::{Polled, SourceError, clip, stamp};

/// A feed, at most.
const FEED_MAX: usize = 8 * 1024 * 1024;
/// The window a poll watches.
const BEHIND_MS: i64 = 86_400_000;
const AHEAD_MS: i64 = 60 * 86_400_000;
/// Events a cursor remembers, at most.
const CURSOR_EVENTS: usize = 3000;
/// Instances a list shows, at most.
const LISTED: usize = 200;
const DESCRIPTION_CHARS: usize = 4000;

/// A calendar source's configuration from the API: `{mode: "ics"}` with
/// `secret.url`, or `{mode: "caldav", url, username}` with
/// `secret.password`. The ICS address is kept as a secret; the
/// configuration shows its host.
pub fn configure(config: &Value, secret: &Value) -> Result<(Value, Value), String> {
    let field = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    match config.get("mode").and_then(Value::as_str).unwrap_or("ics") {
        "ics" => {
            let url =
                field(secret, "url").ok_or("The calendar's address (secret.url) is required")?;
            // webcal:// is how calendar apps link to the same https feed.
            let url = match url.strip_prefix("webcal://") {
                Some(rest) => format!("https://{rest}"),
                None => url,
            };
            let parsed = check_url(&url)?;
            Ok((
                json!({ "mode": "ics", "host": parsed.host_str().unwrap_or_default() }),
                json!({ "url": parsed.as_str() }),
            ))
        }
        "caldav" => {
            let url = field(config, "url").ok_or("The calendar's address (url) is required")?;
            let parsed = check_url(&url)?;
            let username = field(config, "username").ok_or("The user name is required")?;
            let password =
                field(secret, "password").ok_or("The password (secret.password) is required")?;
            Ok((
                json!({ "mode": "caldav", "url": parsed.as_str(), "username": username, "host": parsed.host_str().unwrap_or_default() }),
                json!({ "password": password }),
            ))
        }
        _ => Err("`mode` is ics or caldav".to_owned()),
    }
}

fn ical_utc(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

/// The text of a feed, or of the CalDAV objects in `[from, to)`.
async fn fetch(source: &Source, secret: &Value, from: i64, to: i64) -> Result<String, SourceError> {
    let client = net::client();
    let response = match source.config_str("mode") {
        Some("caldav") => {
            let url = source.config_str("url").unwrap_or_default();
            let url = check_url(url).map_err(SourceError::new)?;
            let body = format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\">\
<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\">\
<c:time-range start=\"{}\" end=\"{}\"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>",
                ical_utc(from),
                ical_utc(to)
            );
            let method = reqwest::Method::from_bytes(b"REPORT").expect("a method name");
            client
                .request(method, url)
                .basic_auth(
                    source.config_str("username").unwrap_or_default(),
                    secret.get("password").and_then(Value::as_str),
                )
                .header("Depth", "1")
                .header("Content-Type", "application/xml; charset=utf-8")
                .body(body)
                .send()
                .await
        }
        _ => {
            let url = secret.get("url").and_then(Value::as_str).unwrap_or_default();
            let url = check_url(url).map_err(SourceError::new)?;
            client.get(url).header("Accept", "text/calendar").send().await
        }
    }
    .map_err(|error| net::failed(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(net::status_error(status));
    }
    let bytes = net::body(response, FEED_MAX).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(if source.config_str("mode") == Some("caldav") {
        calendar_data(&text).join("\n")
    } else {
        text
    })
}

/// The `calendar-data` of a CalDAV multistatus answer (any namespace
/// prefix, CDATA or escaped).
fn calendar_data(xml: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("calendar-data") {
        let before = &rest[..at];
        let open = before.rfind('<');
        let is_open_tag = open.is_some_and(|open| {
            let name = &before[open + 1..];
            !name.starts_with('/')
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '-' || c == '_')
        });
        let after = &rest[at + "calendar-data".len()..];
        if !is_open_tag {
            rest = after;
            continue;
        }
        let Some(close) = after.find('>') else {
            break;
        };
        if after[..close].ends_with('/') {
            rest = &after[close + 1..];
            continue;
        }
        let content = &after[close + 1..];
        let Some(end) = content
            .find("calendar-data>")
            .and_then(|end| content[..end].rfind("</"))
        else {
            break;
        };
        let inner = content[..end].trim();
        let inner = match inner
            .strip_prefix("<![CDATA[")
            .and_then(|inner| inner.strip_suffix("]]>"))
        {
            Some(raw) => raw.to_owned(),
            None => net::entities(inner),
        };
        found.push(inner);
        rest = &content[end..];
    }
    found
}

fn hash(text: &str) -> String {
    crate::util::sha256_hex(text)[..16].to_owned()
}

/// What a poll keeps of an event: when it comes next, what and where.
fn item(event: &Event, next: i64, zone: Tz) -> NewItem {
    let summary = if event.summary.is_empty() {
        "(no title)".to_owned()
    } else {
        event.summary.clone()
    };
    let mut line = format!("{} · {summary}", when(next, event.start.all_day, zone));
    if !event.location.is_empty() {
        line.push_str(&format!(" @ {}", event.location));
    }
    if event.rule_text.is_some() {
        line.push_str(" (repeats)");
    }
    NewItem {
        external_id: event.key(),
        kind: "event",
        title: clip(&summary, 300),
        who: event.organizer.clone(),
        at: Some(next),
        summary: clip(&line, 600),
        url: event.url.clone(),
    }
}

fn when(ms: i64, all_day: bool, zone: Tz) -> String {
    if all_day {
        format!("{} (all day)", stamp(ms, zone, "%a %Y-%m-%d"))
    } else {
        stamp(ms, zone, "%a %Y-%m-%d %H:%M")
    }
}

/// Poll: the events of the next 60 days against the last poll's. Events
/// gone from the feed are `removed`; ones that only left the window are
/// forgotten quietly.
pub async fn poll(
    source: &Source,
    secret: &Value,
    zone: Tz,
    now: i64,
) -> Result<Polled, SourceError> {
    let (from, to) = (now - BEHIND_MS, now + AHEAD_MS);
    let feed = fetch(source, secret, from, to).await?;
    let events = ics::parse(&feed, zone);
    if events.is_empty()
        && !feed.contains("BEGIN:VCALENDAR")
        && source.config_str("mode") != Some("caldav")
    {
        return Err(SourceError::new("the address does not give a calendar"));
    }
    let previous: BTreeMap<String, String> = source
        .cursor
        .as_ref()
        .and_then(|cursor| cursor.get("events"))
        .and_then(Value::as_object)
        .map(|events| {
            events
                .iter()
                .filter_map(|(key, hash)| Some((key.clone(), hash.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let in_window: BTreeSet<usize> = ics::occurrences(&events, from, to)
        .into_iter()
        .map(|occurrence| occurrence.event)
        .collect();
    let mut current = Map::new();
    let mut items = Vec::new();
    for index in in_window {
        let event = &events[index];
        let key = event.key();
        let fingerprint = hash(&event.fingerprint());
        if previous.get(&key) != Some(&fingerprint) {
            items.push(item(event, ics::next_start(&events, index, now), zone));
        }
        if current.len() < CURSOR_EVENTS {
            current.insert(key, json!(fingerprint));
        }
    }
    let all: BTreeSet<String> = events.iter().map(Event::key).collect();
    let removed = previous
        .keys()
        .filter(|key| !current.contains_key(*key) && !all.contains(*key))
        .cloned()
        .collect();
    Ok(Polled {
        baseline: source.cursor.is_none(),
        cursor: json!({ "events": current }),
        items,
        removed,
    })
}

/// A connection test: how many events the next 60 days hold.
pub async fn test(
    source: &Source,
    secret: &Value,
    zone: Tz,
    now: i64,
) -> Result<String, SourceError> {
    let feed = fetch(source, secret, now - BEHIND_MS, now + AHEAD_MS).await?;
    let events = ics::parse(&feed, zone);
    if events.is_empty()
        && !feed.contains("BEGIN:VCALENDAR")
        && source.config_str("mode") != Some("caldav")
    {
        return Err(SourceError::new("the address does not give a calendar"));
    }
    let count = ics::occurrences(&events, now - BEHIND_MS, now + AHEAD_MS).len();
    Ok(format!(
        "{count} event{} in the next 60 days",
        if count == 1 { "" } else { "s" }
    ))
}

/// `calendar_list`: the instances in `[from, to)` of these calendars.
pub async fn list(
    calendars: &[(Source, Value)],
    zone: Tz,
    from: i64,
    to: i64,
) -> Result<String, SourceError> {
    let mut lines: Vec<(i64, String)> = Vec::new();
    let mut failures = Vec::new();
    for (source, secret) in calendars {
        let feed = match fetch(source, secret, from, to).await {
            Ok(feed) => feed,
            Err(error) => {
                failures.push(format!(
                    "{} ({}): {}",
                    source.name, source.id, error.message
                ));
                continue;
            }
        };
        let events = ics::parse(&feed, zone);
        for occurrence in ics::occurrences(&events, from, to) {
            let event = &events[occurrence.event];
            let mut line = format!(
                "[{}] {}",
                event.key(),
                when(occurrence.start, event.start.all_day, zone)
            );
            if !event.start.all_day && occurrence.end > occurrence.start {
                line.push_str(&format!("–{}", stamp(occurrence.end, zone, "%H:%M")));
            }
            line.push_str(&format!(
                " · {}",
                if event.summary.is_empty() {
                    "(no title)"
                } else {
                    &event.summary
                }
            ));
            if !event.location.is_empty() {
                line.push_str(&format!(" @ {}", event.location));
            }
            if calendars.len() > 1 {
                line.push_str(&format!(" ({})", source.id));
            }
            lines.push((occurrence.start, line));
        }
    }
    lines.sort();
    let total = lines.len();
    let mut text = format!(
        "{} to {}:",
        stamp(from, zone, "%a %Y-%m-%d %H:%M"),
        stamp(to, zone, "%a %Y-%m-%d %H:%M")
    );
    if lines.is_empty() {
        text.push_str(" nothing.");
    }
    for (_, line) in lines.into_iter().take(LISTED) {
        text.push('\n');
        text.push_str(&line);
    }
    if total > LISTED {
        text.push_str(&format!(
            "\n… and {} more; ask for a shorter range.",
            total - LISTED
        ));
    }
    for failure in failures {
        text.push_str(&format!("\nCould not read {failure}"));
    }
    Ok(text)
}

/// `calendar_read`: one event in full.
pub async fn read(
    source: &Source,
    secret: &Value,
    zone: Tz,
    key: &str,
    now: i64,
) -> Result<String, SourceError> {
    let feed = fetch(
        source,
        secret,
        now - 365 * 86_400_000,
        now + 365 * 86_400_000,
    )
    .await?;
    let events = ics::parse(&feed, zone);
    let Some(index) = events.iter().position(|event| event.key() == key) else {
        return Err(SourceError::new(format!("No event {key} in {}", source.id)));
    };
    let event = &events[index];
    let mut text = format!(
        "{} ({})\nWhen: {}",
        if event.summary.is_empty() {
            "(no title)"
        } else {
            &event.summary
        },
        source.id,
        when(event.start.ms, event.start.all_day, zone)
    );
    if event.length > 0 && !event.start.all_day {
        text.push_str(&format!(
            " to {}",
            stamp(event.start.ms + event.length, zone, "%a %Y-%m-%d %H:%M")
        ));
    }
    if let Some(rule) = &event.rule_text {
        text.push_str(&format!("\nRepeats: {rule}"));
        let next: Vec<String> = ics::occurrences(&events, now, now + 365 * 86_400_000)
            .into_iter()
            .filter(|occurrence| occurrence.event == index)
            .take(3)
            .map(|occurrence| when(occurrence.start, event.start.all_day, zone))
            .collect();
        if !next.is_empty() {
            text.push_str(&format!("\nNext: {}", next.join(", ")));
        }
    }
    for (label, value) in [
        (
            "Where",
            Some(event.location.as_str()).filter(|text| !text.is_empty()),
        ),
        ("Organizer", event.organizer.as_deref()),
        ("Status", event.status.as_deref()),
        ("Link", event.url.as_deref()),
    ] {
        if let Some(value) = value {
            text.push_str(&format!("\n{label}: {value}"));
        }
    }
    if !event.description.trim().is_empty() {
        text.push_str(&format!(
            "\n\n{}",
            clip(event.description.trim(), DESCRIPTION_CHARS)
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configurations() {
        let (config, secret) = configure(
            &json!({}),
            &json!({ "url": "webcal://calendar.google.com/calendar/ical/x/private-abc/basic.ics" }),
        )
        .unwrap();
        assert_eq!(
            config,
            json!({ "mode": "ics", "host": "calendar.google.com" })
        );
        assert_eq!(
            secret["url"],
            "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics"
        );
        assert!(
            configure(
                &json!({ "mode": "ics" }),
                &json!({ "url": "http://example.com/a.ics" })
            )
            .is_err()
        );
        let (config, secret) = configure(
            &json!({ "mode": "caldav", "url": "https://dav.example.com/cal/me/", "username": "me" }),
            &json!({ "password": "pw" }),
        )
        .unwrap();
        assert_eq!(config["username"], "me");
        assert_eq!(secret, json!({ "password": "pw" }));
        assert!(
            configure(
                &json!({ "mode": "caldav", "url": "https://dav.example.com/" }),
                &json!({})
            )
            .is_err()
        );
        assert!(configure(&json!({ "mode": "other" }), &json!({})).is_err());
    }

    #[test]
    fn caldav_answers() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response><d:propstat><d:prop><cal:calendar-data>BEGIN:VCALENDAR
SUMMARY:A &amp; B
END:VCALENDAR</cal:calendar-data></d:prop></d:propstat></d:response>
<d:response><d:propstat><d:prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav"><![CDATA[BEGIN:VCALENDAR
SUMMARY:<raw>
END:VCALENDAR]]></C:calendar-data></d:prop></d:propstat></d:response>
<d:response><d:prop><cal:calendar-data/></d:prop></d:response></d:multistatus>"#;
        let found = calendar_data(xml);
        assert_eq!(found.len(), 2);
        assert!(found[0].contains("SUMMARY:A & B"));
        assert!(found[1].contains("SUMMARY:<raw>"));
    }
}
