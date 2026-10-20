//! Open loops (plans/rewrite/04-open-loops.md): what is still open between
//! the brain and the people ("tune the laptop's power policy", "the team
//! meeting every Wednesday at 18:00"), its first-class objects.
//!
//! - The brain opens, closes, touches and changes them itself (no
//!   approval), and the room is told each time with a line that undoes it.
//! - They are always in its prompt ([`section`]). Past [`OPEN_LIMIT`], the
//!   ones without a time anchor that were mentioned least recently become
//!   facts ([`demote_overflow`]); anchored ones never do.
//! - A time anchor is a time (`{at}`) or a recurrence (`{cron, zone,
//!   until?}`). When it comes ([`fire_due`], the timer of [`start_timer`]),
//!   a time that is the thing itself (`autoClose`: a meeting, a deadline)
//!   closes the loop (`elapsed`); a recurrence moves to its next time, and
//!   ends with `until` (`recurrence_ended`). The brain wakes for each
//!   (plans/rewrite/05-self-wake.md), and the day before an `autoClose`
//!   time too; such a time then closes its loop once that wake is over.
//! - The origin is the gateway's to say, as for facts: `user`, or
//!   `tool:<source>` when something the brain read is behind it. A
//!   `tool:*` loop never authorizes an action on its own (plans 06, 07).

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use chrono::Datelike;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app::App;
use crate::db::atomic;
use crate::db::rooms::{GENERAL_ROOM_ID, HOST_FACE_ID, MessageKind, RoomStore, Speaker};
use crate::error::{ApiError, ApiResult};
use crate::memory::store::{ENTRY_MAX_CHARS, clean};
use crate::memory::text::{clip, content_hash};
use crate::memory_records::person::{self, NewFact};
use crate::time::cron::{Cron, Zone, format_time, to_tz};
use crate::util::{hex, now_ms, random_bytes, safe_json};
use crate::wake::timer::DeadlineTimer;

/// Open loops always in the prompt, at most (decision #2).
pub const OPEN_LIMIT: usize = 40;
const WHAT_MAX: usize = 300;
const WHY_MAX: usize = 1000;
const NEXT_CHECK_MAX: usize = 500;
const REASON_MAX: usize = 300;
/// Closed loops listed at most.
pub const MAX_PAGE: usize = 200;

/// Reasons the gateway closes a loop for.
pub const ELAPSED: &str = "elapsed";
pub const RECURRENCE_ENDED: &str = "recurrence_ended";
pub const DEMOTED: &str = "demoted";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLoop {
    pub id: String,
    /// Whose it is: where it goes when demoted.
    pub user: String,
    pub room_id: Option<String>,
    pub face_id: Option<String>,
    pub what: String,
    pub why: String,
    /// `user` or `tool:<source>`.
    pub origin: String,
    /// `{at, zone, autoClose, passed?}` or `{cron, zone, until?, nextAt}`.
    pub anchor: Option<Value>,
    pub next_check: Option<String>,
    /// `open` or `closed`.
    pub status: String,
    pub closed_reason: Option<String>,
    pub closed_at: Option<i64>,
    pub created_at: i64,
    pub last_touched_at: i64,
    pub source_entry_ids: Value,
    /// When its anchor comes next, while open.
    pub due_at: Option<i64>,
    /// The day before an `autoClose` time, while that is still to come:
    /// the brain wakes then too (plans/rewrite/05-self-wake.md).
    pub notice_at: Option<i64>,
}

impl OpenLoop {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            user: row.get("owner_user")?,
            room_id: row.get("room_id")?,
            face_id: row.get("face_id")?,
            what: row.get("what")?,
            why: row.get("why")?,
            origin: row.get("origin")?,
            anchor: row
                .get::<_, Option<String>>("anchor_json")?
                .map(|anchor| safe_json(&anchor, Value::Null))
                .filter(Value::is_object),
            next_check: row.get("next_check")?,
            status: row.get("status")?,
            closed_reason: row.get("closed_reason")?,
            closed_at: row.get("closed_at")?,
            created_at: row.get("created_at")?,
            last_touched_at: row.get("last_touched_at")?,
            source_entry_ids: safe_json(&row.get::<_, String>("source_entry_ids_json")?, json!([])),
            due_at: row.get("due_at")?,
            notice_at: row.get("notice_at")?,
        })
    }

    pub fn is_open(&self) -> bool {
        self.status == "open"
    }
}

