//! Sources (plans/rewrite/09-sources.md): what the brain can see beyond
//! the rooms, all read-only connectors whose credentials stay in the
//! gateway: email over IMAP ([`email`]), calendars as ICS or CalDAV
//! ([`calendar`]), Moodle's web service API ([`moodle`]) and a workspace's
//! git history ([`workspace`]). Web search is the brain's own tool and is
//! listed with them.
//!
//! The gateway polls each at its kind's cadence ([`poller`]); what a poll
//! sees goes into `source_items` (searchable, `tool:<source>` origin), and
//! Rust alone decides whether that wakes the brain ([`filter`]): only when
//! a room follows the source, or a change touches an open loop. Nothing a
//! source says is an instruction: the origin goes with everything taken
//! from it.

pub mod calendar;
pub mod email;
pub mod filter;
pub mod ics;
mod imap;
pub mod moodle;
pub mod net;
pub mod poller;
pub mod secrets;
pub mod store;
pub mod tools;
mod workspace;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono_tz::Tz;
use serde_json::{Value, json};

use crate::app::{App, AppState};
use store::{NewItem, Source};

/// The kinds of sources people add.
pub const KINDS: [&str; 4] = ["email", "calendar", "moodle", "workspace"];

/// How often a kind is polled (decision #3; Moodle as #17 has it).
pub fn cadence_ms(kind: &str) -> i64 {
    match kind {
        "email" => 5 * 60_000,
        "calendar" => 15 * 60_000,
        "moodle" => 60 * 60_000,
        _ => 24 * 60 * 60_000,
    }
}

/// What went wrong reading a source, as people and the brain are told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceError {
    /// The credentials were refused: someone has to sign in again.
    pub auth: bool,
    pub message: String,
    /// An API error code, when it is not the generic one.
    pub code: Option<&'static str>,
}

impl SourceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            auth: false,
            message: message.into(),
            code: None,
        }
    }
}

impl From<imap::ImapError> for SourceError {
    fn from(error: imap::ImapError) -> Self {
        Self {
            auth: error.auth,
            message: error.message,
            code: None,
        }
    }
}

impl From<SourceError> for crate::error::ApiError {
    fn from(error: SourceError) -> Self {
        crate::error::ApiError::new(
            if error.auth { 400 } else { 502 },
            error.code.unwrap_or(if error.auth {
                "source_login_failed"
            } else {
                "source_unreachable"
            }),
            error.message,
        )
    }
}

/// What a poll saw.
#[derive(Clone, Debug, PartialEq)]
pub struct Polled {
    /// The first poll (or the first since the configuration changed): what
    /// it saw is kept, but wakes nobody.
    pub baseline: bool,
    pub cursor: Value,
    pub items: Vec<NewItem>,
    /// External ids of things gone from the source.
    pub removed: Vec<String>,
}

pub fn clip(text: &str, max: usize) -> String {
    crate::memory::text::clip(text, max)
}

/// A time in a zone, `strftime`-style.
pub fn stamp(ms: i64, zone: Tz, format: &str) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.with_timezone(&zone).format(format).to_string())
        .unwrap_or_default()
}

/// The household's zone.
pub fn zone(app: &App) -> Tz {
    Tz::from_str_insensitive(&app.config.timezone).unwrap_or(chrono_tz::UTC)
}

/// A Moodle app login that was started: its passport, for the site.
struct Passport {
    site: String,
    passport: String,
    expires_at: i64,
}

/// Passports a Moodle app login stays open for.
const PASSPORT_MS: i64 = 30 * 60_000;

/// The gateway's sources service (in `App::slots`): the credentials, the
/// app logins under way, which sources are being polled.
pub struct Sources {
    secrets: Result<secrets::Secrets, String>,
    passports: Mutex<Vec<Passport>>,
    /// One poll of a source at a time.
    polling: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Sources were added, changed or resumed: the poller looks again.
    pub changed: tokio::sync::Notify,
}

pub fn service(app: &App) -> Arc<Sources> {
    app.slots.get_or_init(|| Sources {
        secrets: secrets::Secrets::open(&app.config.state_dir).inspect_err(|error| {
            crate::log::error(&format!("sources: cannot read the credentials: {error}"));
        }),
        passports: Mutex::new(Vec::new()),
        polling: Mutex::new(HashMap::new()),
        changed: tokio::sync::Notify::new(),
    })
}

