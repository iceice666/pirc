//! Waking up (plans/rewrite/05-self-wake.md): the brain wakes when nobody
//! called it — an open loop's time came (or the day before an `autoClose`
//! time: a deadline, a meeting), it asked to come back (`schedule_wake`),
//! or (plan 09) a source changed. A wake only reads and remembers; it says
//! something in the room only when it calls `speak`, and otherwise nothing
//! shows there (the engine lists it).
//!
//! The `wakes` table is the queue and the record: a row is pending
//! (`outcome` and `started_at` NULL) until the brain's scheduler starts it
//! behind every user turn (`brain/scheduler.rs`), at most
//! `PIRC_WAKES_PER_DAY` a day ([`quota`]); then it ends `spoke`,
//! `silent`, `preempted` (a user turn took over: put back once, as a new
//! row), `failed`, `quota` or `cancelled`. The open loops' timer
//! ([`timer`]) enqueues the anchor wakes.

pub mod quota;
pub mod timer;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::app::App;
use crate::brain::loops::{self, Event, OpenLoop};
use crate::db::rooms::{HOST_FACE_ID, MessageKind, RoomStore, Speaker};
use crate::error::{ApiError, ApiResult};
use crate::memory::text::clip;
use crate::util::{new_id, safe_json};

/// Wakes listed at most.
pub const MAX_PAGE: usize = 200;
/// A wake put back after a user turn took over is not put back again.
pub const MAX_ATTEMPTS: i64 = 2;
const WHY_MAX: usize = 300;
const PUSH_MAX: usize = 180;

/// What woke the brain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// An open loop's time anchor (`trigger: {loopId, moment, at, autoClose}`).
    Anchor,
    /// A source changed (plan 09).
    #[allow(dead_code, reason = "sources start in plan 09")]
    Source,
    /// It asked to come back (`trigger: {at, why}`).
    SelfScheduled,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anchor => "anchor",
            Self::Source => "source",
            Self::SelfScheduled => "self",
        }
    }
}

/// How a wake ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It said something in the room (`speak`).
    Spoke,
    /// It did not: only its memory and loops changed, if anything.
    Silent,
    /// A user turn took over.
    Preempted,
    Failed,
    /// Past the day's wakes: it did not start.
    Quota,
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spoke => "spoke",
            Self::Silent => "silent",
            Self::Preempted => "preempted",
            Self::Failed => "failed",
            Self::Quota => "quota",
            Self::Cancelled => "cancelled",
        }
    }
}

/// When a loop's anchor wakes the brain (`trigger.moment`).
pub mod moment {
    /// A one-time anchor came.
    pub const DUE: &str = "due";
    /// The day before an `autoClose` time.
    pub const EVE: &str = "eve";
    /// A recurrence came (and moved on to its next time).
    pub const NEXT: &str = "next";
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub id: String,
    /// `anchor`, `source` or `self`.
    pub kind: String,
    pub trigger: Value,
    pub room_id: String,
    pub face_id: Option<String>,
    /// Whom it is for: the loop's owner, or who was talking when the
    /// brain asked to come back.
    pub user: Option<String>,
    pub scheduled_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub outcome: Option<String>,
    pub note: Option<String>,
    pub attempt: i64,
    pub turn_id: Option<String>,
    pub created_at: i64,
}

impl Wake {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            trigger: safe_json(&row.get::<_, String>("trigger_json")?, json!({})),
            room_id: row.get("room_id")?,
            face_id: row.get("face_id")?,
            user: row.get("owner_user")?,
            scheduled_at: row.get("scheduled_at")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            outcome: row.get("outcome")?,
            note: row.get("note")?,
            attempt: row.get("attempt")?,
            turn_id: row.get("turn_id")?,
            created_at: row.get("created_at")?,
        })
    }

    /// The loop of an anchor wake.
    pub fn loop_id(&self) -> Option<&str> {
        self.trigger.get("loopId").and_then(Value::as_str)
    }

    /// An anchor wake whose loop closes itself once the wake is over.
    pub fn closes_loop(&self) -> bool {
        self.kind == Kind::Anchor.as_str()
            && self.trigger.get("autoClose") == Some(&json!(true))
            && self.trigger.get("moment").and_then(Value::as_str) == Some(moment::DUE)
    }
}