// ---------- anchors ----------

/// A time anchor as the brain (or the API) gives it: `at` a date and time,
/// or `cron` a pattern, in `zone` (the gateway's `PIRC_TIMEZONE` without).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorInput {
    pub at: Option<String>,
    pub cron: Option<String>,
    pub zone: Option<String>,
    pub until: Option<String>,
    pub auto_close: Option<bool>,
}

/// A checked anchor: what is stored, when it comes first, and the day
/// before an `autoClose` time while that is to come.
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub json: Value,
    pub due_at: i64,
    pub notice_at: Option<i64>,
}

const DAY_MS: i64 = 86_400_000;

/// The day before a time that is the thing itself, if that is still to come.
fn notice(at: i64, auto_close: bool, now: i64) -> Option<i64> {
    (auto_close && at - DAY_MS > now).then_some(at - DAY_MS)
}

fn zone_of(name: &str) -> Result<Zone, String> {
    Zone::parse(name).ok_or_else(|| format!("Unknown time zone `{name}`"))
}

/// A date and time (ISO 8601, wall time in `zone` without an offset).
fn instant(text: &str, zone: Zone, field: &str) -> Result<i64, String> {
    match Cron::new(text.trim(), zone) {
        Ok(Cron::Once(at)) => Ok(at),
        _ => Err(format!(
            "`{field}` is a date and time like 2026-10-22T18:00"
        )),
    }
}

impl AnchorInput {
    /// Check it against the time now.
    pub fn resolve(&self, default_zone: &str, now: i64) -> Result<Anchor, String> {
        let zone_name = self
            .zone
            .as_deref()
            .map(str::trim)
            .filter(|zone| !zone.is_empty())
            .unwrap_or(default_zone);
        let zone = zone_of(zone_name)?;
        match (&self.at, &self.cron) {
            (Some(at), None) => {
                if self.until.is_some() {
                    return Err("`until` is for a recurrence (`cron`)".to_owned());
                }
                let at = instant(at, zone, "at")?;
                if at <= now {
                    return Err("That time has passed".to_owned());
                }
                let auto_close = self.auto_close.unwrap_or(false);
                Ok(Anchor {
                    json: json!({ "at": at, "zone": zone_name, "autoClose": auto_close }),
                    due_at: at,
                    notice_at: notice(at, auto_close, now),
                })
            }
            (None, Some(pattern)) => {
                if self.auto_close.is_some() {
                    return Err(
                        "`autoClose` is for a one-time anchor (`at`); a recurrence ends at `until`"
                            .to_owned(),
                    );
                }
                let pattern = pattern.trim();
                let cron = match Cron::new(pattern, zone) {
                    Ok(Cron::Pattern(pattern)) => Cron::Pattern(pattern),
                    Ok(Cron::Once(_)) => {
                        return Err(
                            "`cron` is a pattern like `0 18 * * 3`; a single time is `at`"
                                .to_owned(),
                        );
                    }
                    Err(error) => return Err(format!("Invalid cron \"{pattern}\": {}", error.0)),
                };
                let until = match &self.until {
                    None => None,
                    Some(until) => {
                        let until = instant(until, zone, "until")?;
                        if until <= now {
                            return Err("`until` has passed".to_owned());
                        }
                        Some(until)
                    }
                };
                let next = cron.next_run(now, zone).ok_or("That pattern never comes")?;
                if until.is_some_and(|until| next > until) {
                    return Err("It does not come before `until`".to_owned());
                }
                let mut json = json!({ "cron": pattern, "zone": zone_name, "nextAt": next });
                if let Some(until) = until {
                    json["until"] = json!(until);
                }
                Ok(Anchor {
                    json,
                    due_at: next,
                    notice_at: None,
                })
            }
            _ => Err("An anchor has `at` (one time) or `cron` (a recurrence)".to_owned()),
        }
    }
}

fn anchor_zone(anchor: &Value) -> Option<(Zone, String)> {
    let name = anchor.get("zone").and_then(Value::as_str)?;
    Some((Zone::parse(name)?, name.to_owned()))
}

/// The next time of a recurrence after `from`, if it comes before its
/// `until`.
fn next_time(anchor: &Value, from: i64) -> Option<i64> {
    let (zone, _) = anchor_zone(anchor)?;
    let cron = Cron::new(anchor.get("cron").and_then(Value::as_str)?, zone).ok()?;
    let next = cron.next_run(from, zone)?;
    let until = anchor.get("until").and_then(Value::as_i64);
    (until.is_none_or(|until| next <= until)).then_some(next)
}

