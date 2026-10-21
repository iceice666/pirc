//! Polling: every source that is not paused, at its kind's cadence. A
//! poll's new and changed items go into `source_items`; when [`filter`]
//! says so, one wake is enqueued for the whole poll (`kind: source`).
//! Three failures in a row are said once in the room (the first that
//! follows the source, else #general), until a poll succeeds again.
//!
//! [`filter`]: super::filter

use std::time::Duration;

use serde_json::{Value, json};

use super::store::{self, Item, Source};
use super::{SourceError, filter, service};
use crate::app::AppState;
use crate::db::rooms::GENERAL_ROOM_ID;
use crate::error::{ApiError, ApiResult};
use crate::util::now_ms;
use crate::wake::{self, Kind, NewWake};

/// One poll, at most.
const POLL_TIMEOUT: Duration = Duration::from_secs(90);
/// The poller looks again at least this often.
const IDLE: Duration = Duration::from_secs(60);
/// Failures in a row before the room is told.
const FAILURES_SAID: i64 = 3;
/// Items a wake's trigger names, at most.
const TRIGGER_ITEMS: usize = 10;

/// Start polling (gateway startup).
pub fn start(app: &AppState) {
    let app = app.clone();
    tokio::spawn(async move {
        let sources = service(&app);
        loop {
            let wait = tick(&app);
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = sources.changed.notified() => {}
            }
        }
    });
}

/// Start the polls that are due; how long until the next one is.
fn tick(app: &AppState) -> Duration {
    let now = now_ms();
    let listed = store::list(&app.db.lock());
    let Ok(listed) = listed else {
        return IDLE;
    };
    let mut next = IDLE.as_millis() as i64;
    for source in listed {
        if source.paused_at.is_some() {
            continue;
        }
        let due = due_at(&source);
        if due <= now {
            let app = app.clone();
            tokio::spawn(async move {
                if let Err(error) = poll_now(&app, &source.id, false).await
                    && error.code != "source_busy"
                {
                    crate::log::warn(&format!("sources: {}: {}", source.id, error.message));
                }
            });
        } else {
            next = next.min(due - now);
        }
    }
    Duration::from_millis(next.max(1000) as u64)
}

/// When a source is polled next: its cadence after the last poll; a
/// failing one backs off (twice the cadence after three failures).
fn due_at(source: &Source) -> i64 {
    let Some(last) = source.last_polled_at else {
        return 0;
    };
    let cadence = super::cadence_ms(&source.kind);
    last + if source.failures >= FAILURES_SAID {
        cadence * 2
    } else {
        cadence
    }
}

/// How a poll went.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub baseline: bool,
    /// Items new or changed.
    pub changed: Vec<Item>,
    /// The wake it enqueued.
    pub wake: Option<wake::Wake>,
    pub error: Option<SourceError>,
}

/// Poll a source now (the poller, adding a source, or `POST
/// /api/sources/:id/poll`). One that is being read is waited for when
/// `wait`, else 409 `source_busy`.
pub async fn poll_now(app: &AppState, id: &str, wait: bool) -> ApiResult<Outcome> {
    let sources = service(app);
    let lock = sources.poll_lock(id);
    let _turn = if wait {
        lock.lock_owned().await
    } else {
        lock.try_lock_owned()
            .map_err(|_| ApiError::new(409, "source_busy", format!("{id} is being read now")))?
    };
    let source = store::get(&app.db.lock(), id)?;
    if source.paused_at.is_some() {
        return Err(ApiError::new(
            409,
            "source_paused",
            format!("{id} is paused"),
        ));
    }
    let secret = sources.secret(id);
    let polled = match tokio::time::timeout(POLL_TIMEOUT, super::poll(app, &source, &secret)).await
    {
        Ok(result) => result,
        Err(_) => Err(SourceError::new("reading it took too long")),
    };
    let now = now_ms();
    let polled = match polled {
        Ok(polled) => polled,
        Err(error) => {
            failed(app, &source, &error, now)?;
            return Ok(Outcome {
                baseline: false,
                changed: Vec::new(),
                wake: None,
                error: Some(error),
            });
        }
    };
    let (changed, decision) = {
        let conn = app.db.lock();
        let mut changed = store::put_items(&conn, id, &polled.items, now)?;
        changed.extend(store::mark_removed(&conn, id, &polled.removed, now)?);
        store::polled(&conn, id, &polled.cursor, now)?;
        let decision = if polled.baseline || changed.is_empty() || !wake::enabled(app) {
            None
        } else {
            filter::decide(&conn, &source, &changed)?
        };
        (changed, decision)
    };
    let wake = match decision {
        Some(decision) => woke(app, &source, decision),
        None => None,
    };
    Ok(Outcome {
        baseline: polled.baseline,
        changed,
        wake,
        error: None,
    })
}