// ---------- the store ----------

/// A wake to enqueue.
pub struct NewWake<'a> {
    pub kind: Kind,
    pub trigger: Value,
    pub room_id: &'a str,
    pub user: Option<&'a str>,
    pub scheduled_at: i64,
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Wake> {
    conn.query_row("SELECT * FROM wakes WHERE id=?", [id], Wake::from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found(format!("No wake {id}")))
}

pub fn enqueue(conn: &Connection, new: &NewWake<'_>, now: i64) -> ApiResult<Wake> {
    insert(conn, new, 1, now)
}

fn insert(conn: &Connection, new: &NewWake<'_>, attempt: i64, now: i64) -> ApiResult<Wake> {
    let id = new_id("wake");
    conn.execute(
        "INSERT INTO wakes (id,kind,trigger_json,room_id,face_id,owner_user,scheduled_at,attempt,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        params![
            id,
            new.kind.as_str(),
            new.trigger.to_string(),
            new.room_id,
            HOST_FACE_ID,
            new.user,
            new.scheduled_at,
            attempt,
            now
        ],
    )?;
    get(conn, &id)
}

/// The pending wake that is due first, if it is due by `now`; else when
/// the first pending one is.
pub fn next(conn: &Connection, now: i64) -> ApiResult<(Option<Wake>, Option<i64>)> {
    let first = conn
        .query_row(
            "SELECT * FROM wakes WHERE outcome IS NULL AND started_at IS NULL ORDER BY scheduled_at, created_at, rowid LIMIT 1",
            [],
            Wake::from_row,
        )
        .optional()?;
    Ok(match first {
        Some(wake) if wake.scheduled_at <= now => (Some(wake), None),
        Some(wake) => (None, Some(wake.scheduled_at)),
        None => (None, None),
    })
}

/// It starts, as the brain turn `turn_id`.
pub fn start(conn: &Connection, id: &str, turn_id: &str, now: i64) -> ApiResult<Wake> {
    conn.execute(
        "UPDATE wakes SET started_at=?, turn_id=? WHERE id=? AND outcome IS NULL",
        params![now, turn_id, id],
    )?;
    get(conn, id)
}

pub fn end(
    conn: &Connection,
    id: &str,
    outcome: Outcome,
    note: Option<&str>,
    now: i64,
) -> ApiResult<Wake> {
    conn.execute(
        "UPDATE wakes SET outcome=?, note=?, ended_at=? WHERE id=? AND outcome IS NULL",
        params![outcome.as_str(), note, now, id],
    )?;
    get(conn, id)
}

/// Cancel a pending wake; one that ended is returned as it is (`true`), one
/// that is running is 409 `wake_running`.
pub fn cancel(conn: &Connection, id: &str, now: i64) -> ApiResult<(Wake, bool)> {
    let found = get(conn, id)?;
    if found.outcome.is_some() {
        return Ok((found, true));
    }
    if found.started_at.is_some() {
        return Err(ApiError::new(
            409,
            "wake_running",
            format!("{id} is running; it cannot be cancelled now"),
        ));
    }
    Ok((end(conn, id, Outcome::Cancelled, None, now)?, false))
}

/// A wake a user turn took over, put back behind it (a new row: the first
/// keeps its `preempted`).
pub fn put_back(conn: &Connection, wake: &Wake, now: i64) -> ApiResult<Wake> {
    insert(
        conn,
        &NewWake {
            kind: match wake.kind.as_str() {
                "anchor" => Kind::Anchor,
                "source" => Kind::Source,
                _ => Kind::SelfScheduled,
            },
            trigger: wake.trigger.clone(),
            room_id: &wake.room_id,
            user: wake.user.as_deref(),
            scheduled_at: now,
        },
        wake.attempt + 1,
        now,
    )
}

/// Wakes still running when the gateway stopped: `failed` (`interrupted`).
pub fn close_interrupted(conn: &Connection, now: i64) -> ApiResult<Vec<Wake>> {
    let ids: Vec<String> = {
        let mut statement =
            conn.prepare("SELECT id FROM wakes WHERE outcome IS NULL AND started_at IS NOT NULL")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    ids.iter()
        .map(|id| end(conn, id, Outcome::Failed, Some("interrupted"), now))
        .collect()
}

/// Which wakes a list shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Pending and running, the next first.
    Pending,
    /// Ended, the latest first.
    Ended,
}