/// `Wed 2026-10-22 18:00 (Asia/Taipei)`.
pub fn when(at: i64, anchor: &Value) -> String {
    let (zone, name) = anchor_zone(anchor).unwrap_or((Zone::Fixed(0), "UTC".to_owned()));
    let wall = to_tz(at, zone);
    let day = chrono::NaiveDate::from_ymd_opt(wall.y as i32, wall.m as u32, wall.d as u32)
        .map(|date| format!("{} ", date.weekday()))
        .unwrap_or_default();
    format!("{day}{}", format_time(at, zone, &name))
}

/// How an anchor reads: when it comes next, how it repeats, and whether it
/// closes itself.
pub fn describe_anchor(anchor: &Value, due_at: Option<i64>) -> String {
    let mut parts = Vec::new();
    if let Some(at) = anchor.get("at").and_then(Value::as_i64) {
        if anchor.get("passed") == Some(&json!(true)) || due_at.is_none() {
            parts.push(format!("was due {}", when(at, anchor)));
        } else {
            parts.push(format!("due {}", when(at, anchor)));
        }
        if anchor.get("autoClose") == Some(&json!(true)) {
            parts.push("closes itself then".to_owned());
        }
    } else if let Some(cron) = anchor.get("cron").and_then(Value::as_str) {
        if let Some(next) = due_at {
            parts.push(format!("next {}", when(next, anchor)));
        }
        let mut repeats = format!("repeats `{cron}`");
        if let Some(until) = anchor.get("until").and_then(Value::as_i64) {
            repeats.push_str(&format!(" until {}", when(until, anchor)));
        }
        parts.push(repeats);
    }
    parts.join(", ")
}

// ---------- the store ----------

/// A loop to open.
pub struct NewLoop<'a> {
    pub user: &'a str,
    pub room_id: Option<&'a str>,
    pub face_id: Option<&'a str>,
    pub what: &'a str,
    pub why: &'a str,
    pub origin: &'a str,
    pub anchor: Option<Anchor>,
    pub next_check: Option<&'a str>,
    pub source_entry_ids: &'a [String],
}

/// One line of text, cleaned, between 1 and `max` characters.
fn line_text(value: &str, max: usize, field: &str) -> ApiResult<String> {
    let text = clean(value);
    if text.is_empty() {
        return Err(ApiError::new(
            400,
            "invalid_input",
            format!("`{field}` is required"),
        ));
    }
    if text.encode_utf16().count() > max {
        return Err(ApiError::new(
            400,
            "invalid_input",
            format!("`{field}` holds at most {max} characters"),
        ));
    }
    Ok(text)
}

/// Optional text: empty is none.
fn optional_text(value: Option<&str>, max: usize, field: &str) -> ApiResult<Option<String>> {
    match value.map(clean).filter(|text| !text.is_empty()) {
        None => Ok(None),
        Some(text) => line_text(&text, max, field).map(Some),
    }
}