impl Sources {
    pub fn secret(&self, id: &str) -> Value {
        self.secrets
            .as_ref()
            .ok()
            .and_then(|secrets| secrets.get(id))
            .unwrap_or_else(|| json!({}))
    }

    pub fn put_secret(&self, id: &str, secret: Value) -> Result<(), String> {
        self.secrets.as_ref().map_err(Clone::clone)?.put(id, secret)
    }

    pub fn remove_secret(&self, id: &str) -> Result<(), String> {
        self.secrets.as_ref().map_err(Clone::clone)?.remove(id)
    }

    /// Start a Moodle app login: a passport for the site's launch page.
    pub fn new_passport(&self, site: &str, now: i64) -> String {
        let passport = crate::util::hex(&crate::util::random_bytes::<16>());
        let mut passports = self.passports.lock().unwrap_or_else(|p| p.into_inner());
        passports.retain(|open| open.expires_at > now);
        if passports.len() >= 20 {
            passports.remove(0);
        }
        passports.push(Passport {
            site: site.to_owned(),
            passport: passport.clone(),
            expires_at: now + PASSPORT_MS,
        });
        passport
    }

    /// The open passports of a site.
    pub fn passports(&self, site: &str, now: i64) -> Vec<String> {
        let passports = self.passports.lock().unwrap_or_else(|p| p.into_inner());
        passports
            .iter()
            .filter(|open| open.site == site && open.expires_at > now)
            .map(|open| open.passport.clone())
            .collect()
    }

    /// The lock a source's polls take turns with.
    fn poll_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut polling = self.polling.lock().unwrap_or_else(|p| p.into_inner());
        polling.retain(|_, lock| Arc::strong_count(lock) > 1);
        Arc::clone(polling.entry(id.to_owned()).or_default())
    }
}

/// Read a source once.
pub async fn poll(app: &AppState, source: &Source, secret: &Value) -> Result<Polled, SourceError> {
    let now = crate::util::now_ms();
    match source.kind.as_str() {
        "email" => email::poll(source, secret).await,
        "calendar" => calendar::poll(source, secret, zone(app), now).await,
        "moodle" => moodle::poll(source, secret, zone(app), now).await,
        "workspace" => workspace::poll(app, source).await,
        other => Err(SourceError::new(format!("{other} sources are not known"))),
    }
}

/// Try a source's connection and credentials: what it holds, briefly.
pub async fn test(app: &AppState, source: &Source, secret: &Value) -> Result<String, SourceError> {
    let now = crate::util::now_ms();
    match source.kind.as_str() {
        "email" => email::test(source, secret).await,
        "calendar" => calendar::test(source, secret, zone(app), now).await,
        "moodle" => moodle::test(source, secret).await,
        "workspace" => workspace::test(app, source).await,
        other => Err(SourceError::new(format!("{other} sources are not known"))),
    }
}

/// A workspace source's configuration from the API (`{workspace}`).
pub fn workspace_config(app: &AppState, config: &Value) -> Result<Value, String> {
    workspace::configure(app, config)
}

/// The rooms that follow a source (`sourceScope.sources` holds its id).
pub fn following_rooms(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> crate::error::ApiResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT id, source_scope_json FROM rooms WHERE archived_at IS NULL AND source_scope_json IS NOT NULL ORDER BY kind='general' DESC, created_at, rowid",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut rooms = Vec::new();
    for row in rows {
        let (room_id, scope) = row?;
        if followed(&crate::util::safe_json(&scope, json!({})), source_id) {
            rooms.push(room_id);
        }
    }
    Ok(rooms)
}

/// Whether a room's `sourceScope` names a source.
pub fn followed(scope: &Value, source_id: &str) -> bool {
    scope
        .get("sources")
        .and_then(Value::as_array)
        .is_some_and(|sources| sources.iter().any(|id| id.as_str() == Some(source_id)))
}

/// A source as the API shows it: no cursor, no credential, with the rooms
/// that follow it.
pub fn view(conn: &rusqlite::Connection, source: &Source) -> Value {
    let mut value = serde_json::to_value(source).unwrap_or_else(|_| json!({}));
    value["rooms"] = json!(following_rooms(conn, &source.id).unwrap_or_default());
    value["cadenceMs"] = json!(cadence_ms(&source.kind));
    value
}