pub fn list(
    conn: &Connection,
    room_id: Option<&str>,
    status: Status,
    limit: usize,
) -> ApiResult<Vec<Wake>> {
    let sql = match status {
        Status::Pending => {
            "SELECT * FROM wakes WHERE outcome IS NULL AND (?1 IS NULL OR room_id=?1) ORDER BY scheduled_at, created_at, rowid LIMIT ?2"
        }
        Status::Ended => {
            "SELECT * FROM wakes WHERE outcome IS NOT NULL AND (?1 IS NULL OR room_id=?1) ORDER BY ended_at DESC, rowid DESC LIMIT ?2"
        }
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(
        params![room_id, limit.clamp(1, MAX_PAGE) as i64],
        Wake::from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------- the gateway ----------

/// Whether the brain wakes at all: it runs, and may wake at least once a
/// day. Without, an `autoClose` time closes its loop when it comes.
pub fn enabled(app: &App) -> bool {
    app.config.brain_enabled && app.config.wakes_per_day > 0
}

/// Enqueue a wake, tell the room's stream and the brain.
pub fn schedule(app: &App, new: &NewWake<'_>) -> ApiResult<Wake> {
    let wake = enqueue(&app.db.lock(), new, crate::util::now_ms())?;
    changed(app, &wake);
    crate::brain::Brain::nudge(app);
    Ok(wake)
}

/// A `wake_changed {wake}` event on the room's stream.
pub fn changed(app: &App, wake: &Wake) {
    app.rooms
        .publish(&wake.room_id, "wake_changed", json!({ "wake": wake }), None);
}

/// The open loop's time came: wake the brain for it (`moment` of
/// [`moment`]), in the loop's room.
pub fn for_loop(app: &App, open_loop: &OpenLoop, moment: &str, at: Option<i64>) {
    let room = loops::home_room(app, open_loop);
    let auto_close = open_loop
        .anchor
        .as_ref()
        .is_some_and(|anchor| anchor.get("autoClose") == Some(&json!(true)));
    let new = NewWake {
        kind: Kind::Anchor,
        trigger: json!({ "loopId": open_loop.id, "moment": moment, "at": at, "autoClose": auto_close }),
        room_id: &room,
        user: Some(&open_loop.user),
        scheduled_at: crate::util::now_ms(),
    };
    if let Err(error) = schedule(app, &new) {
        crate::log::warn(&format!(
            "wake: cannot wake up for {}: {}",
            open_loop.id, error.message
        ));
        // Its loop must not stay open waiting for a wake that never comes.
        if moment == moment::DUE && auto_close {
            close_elapsed(app, &open_loop.id);
        }
    }
}

/// What follows a wake's end: a loop whose time was the thing itself
/// closes (`elapsed`), and a time that came is said even when the brain
/// could not wake for it (failed, or past the day's wakes).
pub fn settle(app: &App, wake: &Wake) {
    changed(app, wake);
    if wake.kind != Kind::Anchor.as_str() {
        return;
    }
    let Some(loop_id) = wake.loop_id() else {
        return;
    };
    let unsaid = matches!(wake.outcome.as_deref(), Some("failed" | "quota"));
    if unsaid && wake.trigger.get("moment").and_then(Value::as_str) != Some(moment::EVE) {
        let found = loops::get(&app.db.lock(), loop_id);
        if let Ok(open_loop) = found {
            let text = format!("Reminder: {}", open_loop.what);
            post_line(app, &wake.room_id, &json!({ "text": text }));
            push(app, wake, &text);
        }
    }
    if wake.closes_loop() {
        close_elapsed(app, loop_id);
    }
}

fn close_elapsed(app: &App, loop_id: &str) {
    let closed = loops::close(
        &app.db.lock(),
        loop_id,
        loops::ELAPSED,
        crate::util::now_ms(),
    );
    match closed {
        Ok((open_loop, false)) => {
            let room = loops::home_room(app, &open_loop);
            loops::say(app, &room, &open_loop, Event::Closed);
        }
        Ok((_, true)) => {}
        Err(error) => crate::log::warn(&format!("wake: cannot close {loop_id}: {}", error.message)),
    }
}

/// When a wake comes, as the room reads it.
pub fn when(app: &App, at: i64) -> String {
    loops::when(at, &json!({ "zone": app.config.timezone }))
}

/// `why` of a self wake, cleaned.
pub fn why(text: &str) -> Result<String, String> {
    let text = crate::memory::store::clean(text);
    if text.is_empty() {
        return Err("`why` is required".to_owned());
    }
    if text.encode_utf16().count() > WHY_MAX {
        return Err(format!("`why` holds at most {WHY_MAX} characters"));
    }
    Ok(text)
}

/// The room's line for a self wake: scheduled (with a Cancel), or
/// cancelled. `body.wake {id, event}`.
pub fn say(app: &App, wake: &Wake, cancelled: bool) {
    let why = wake
        .trigger
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = if cancelled {
        format!("I won't come back about: {why}")
    } else {
        format!(
            "I'll come back {} to look at: {why}",
            when(app, wake.scheduled_at)
        )
    };
    let event = if cancelled { "cancelled" } else { "scheduled" };
    post_line(
        app,
        &wake.room_id,
        &json!({ "text": text, "wake": { "id": wake.id, "event": event } }),
    );
}

fn post_line(app: &App, room_id: &str, body: &Value) {
    let posted = app.db.lock().post_message(
        room_id,
        Speaker::Face(HOST_FACE_ID),
        MessageKind::Line,
        body,
    );
    match posted {
        Ok(message) => {
            app.room_message(&message);
            if let Ok(room) = app.db.lock().get_room(room_id) {
                app.room_changed(&room);
            }
        }
        Err(error) => crate::log::warn(&format!(
            "wake: cannot write a line in {room_id}: {}",
            error.message
        )),
    }
}

/// A notification of what the brain said on waking, to whom the wake is
/// for, opening the room.
pub fn push(app: &App, wake: &Wake, text: &str) {
    let Some(user) = &wake.user else {
        return;
    };
    let title = app.db.lock().get_room(&wake.room_id).map_or_else(
        |_| "pirc".to_owned(),
        |room| format!("pirc · #{}", room.name),
    );
    crate::push::notify(
        app,
        user,
        crate::push::room_message(&wake.room_id, title, clip(text, PUSH_MAX)),
    );
}

/// What woke the brain, in its words: the first lines of a wake turn's
/// input.
pub fn describe(app: &App, wake: &Wake) -> String {
    let at = |key: &str| wake.trigger.get(key).and_then(Value::as_i64);
    match wake.kind.as_str() {
        "anchor" => {
            let found = wake
                .loop_id()
                .and_then(|id| loops::get(&app.db.lock(), id).ok());
            let Some(open_loop) = found else {
                return "An open loop's time came, but the loop is gone.".to_owned();
            };
            let mut line = format!("[{}] {}", open_loop.id, open_loop.what);
            if !open_loop.why.is_empty() {
                line.push_str(&format!(" (why: {})", open_loop.why));
            }
            line.push_str(&format!(" · from {}", open_loop.origin));
            if let Some(anchor) = &open_loop.anchor {
                let described = loops::describe_anchor(anchor, open_loop.due_at);
                if !described.is_empty() {
                    line.push_str(&format!(" · {described}"));
                }
            }
            if let Some(check) = &open_loop.next_check {
                line.push_str(&format!(" · next check: {check}"));
            }
            match wake.trigger.get("moment").and_then(Value::as_str) {
                Some(moment::EVE) => format!(
                    "An open loop is due tomorrow ({}): {line}",
                    at("at").map(|at| when(app, at)).unwrap_or_default()
                ),
                Some(moment::NEXT) => format!("A recurring open loop's time came: {line}"),
                _ if wake.closes_loop() => format!(
                    "An open loop's time came: {line}. Its time was the thing itself, so it closes once this wake is over."
                ),
                _ => {
                    format!("An open loop's time came: {line}. It stays open until it is resolved.")
                }
            }
        }
        "self" => format!(
            "You asked to come back now (on {}) to look at: {}",
            when(app, wake.created_at),
            wake.trigger
                .get("why")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
        _ => format!("A source changed: {}", wake.trigger),
    }
}

#[cfg(test)]
mod tests;