/// `l` and eight hex digits.
fn new_id(conn: &Connection) -> ApiResult<String> {
    loop {
        let id = format!("l{}", hex(&random_bytes::<4>()));
        if conn
            .query_row("SELECT 1 FROM open_loops WHERE id=?", [&id], |_| Ok(()))
            .optional()?
            .is_none()
        {
            return Ok(id);
        }
    }
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<OpenLoop> {
    conn.query_row(
        "SELECT * FROM open_loops WHERE id=?",
        [id],
        OpenLoop::from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::not_found(format!("No open loop {id}")))
}

/// Open a loop; an open one about the same thing (ignoring case and
/// spacing) is touched and returned instead (`true`).
pub fn open(conn: &Connection, new: &NewLoop<'_>, now: i64) -> ApiResult<(OpenLoop, bool)> {
    atomic(conn, |conn| {
        let what = line_text(new.what, WHAT_MAX, "what")?;
        let why = optional_text(Some(new.why), WHY_MAX, "why")?.unwrap_or_default();
        let next_check = optional_text(new.next_check, NEXT_CHECK_MAX, "next_check")?;
        let hash = content_hash(&what);
        if let Some(same) = list_open(conn)?
            .into_iter()
            .find(|known| content_hash(&known.what) == hash)
        {
            return touch(conn, &same.id, now).map(|same| (same, true));
        }
        let id = new_id(conn)?;
        conn.execute(
            "INSERT INTO open_loops (id,owner_user,room_id,face_id,what,why,origin,anchor_json,next_check,status,created_at,last_touched_at,source_entry_ids_json,due_at,notice_at) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?)",
            params![
                id,
                new.user,
                new.room_id,
                new.face_id,
                what,
                why,
                new.origin,
                new.anchor.as_ref().map(|anchor| anchor.json.to_string()),
                next_check,
                now,
                now,
                json!(new.source_entry_ids.iter().take(50).collect::<Vec<_>>()).to_string(),
                new.anchor.as_ref().map(|anchor| anchor.due_at),
                new.anchor.as_ref().and_then(|anchor| anchor.notice_at),
            ],
        )?;
        Ok((get(conn, &id)?, false))
    })
}

/// It came up again: it moves away from demotion.
pub fn touch(conn: &Connection, id: &str, now: i64) -> ApiResult<OpenLoop> {
    let found = get(conn, id)?;
    if !found.is_open() {
        return Err(closed(&found));
    }
    conn.execute(
        "UPDATE open_loops SET last_touched_at=? WHERE id=?",
        params![now, id],
    )?;
    get(conn, id)
}

fn closed(found: &OpenLoop) -> ApiError {
    ApiError::new(
        409,
        "loop_closed",
        format!("{} is closed; reopen it first", found.id),
    )
}

/// What changes in an open loop; `None` leaves a field as it is.
#[derive(Default)]
pub struct Changes<'a> {
    pub what: Option<&'a str>,
    pub why: Option<&'a str>,
    /// `Some(None)` takes the clue away.
    pub next_check: Option<Option<&'a str>>,
    /// `Some(None)` takes the anchor away.
    pub anchor: Option<Option<Anchor>>,
}

/// Change an open loop (which touches it).
pub fn update(conn: &Connection, id: &str, changes: &Changes<'_>, now: i64) -> ApiResult<OpenLoop> {
    atomic(conn, |conn| {
        let found = get(conn, id)?;
        if !found.is_open() {
            return Err(closed(&found));
        }
        let what = match changes.what {
            Some(what) => line_text(what, WHAT_MAX, "what")?,
            None => found.what,
        };
        let why = match changes.why {
            Some(why) => optional_text(Some(why), WHY_MAX, "why")?.unwrap_or_default(),
            None => found.why,
        };
        let next_check = match changes.next_check {
            Some(next_check) => optional_text(next_check, NEXT_CHECK_MAX, "next_check")?,
            None => found.next_check,
        };
        let (anchor, due_at, notice_at) = match &changes.anchor {
            Some(Some(anchor)) => (
                Some(anchor.json.clone()),
                Some(anchor.due_at),
                anchor.notice_at,
            ),
            Some(None) => (None, None, None),
            None => (found.anchor, found.due_at, found.notice_at),
        };
        conn.execute(
            "UPDATE open_loops SET what=?, why=?, next_check=?, anchor_json=?, due_at=?, notice_at=?, last_touched_at=? WHERE id=?",
            params![
                what,
                why,
                next_check,
                anchor.map(|anchor| anchor.to_string()),
                due_at,
                notice_at,
                now,
                id
            ],
        )?;
        get(conn, id)
    })
}

/// Close a loop for `reason`; a closed one is returned as it is (`true`).
pub fn close(conn: &Connection, id: &str, reason: &str, now: i64) -> ApiResult<(OpenLoop, bool)> {
    let reason = line_text(reason, REASON_MAX, "reason")?;
    let found = get(conn, id)?;
    if !found.is_open() {
        return Ok((found, true));
    }
    conn.execute(
        "UPDATE open_loops SET status='closed', closed_reason=?, closed_at=?, due_at=NULL, notice_at=NULL WHERE id=?",
        params![reason, now, id],
    )?;
    Ok((get(conn, id)?, false))
}