/// Enqueue the wake a poll decided on.
fn woke(app: &AppState, source: &Source, decision: filter::Decision) -> Option<wake::Wake> {
    let first_loop = decision
        .loop_ids
        .first()
        .and_then(|id| crate::brain::loops::get(&app.db.lock(), id).ok());
    let room_id = decision.room_id.clone().unwrap_or_else(|| {
        first_loop.as_ref().map_or_else(
            || GENERAL_ROOM_ID.to_owned(),
            |open_loop| crate::brain::loops::home_room(app, open_loop),
        )
    });
    let user = first_loop.map_or_else(|| source.owner.clone(), |open_loop| open_loop.user);
    let more = decision.items.len().saturating_sub(TRIGGER_ITEMS);
    let items: Vec<Value> = decision
        .items
        .iter()
        .take(TRIGGER_ITEMS)
        .map(|item| {
            json!({
                "id": item.external_id,
                "kind": item.kind,
                "title": item.title,
                "who": item.who,
                "at": item.at,
                "summary": item.summary,
            })
        })
        .collect();
    let trigger = json!({
        "sourceId": source.id,
        "name": source.name,
        "sourceKind": source.kind,
        "reason": decision.reason,
        "loopIds": decision.loop_ids,
        "items": items,
        "more": more,
    });
    let scheduled = wake::schedule(
        app,
        &NewWake {
            kind: Kind::Source,
            trigger,
            room_id: &room_id,
            user: Some(&user),
            scheduled_at: now_ms(),
        },
    );
    match scheduled {
        Ok(wake) => Some(wake),
        Err(error) => {
            crate::log::warn(&format!(
                "sources: cannot wake for {}: {}",
                source.id, error.message
            ));
            None
        }
    }
}

/// A poll failed: counted, and said in the room at the third in a row.
fn failed(app: &AppState, source: &Source, error: &SourceError, now: i64) -> ApiResult<()> {
    let failures = store::failed(&app.db.lock(), &source.id, &error.message, now)?;
    if failures < FAILURES_SAID || source.noted_at.is_some() {
        return Ok(());
    }
    let room_id = super::following_rooms(&app.db.lock(), &source.id)?
        .into_iter()
        .next()
        .unwrap_or_else(|| GENERAL_ROOM_ID.to_owned());
    let mut text = format!(
        "I can't read {} ({}): {}.",
        source.name,
        source.id,
        error.message.trim_end_matches('.')
    );
    if error.auth {
        text.push_str(" Sign in to it again in Settings → Sources.");
    }
    wake::post_line(
        app,
        &room_id,
        &json!({ "text": text, "source": { "id": source.id, "event": "unreadable" } }),
    );
    store::noted(&app.db.lock(), &source.id, now)?;
    Ok(())
}

/// What woke the brain, in its words (`wake::describe` of a source wake).
pub fn describe(app: &crate::app::App, trigger: &Value) -> String {
    let zone = super::zone(app);
    let field = |key: &str| trigger.get(key).and_then(Value::as_str).unwrap_or_default();
    let mut text = format!(
        "A source changed: {} ({}). ",
        field("name"),
        field("sourceId")
    );
    match field("reason") {
        "followed" => text.push_str("This room follows it."),
        _ => {
            let loops: Vec<&str> = trigger
                .get("loopIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            text.push_str(&format!("It may touch open loop {}.", loops.join(", ")));
        }
    }
    let mut seen = String::new();
    for item in trigger
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let at = item.get("at").and_then(Value::as_i64);
        seen.push_str(&format!(
            "- [{}] {}{}\n",
            item.get("id").and_then(Value::as_str).unwrap_or_default(),
            item.get("summary")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            at.map(|at| format!(" ({})", super::stamp(at, zone, "%a %Y-%m-%d %H:%M")))
                .unwrap_or_default()
        ));
    }
    if let Some(more) = trigger
        .get("more")
        .and_then(Value::as_u64)
        .filter(|more| *more > 0)
    {
        seen.push_str(&format!("… and {more} more.\n"));
    }
    text.push('\n');
    text.push_str(&super::tools::fenced("What changed", seen.trim_end()));
    text.push_str(
        "\nRead more with its tools if it matters, and say something only if it is worth it.",
    );
    text
}