/// Open a closed loop again ("not done yet"); an open one is returned as
/// it is (`true`). Its anchor comes again from now; the fact it was
/// demoted into is taken back.
pub fn reopen(conn: &Connection, id: &str, now: i64) -> ApiResult<(OpenLoop, bool)> {
    atomic(conn, |conn| {
        let found = get(conn, id)?;
        if found.is_open() {
            return Ok((found, true));
        }
        let mut anchor = found.anchor.clone();
        let due_at = match anchor.as_mut() {
            Some(anchor) if anchor.get("cron").is_some() => {
                let next = next_time(anchor, now);
                if let Some(next) = next {
                    anchor["nextAt"] = json!(next);
                }
                next
            }
            Some(anchor) => match anchor.get("at").and_then(Value::as_i64) {
                Some(at) if at > now && anchor.get("passed") != Some(&json!(true)) => Some(at),
                _ => {
                    anchor["passed"] = json!(true);
                    None
                }
            },
            None => None,
        };
        let notice_at = match (&anchor, due_at) {
            (Some(anchor), Some(at)) if anchor.get("at").is_some() => {
                notice(at, anchor.get("autoClose") == Some(&json!(true)), now)
            }
            _ => None,
        };
        conn.execute(
            "UPDATE open_loops SET status='open', closed_reason=NULL, closed_at=NULL, anchor_json=?, due_at=?, notice_at=?, last_touched_at=? WHERE id=?",
            params![
                anchor.map(|anchor| anchor.to_string()),
                due_at,
                notice_at,
                now,
                id
            ],
        )?;
        let facts: Vec<(String, String)> = {
            let mut statement = conn.prepare(
                "SELECT owner_user, id FROM memory_records WHERE scope='person' AND open_loop_id=? AND status='active'",
            )?;
            let rows = statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (user, fact_id) in facts {
            person::retire(conn, &user, &fact_id)?;
        }
        Ok((get(conn, id)?, false))
    })
}

/// The open loops as the prompt lists them: those whose anchor comes
/// soonest first, then the most recently mentioned.
pub fn list_open(conn: &Connection) -> ApiResult<Vec<OpenLoop>> {
    let mut statement = conn.prepare(
        "SELECT * FROM open_loops WHERE status='open' ORDER BY due_at IS NULL, due_at, last_touched_at DESC, created_at DESC",
    )?;
    let rows = statement.query_map([], OpenLoop::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The latest closed loops, newest first.
pub fn list_closed(conn: &Connection, limit: usize) -> ApiResult<Vec<OpenLoop>> {
    let mut statement = conn.prepare(
        "SELECT * FROM open_loops WHERE status='closed' ORDER BY closed_at DESC, id LIMIT ?",
    )?;
    let rows = statement.query_map([limit.clamp(1, MAX_PAGE) as i64], OpenLoop::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A loop demoted, and the fact it became (none when its text was
/// forgotten, or already a fact).
#[derive(Debug)]
pub struct Demoted {
    pub open_loop: OpenLoop,
    pub fact_id: Option<String>,
}

/// The fact a demoted loop becomes.
fn fact_text(open_loop: &OpenLoop) -> String {
    let text = if open_loop.why.is_empty() {
        open_loop.what.clone()
    } else {
        format!("{} ({})", open_loop.what, open_loop.why)
    };
    clip(&text, ENTRY_MAX_CHARS)
}

/// Past [`OPEN_LIMIT`] open loops, the ones without an anchor mentioned
/// least recently become facts of their owner's (with their origin, and
/// the loop's id to reopen it), all at once.
pub fn demote_overflow(conn: &Connection, now: i64) -> ApiResult<Vec<Demoted>> {
    atomic(conn, |conn| {
        let open: i64 = conn.query_row(
            "SELECT count(*) FROM open_loops WHERE status='open'",
            [],
            |row| row.get(0),
        )?;
        let excess = open - OPEN_LIMIT as i64;
        if excess <= 0 {
            return Ok(Vec::new());
        }
        let oldest: Vec<OpenLoop> = {
            let mut statement = conn.prepare(
                "SELECT * FROM open_loops WHERE status='open' AND anchor_json IS NULL ORDER BY last_touched_at, created_at, id LIMIT ?",
            )?;
            let rows = statement.query_map([excess], OpenLoop::from_row)?;
            rows.collect::<Result<_, _>>()?
        };
        let mut demoted = Vec::new();
        for open_loop in oldest {
            let content = fact_text(&open_loop);
            let mut sources = vec![open_loop.id.clone()];
            sources.extend(
                open_loop
                    .source_entry_ids
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
            sources.truncate(50);
            let remembered = person::remember(
                conn,
                &open_loop.user,
                &NewFact {
                    content: &content,
                    origin: &open_loop.origin,
                    room_id: open_loop.room_id.as_deref(),
                    face_id: open_loop.face_id.as_deref(),
                    source_entry_ids: &sources,
                    actor: &format!("face:{HOST_FACE_ID}"),
                },
            );
            let fact_id = match remembered {
                Ok((fact, false)) => {
                    person::link_open_loop(conn, &fact.id, &open_loop.id)?;
                    Some(fact.id)
                }
                Ok((fact, true)) => Some(fact.id),
                // Forgotten text stays forgotten.
                Err(error) if error.status < 500 => None,
                Err(error) => return Err(error),
            };
            let (open_loop, _) = close(conn, &open_loop.id, DEMOTED, now)?;
            demoted.push(Demoted { open_loop, fact_id });
        }
        Ok(demoted)
    })
}

/// What an anchor's coming did to its loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fired {
    /// A time that was the thing itself: closed (`elapsed`), or, when the
    /// brain wakes for it, passed and closed once the wake is over.
    Elapsed,
    /// A time that was not: the loop waits for the people.
    Passed,
    /// A recurrence: on to its next time.
    Advanced,
    /// A recurrence past its `until`: closed (`recurrence_ended`).
    Ended,
    /// The day before an `autoClose` time.
    Eve,
}

/// The anchors that came by `now`, what that did, and the time that came.
/// With `defer_close` (the brain wakes for it), an `autoClose` time
/// leaves its loop open, passed, for the wake to close.
pub fn fire_due(
    conn: &Connection,
    now: i64,
    defer_close: bool,
) -> ApiResult<Vec<(OpenLoop, Fired, i64)>> {
    atomic(conn, |conn| {
        let due: Vec<OpenLoop> = {
            let mut statement = conn.prepare(
                "SELECT * FROM open_loops WHERE status='open' AND ((due_at IS NOT NULL AND due_at<=?1) OR (notice_at IS NOT NULL AND notice_at<=?1)) ORDER BY min(coalesce(due_at, notice_at), coalesce(notice_at, due_at)), id",
            )?;
            let rows = statement.query_map([now], OpenLoop::from_row)?;
            rows.collect::<Result<_, _>>()?
        };
        let mut fired = Vec::new();
        for open_loop in due {
            if open_loop.due_at.is_none_or(|due_at| due_at > now) {
                // Only the day before came.
                conn.execute(
                    "UPDATE open_loops SET notice_at=NULL WHERE id=?",
                    [&open_loop.id],
                )?;
                let at = open_loop.due_at.unwrap_or(now);
                fired.push((get(conn, &open_loop.id)?, Fired::Eve, at));
                continue;
            }
            let came = open_loop.due_at.unwrap_or(now);
            conn.execute(
                "UPDATE open_loops SET notice_at=NULL WHERE id=?",
                [&open_loop.id],
            )?;
            let mut anchor = open_loop.anchor.clone().unwrap_or(Value::Null);
            let what = if anchor.get("cron").is_some() {
                // A suspended machine catches up once, from now.
                let from = now.max(open_loop.due_at.unwrap_or(now));
                match next_time(&anchor, from) {
                    Some(next) => {
                        anchor["nextAt"] = json!(next);
                        conn.execute(
                            "UPDATE open_loops SET anchor_json=?, due_at=? WHERE id=?",
                            params![anchor.to_string(), next, open_loop.id],
                        )?;
                        Fired::Advanced
                    }
                    None => {
                        close(conn, &open_loop.id, RECURRENCE_ENDED, now)?;
                        Fired::Ended
                    }
                }
            } else if anchor.get("autoClose") == Some(&json!(true)) && !defer_close {
                close(conn, &open_loop.id, ELAPSED, now)?;
                Fired::Elapsed
            } else if anchor.get("autoClose") == Some(&json!(true)) {
                anchor["passed"] = json!(true);
                conn.execute(
                    "UPDATE open_loops SET anchor_json=?, due_at=NULL WHERE id=?",
                    params![anchor.to_string(), open_loop.id],
                )?;
                Fired::Elapsed
            } else {
                if anchor.is_object() {
                    anchor["passed"] = json!(true);
                }
                conn.execute(
                    "UPDATE open_loops SET anchor_json=?, due_at=NULL WHERE id=?",
                    params![
                        Some(anchor).filter(Value::is_object).map(|a| a.to_string()),
                        open_loop.id
                    ],
                )?;
                Fired::Passed
            };
            fired.push((get(conn, &open_loop.id)?, what, came));
        }
        Ok(fired)
    })
}

/// When the next anchor (or the day before one) comes.
pub fn next_due(conn: &Connection) -> ApiResult<Option<i64>> {
    Ok(conn.query_row(
        "SELECT min(min(coalesce(due_at, notice_at), coalesce(notice_at, due_at))) FROM open_loops WHERE status='open' AND (due_at IS NOT NULL OR notice_at IS NOT NULL)",
        [],
        |row| row.get(0),
    )?)
}

// ---------- the room ----------

/// What happened to a loop, as the room hears it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Opened,
    Closed,
    Demoted,
    Reopened,
}

impl Event {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opened => "opened",
            Self::Closed => "closed",
            Self::Demoted => "demoted",
            Self::Reopened => "reopened",
        }
    }
}

/// Why a loop was closed, in words.
pub fn reason_text(reason: &str) -> &str {
    match reason {
        ELAPSED => "its time has passed",
        RECURRENCE_ENDED => "it does not come again",
        DEMOTED => "kept in memory",
        reason => reason,
    }
}

/// The line that says it.
fn line_text_of(open_loop: &OpenLoop, event: Event) -> String {
    match event {
        Event::Opened => {
            let anchor = open_loop
                .anchor
                .as_ref()
                .map(|anchor| describe_anchor(anchor, open_loop.due_at))
                .filter(|text| !text.is_empty())
                .map(|text| format!(" ({text})"))
                .unwrap_or_default();
            format!("Holding on to: {}{anchor}", open_loop.what)
        }
        Event::Closed => format!(
            "Closed: {} ({})",
            open_loop.what,
            reason_text(open_loop.closed_reason.as_deref().unwrap_or_default())
        ),
        Event::Demoted => format!(
            "This sat untouched for a while, so I put it in memory: {}",
            open_loop.what
        ),
        Event::Reopened => format!("Open again: {}", open_loop.what),
    }
}

/// Say in `room_id` what happened to a loop (`body.loop {id, event}`, which
/// the web turns into "Don't keep" or "Not done yet"), and tell everyone.
pub fn say(app: &App, room_id: &str, open_loop: &OpenLoop, event: Event) {
    let body = json!({
        "text": line_text_of(open_loop, event),
        "loop": { "id": open_loop.id, "event": event.as_str() },
    });
    let posted = app.db.lock().post_message(
        room_id,
        Speaker::Face(HOST_FACE_ID),
        MessageKind::Line,
        &body,
    );
    match posted {
        Ok(message) => {
            app.room_message(&message);
            if let Ok(room) = app.db.lock().get_room(room_id) {
                app.room_changed(&room);
            }
        }
        Err(error) => crate::log::warn(&format!(
            "loops: cannot say what happened to {} in {room_id}: {}",
            open_loop.id, error.message
        )),
    }
    changed(app, open_loop);
}

/// The room a loop's own lines go to: its room while that is there and
/// not archived, else #general.
pub fn home_room(app: &App, open_loop: &OpenLoop) -> String {
    open_loop
        .room_id
        .as_deref()
        .filter(|room_id| {
            app.db
                .lock()
                .get_room(room_id)
                .is_ok_and(|room| room.archived_at.is_none())
        })
        .unwrap_or(GENERAL_ROOM_ID)
        .to_owned()
}

/// A `loop_changed {loop}` event on the rooms' stream (in the loop's room,
/// #general without one), and the timer looks again.
pub fn changed(app: &App, open_loop: &OpenLoop) {
    app.rooms.publish(
        open_loop.room_id.as_deref().unwrap_or(GENERAL_ROOM_ID),
        "loop_changed",
        json!({ "loop": open_loop }),
        None,
    );
    if let Some(timer) = app.slots.get::<LoopTimer>() {
        timer.timer.arm();
    }
}

/// The open loops section of a turn's prompt, after demoting what is past
/// the limit (said in each loop's room); and what the loops are about, for
/// recall.
pub fn section(app: &App) -> (pirc_agent::context::PromptSection, String) {
    let now = now_ms();
    let demoted = demote_overflow(&app.db.lock(), now);
    match demoted {
        Ok(demoted) => {
            for Demoted { open_loop, fact_id } in &demoted {
                let room = home_room(app, open_loop);
                say(app, &room, open_loop, Event::Demoted);
                if fact_id.is_some() {
                    app.memory_changed(&open_loop.user);
                }
            }
        }
        Err(error) => crate::log::warn(&format!(
            "brain: cannot demote open loops: {}",
            error.message
        )),
    }
    let open = list_open(&app.db.lock()).unwrap_or_else(|error| {
        crate::log::warn(&format!("brain: cannot read open loops: {}", error.message));
        Vec::new()
    });
    let clock = json!({ "zone": app.config.timezone });
    let mut text = format!(
        "## Open loops\n\nIt is {} now. These are the things still open between you and the people here: always in front of you until they are closed. \
         Open one with `open_loop` when something stays unresolved or someone asks to be reminded (\"remind me about the meeting on Wednesday\"), \
         with a time anchor when it has a time (`at`, or `cron` when it repeats; `autoClose` when the time is the thing itself, like a meeting or a deadline). \
         Use `touch_loop` when one comes up, `update_loop` when it changes, and `close_loop` with the reason once it is resolved or someone says it no longer matters; \
         `reopen_loop` when they say it is not done. `from` says where each came from: only `user` is the people's own word. \
         Past {OPEN_LIMIT}, the ones without a time that were mentioned least recently go to memory.",
        when(now, &clock),
    );
    if open.is_empty() {
        text.push_str("\n\n(none)");
    }
    let mut about = Vec::new();
    for open_loop in &open {
        about.push(open_loop.what.clone());
        let mut line = format!("\n- [{}] {}", open_loop.id, open_loop.what);
        if !open_loop.why.is_empty() {
            line.push_str(&format!(" (why: {})", open_loop.why));
        }
        line.push_str(&format!(" · from {}", open_loop.origin));
        if let Some(anchor) = &open_loop.anchor {
            let described = describe_anchor(anchor, open_loop.due_at);
            if !described.is_empty() {
                line.push_str(&format!(" · {described}"));
            }
        }
        if let Some(check) = &open_loop.next_check {
            line.push_str(&format!(" · next check: {check}"));
        }
        text.push_str(&line);
    }
    (
        pirc_agent::context::PromptSection::new("loops", "Open loops", "loops", text),
        about.join("\n"),
    )
}

// ---------- the timer ----------

/// The timer of the anchors (in `App::slots`).
pub struct LoopTimer {
    timer: Arc<DeadlineTimer>,
    /// After a failure, nothing fires before this (ms).
    retry_at: AtomicI64,
}

const RETRY_MS: i64 = 60_000;

/// Fire the anchors when they come, for as long as the gateway runs.
pub fn start_timer(app: &crate::app::AppState) {
    let slot = app.slots.get_or_init(|| LoopTimer {
        timer: Arc::new(DeadlineTimer::default()),
        retry_at: AtomicI64::new(0),
    });
    let due = {
        let (app, slot) = (app.clone(), slot.clone());
        move || {
            let next = next_due(&app.db.lock()).ok().flatten()?;
            Some(next.max(slot.retry_at.load(Ordering::Relaxed)))
        }
    };
    let fire = {
        let (app, slot) = (app.clone(), slot.clone());
        move || fire(&app, &slot)
    };
    slot.timer.start(due, fire);
}

/// The anchors that came: the brain wakes for each (plans/rewrite/05),
/// and what closed is said.
fn fire(app: &App, slot: &LoopTimer) {
    use crate::wake::{self, moment};
    let waking = wake::enabled(app);
    let fired = fire_due(&app.db.lock(), now_ms(), waking);
    match fired {
        Ok(fired) => {
            for (open_loop, what, at) in fired {
                if !open_loop.is_open() {
                    let room = home_room(app, &open_loop);
                    say(app, &room, &open_loop, Event::Closed);
                } else {
                    changed(app, &open_loop);
                }
                let moment = match what {
                    Fired::Elapsed | Fired::Passed => moment::DUE,
                    Fired::Advanced => moment::NEXT,
                    Fired::Eve => moment::EVE,
                    Fired::Ended => continue,
                };
                if waking {
                    wake::for_loop(app, &open_loop, moment, Some(at));
                }
            }
        }
        Err(error) => {
            crate::log::warn(&format!(
                "loops: cannot fire the anchors that came: {}",
                error.message
            ));
            slot.retry_at.store(now_ms() + RETRY_MS, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests;
