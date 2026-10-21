//! User-owned personal events and a side-effect-free projection of agent runs.
pub mod agent;
mod api;
pub mod recurrence;
pub mod reminders;
#[cfg(test)]
mod tests;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::atomic;
use crate::error::{ApiError, ApiResult};
use crate::schedules::Zone;
use crate::util::uuid;
pub use api::routes;
pub use recurrence::Rule;

pub const PAGE_SIZE: usize = 256;
pub const DAY_MS: i64 = 86_400_000;

/// A local preference/cache namespace, never an authorization credential.
pub fn account_key(user: &str) -> String {
    crate::util::sha256_hex(format!("pirc-calendar:{user}"))[..32].to_owned()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    pub start: String,
    pub end: String,
    pub timezone: String,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub recurrence: Option<Rule>,
    #[serde(default)]
    pub reminder_minutes: Vec<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub revision: i64,
    #[serde(flatten)]
    pub spec: Spec,
    #[serde(skip)]
    pub end_before: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row(row: &Row<'_>) -> rusqlite::Result<Event> {
    let text: String = row.get("spec_json")?;
    let spec = serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Event {
        id: row.get("id")?,
        revision: row.get("revision")?,
        spec,
        end_before: row.get("end_before")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn validate_spec(spec: &Spec) -> ApiResult<()> {
    recurrence::validate(spec)
}

pub fn get(conn: &Connection, user: &str, id: &str) -> ApiResult<Event> {
    conn.query_row(
        "SELECT * FROM calendar_events WHERE owner_user=? AND id=? AND deleted=0",
        params![user, id],
        row,
    )
    .optional()?
    .ok_or_else(|| ApiError::not_found("Event not found"))
}

pub fn list(conn: &Connection, user: &str) -> ApiResult<Vec<Event>> {
    Ok(conn
        .prepare("SELECT * FROM calendar_events WHERE owner_user=? AND deleted=0 ORDER BY id")?
        .query_map([user], row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn create(conn: &Connection, user: &str, key: &str, spec: &Spec, now: i64) -> ApiResult<Event> {
    validate_spec(spec)?;
    if !(1..=100).contains(&key.len()) {
        return Err(ApiError::invalid_input());
    }
    atomic(conn, |conn| {
        let encoded = serde_json::to_string(spec).map_err(|_| ApiError::internal())?;
        let hash = crate::util::sha256_hex(&encoded);
        let prior: Option<(String,String,bool)> = conn.query_row(
            "SELECT id,creation_hash,deleted FROM calendar_events WHERE owner_user=? AND creation_key=?",
            params![user,key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id, original, deleted)) = prior {
            if deleted {
                return Err(ApiError::new(
                    409,
                    "event_deleted",
                    "The event from this request has already been deleted",
                ));
            }
            if original != hash {
                return Err(ApiError::new(
                    409,
                    "idempotency_conflict",
                    "This creation key was already used with different event data",
                ));
            }
            return get(conn, user, &id).map_err(|_| {
                ApiError::new(
                    409,
                    "event_deleted",
                    "The event from this request has already been deleted",
                )
            });
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM calendar_events WHERE owner_user=? AND deleted=0",
            [user],
            |r| r.get(0),
        )?;
        if count >= 1000 {
            return Err(ApiError::new(
                409,
                "calendar_limit",
                "The calendar supports up to 1000 event series",
            ));
        }
        let id = uuid();
        conn.execute("INSERT INTO calendar_events (id,owner_user,creation_key,creation_hash,spec_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
            params![id,user,key,hash,encoded,now,now])?;
        get(conn, user, &id)
    })
}

fn check_revision(event: &Event, revision: i64) -> ApiResult<()> {
    if event.revision == revision {
        Ok(())
    } else {
        Err(ApiError::new(
            409,
            "calendar_conflict",
            "This event changed on another device. Review the latest version before saving.",
        )
        .with_details(json!({"event":event})))
    }
}

/// Validate a proposed mutation without changing data. Confirmation callers
/// validate again when applying: a valid proposal is not a write reservation.
pub fn validate_target(
    conn: &Connection,
    user: &str,
    id: &str,
    revision: i64,
    scope: &str,
    original: Option<&str>,
) -> ApiResult<Event> {
    let event = get(conn, user, id)?;
    check_revision(&event, revision)?;
    match scope {
        "series" if original.is_none() => {}
        "occurrence" | "following" => {
            occurrence(&event, original)?;
        }
        _ => return Err(ApiError::invalid_input()),
    }
    Ok(event)
}

fn occurrence(event: &Event, value: Option<&str>) -> ApiResult<(String, chrono::NaiveDateTime)> {
    let value = value.ok_or_else(ApiError::invalid_input)?;
    let local = recurrence::local(value, event.spec.all_day)?;
    if !recurrence::includes(&event.spec, local)?
        || event
            .end_before
            .as_ref()
            .is_some_and(|end| value >= end.as_str())
    {
        return Err(recurrence::invalid(
            "This occurrence does not belong to the event series",
        ));
    }
    Ok((value.into(), local))
}

fn exception(conn: &Connection, id: &str, key: &str, spec: Option<&Spec>) -> ApiResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM calendar_exceptions WHERE event_id=? AND original_start=?)",
        params![id, key],
        |r| r.get(0),
    )?;
    if !exists {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM calendar_exceptions WHERE event_id=?",
            [id],
            |r| r.get(0),
        )?;
        if count >= 1000 {
            return Err(ApiError::new(
                409,
                "calendar_limit",
                "Too many exceptions in this series",
            ));
        }
    }
    let spec = spec
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| ApiError::internal())?;
    conn.execute("INSERT INTO calendar_exceptions (event_id,original_start,spec_json,cancelled) VALUES (?,?,?,?) ON CONFLICT(event_id,original_start) DO UPDATE SET spec_json=excluded.spec_json,cancelled=excluded.cancelled",params![id,key,spec,spec.is_none()])?;
    Ok(())
}

fn rank(event: &Event, local: chrono::NaiveDateTime) -> ApiResult<u32> {
    Ok(match &event.spec.recurrence {
        Some(rule) => recurrence::ordinal(
            recurrence::local(&event.spec.start, event.spec.all_day)?.date(),
            local.date(),
            rule,
        )
        .unwrap_or(0),
        None => 0,
    })
}

fn truncate(
    conn: &Connection,
    event: &Event,
    key: &str,
    local: chrono::NaiveDateTime,
    now: i64,
) -> ApiResult<()> {
    let count = rank(event, local)?;
    if count == 0 {
        return erase(conn, &event.id, now);
    }
    let mut spec = event.spec.clone();
    if let Some(rule) = &mut spec.recurrence {
        rule.count = Some(count.max(1));
    }
    conn.execute("UPDATE calendar_events SET end_before=?,spec_json=?,deleted=?,revision=revision+1,updated_at=? WHERE id=?",
        params![key,serde_json::to_string(&spec).map_err(|_|ApiError::internal())?,count==0,now,event.id])?;
    Ok(())
}

fn erase(conn: &Connection, id: &str, now: i64) -> ApiResult<()> {
    // Keep only the request identity/hash so a delayed create cannot resurrect
    // a deleted event. The event body and overrides no longer need retention.
    conn.execute("UPDATE calendar_events SET deleted=1,spec_json='{}',creation_hash='',end_before=NULL,revision=revision+1,updated_at=? WHERE id=?",params![now,id])?;
    conn.execute("DELETE FROM calendar_exceptions WHERE event_id=?", [id])?;
    conn.execute(
        "DELETE FROM calendar_reminder_deliveries WHERE event_id=?",
        [id],
    )?;
    Ok(())
}

pub struct Mutation<'a> {
    pub revision: i64,
    pub scope: &'a str,
    pub occurrence: Option<&'a str>,
}

fn time_changed(before: &Spec, after: &Spec) -> bool {
    before.start != after.start
        || before.end != after.end
        || before.timezone != after.timezone
        || before.all_day != after.all_day
}

fn effective_spec(conn: &Connection, event: &Event, key: &str) -> ApiResult<Option<Spec>> {
    let overridden:Option<(Option<String>,bool)>=conn.query_row("SELECT spec_json,cancelled FROM calendar_exceptions WHERE event_id=? AND original_start=?",params![event.id,key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((encoded, cancelled)) = overridden {
        return if cancelled {
            Ok(None)
        } else {
            Ok(Some(
                serde_json::from_str(&encoded.unwrap_or_default())
                    .map_err(|_| ApiError::internal())?,
            ))
        };
    }
    let seed = recurrence::local(&event.spec.start, event.spec.all_day)?;
    let start = recurrence::local(key, event.spec.all_day)?;
    let end = start + (recurrence::local(&event.spec.end, event.spec.all_day)? - seed);
    let mut spec = event.spec.clone();
    spec.start = key.into();
    spec.end = recurrence::key(end, spec.all_day);
    Ok(Some(spec))
}

pub fn update(
    conn: &Connection,
    user: &str,
    id: &str,
    spec: &Spec,
    mutation: Mutation<'_>,
    now: i64,
) -> ApiResult<Event> {
    let Mutation {
        revision,
        scope,
        occurrence: original,
    } = mutation;
    validate_spec(spec)?;
    atomic(conn, |conn| {
        let current = get(conn, user, id)?;
        check_revision(&current, revision)?;
        match scope {
            "series" => {
                let changed_rule = current.spec.start != spec.start
                    || current.spec.timezone != spec.timezone
                    || current.spec.all_day != spec.all_day
                    || current.spec.recurrence != spec.recurrence;
                conn.execute("UPDATE calendar_events SET spec_json=?,revision=revision+1,updated_at=? WHERE id=?",params![serde_json::to_string(spec).map_err(|_|ApiError::internal())?,now,id])?;
                if changed_rule {
                    conn.execute("DELETE FROM calendar_exceptions WHERE event_id=?", [id])?;
                }
                if time_changed(&current.spec, spec) || current.spec.recurrence != spec.recurrence {
                    conn.execute(
                        "DELETE FROM calendar_reminder_deliveries WHERE event_id=?",
                        [id],
                    )?;
                }
                get(conn, user, id)
            }
            "occurrence" => {
                let (key, _) = occurrence(&current, original)?;
                let mut changed = spec.clone();
                changed.recurrence = None;
                if effective_spec(conn, &current, &key)?
                    .is_none_or(|before| time_changed(&before, &changed))
                {
                    conn.execute("DELETE FROM calendar_reminder_deliveries WHERE event_id=? AND occurrence_key=?",params![id,key])?;
                }
                exception(conn, id, &key, Some(&changed))?;
                conn.execute(
                    "UPDATE calendar_events SET revision=revision+1,updated_at=? WHERE id=?",
                    params![now, id],
                )?;
                get(conn, user, id)
            }
            "following" => {
                let (key, local) = occurrence(&current, original)?;
                if rank(&current, local)? == 0 {
                    return update(
                        conn,
                        user,
                        id,
                        spec,
                        crate::calendar::Mutation {
                            revision,
                            scope: "series",
                            occurrence: None,
                        },
                        now,
                    );
                }
                let mut changed = spec.clone();
                // An unchanged count means the remaining occurrences, not a fresh full count.
                if let (Some(old), Some(new)) = (&current.spec.recurrence, &mut changed.recurrence)
                    && old.count == new.count
                    && let Some(count) = old.count
                {
                    let rank = recurrence::ordinal(
                        recurrence::local(&current.spec.start, current.spec.all_day)?.date(),
                        local.date(),
                        old,
                    )
                    .unwrap_or(0);
                    new.count = Some(count.saturating_sub(rank));
                }
                let next = create(conn, user, &uuid(), &changed, now)?;
                // Carry surviving single-occurrence edits/cancellations into
                // the new series, anchored relative to the split occurrence.
                let shift = recurrence::local(&changed.start, changed.all_day)? - local;
                let mut stmt=conn.prepare("SELECT original_start FROM calendar_exceptions WHERE event_id=? AND original_start>=?")?;
                let keys = stmt
                    .query_map(params![id, key], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for old in keys {
                    let candidate = recurrence::local(&old, current.spec.all_day)? + shift;
                    if recurrence::includes(&changed, candidate)? {
                        conn.execute("UPDATE calendar_exceptions SET event_id=?,original_start=? WHERE event_id=? AND original_start=?",params![next.id,recurrence::key(candidate,changed.all_day),id,old])?;
                    }
                }
                truncate(conn, &current, &key, local, now)?;
                conn.execute(
                    "DELETE FROM calendar_exceptions WHERE event_id=? AND original_start>=?",
                    params![id, key],
                )?;
                Ok(next)
            }
            _ => Err(ApiError::invalid_input()),
        }
    })
}

pub fn remove(
    conn: &Connection,
    user: &str,
    id: &str,
    revision: i64,
    scope: &str,
    original: Option<&str>,
    now: i64,
) -> ApiResult<()> {
    atomic(conn, |conn| {
        let current = get(conn, user, id)?;
        check_revision(&current, revision)?;
        match scope {
            "series" => {
                erase(conn, id, now)?;
            }
            "occurrence" => {
                let (key, _) = occurrence(&current, original)?;
                exception(conn, id, &key, None)?;
                conn.execute(
                    "UPDATE calendar_events SET revision=revision+1,updated_at=? WHERE id=?",
                    params![now, id],
                )?;
            }
            "following" => {
                let (key, local) = occurrence(&current, original)?;
                truncate(conn, &current, &key, local, now)?;
                conn.execute(
                    "DELETE FROM calendar_exceptions WHERE event_id=? AND original_start>=?",
                    params![id, key],
                )?;
            }
            _ => return Err(ApiError::invalid_input()),
        }
        Ok(())
    })
}

pub fn event_occurrences(
    conn: &Connection,
    event: &Event,
    from: i64,
    to: i64,
) -> ApiResult<Vec<(recurrence::Occurrence, Spec)>> {
    let mut overrides = std::collections::HashMap::<String, Option<Spec>>::new();
    let mut stmt = conn.prepare(
        "SELECT original_start,spec_json,cancelled FROM calendar_exceptions WHERE event_id=?",
    )?;
    for item in stmt.query_map([&event.id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, bool>(2)?,
        ))
    })? {
        let (key, spec, cancelled) = item?;
        let spec = if cancelled {
            None
        } else {
            Some(
                serde_json::from_str::<Spec>(&spec.unwrap_or_default())
                    .map_err(|_| ApiError::internal())?,
            )
        };
        overrides.insert(key, spec);
    }
    let mut result = Vec::new();
    for item in recurrence::occurrences(event, from, to)? {
        if !overrides.contains_key(&item.original_start) {
            result.push((item, event.spec.clone()));
        }
    }
    // A moved occurrence may now overlap the range even when its original date didn't.
    for (key, spec) in overrides {
        if let Some(spec) = spec {
            if event.end_before.as_ref().is_some_and(|end| key >= *end) {
                continue;
            }
            if !recurrence::includes(&event.spec, recurrence::local(&key, event.spec.all_day)?)? {
                continue;
            }
            let item = recurrence::make(&spec, recurrence::local(&spec.start, spec.all_day)?, key)?;
            if item.start_at < to && item.end_at > from {
                result.push((item, spec));
            }
        }
    }
    Ok(result)
}

type Position = (i64, String);
fn position(value: &Value) -> Position {
    (
        value["startAt"].as_i64().unwrap_or(0),
        value["id"].as_str().unwrap_or_default().into(),
    )
}
fn push(items: &mut Vec<Value>, item: Value, after: &Option<Position>) {
    let key = position(&item);
    if after.as_ref().is_some_and(|after| key <= *after) {
        return;
    }
    let at = items.partition_point(|old| position(old) < key);
    if at <= PAGE_SIZE {
        items.insert(at, item);
        items.truncate(PAGE_SIZE + 1);
    }
}

pub fn query(
    conn: &Connection,
    user: &str,
    from: i64,
    to: i64,
    timezone: &str,
    cursor: Option<&str>,
    now: i64,
) -> ApiResult<Value> {
    let zone =
        Zone::parse(timezone).ok_or_else(|| recurrence::invalid("Unknown display time zone"))?;
    if to <= from
        || to.saturating_sub(from) > 93 * DAY_MS
        || from < -2_208_988_800_000
        || to > 7_289_654_400_000
    {
        return Err(recurrence::invalid(
            "Request a date range of at most 93 days between 1900 and 2200",
        ));
    }
    let after: Option<Position> = if let Some(cursor) = cursor {
        if cursor.len() > 1000 {
            return Err(ApiError::invalid_input());
        }
        let decoded = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| ApiError::invalid_input())?;
        let (f, t, z, at, id): (i64, i64, String, i64, String) =
            serde_json::from_slice(&decoded).map_err(|_| ApiError::invalid_input())?;
        if f != from
            || t != to
            || z != timezone
            || at < from - 368 * DAY_MS
            || at > to + 2 * DAY_MS
            || id.len() > 500
        {
            return Err(ApiError::invalid_input());
        }
        Some((at, id))
    } else {
        None
    };
    let mut items = Vec::new();
    let display_start = recurrence::wall(from, zone)?.date().to_string();
    let display_end = recurrence::wall(to - 1, zone)?
        .date()
        .succ_opt()
        .ok_or_else(ApiError::invalid_input)?
        .to_string();
    for event in list(conn, user)? {
        // All-day dates float on the display calendar. Expand a small zone
        // margin, then compare dates; midnight in the event's own zone must
        // not hide an all-day event in a far-away display zone.
        for (item, spec) in event_occurrences(conn, &event, from - 2 * DAY_MS, to + 2 * DAY_MS)? {
            if spec.all_day {
                if item.start_date >= display_end || item.end_date <= display_start {
                    continue;
                }
            } else if item.start_at >= to || item.end_at <= from {
                continue;
            }
            let mut effective = event.clone();
            effective.spec = spec;
            push(
                &mut items,
                json!({"id":format!("event:{}:{}",event.id,item.original_start),"type":"event","sourceId":event.id,"title":effective.spec.title,"startAt":item.start_at,"endAt":item.end_at,"allDay":effective.spec.all_day,"startDate":item.start_date,"endDate":item.end_date,"timezone":effective.spec.timezone,"revision":event.revision,"originalStart":item.original_start,"event":effective}),
                &after,
            );
        }
    }
    crate::schedules::calendar_projection(conn, user, from, to, now, after.as_ref(), |item| {
        push(&mut items, item, &after)
    })?;
    let limited = items.len() > PAGE_SIZE;
    items.truncate(PAGE_SIZE);
    let next = if limited {
        items.last().map(|item| {
            let (at, id) = position(item);
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&(from, to, timezone, at, id)).unwrap())
        })
    } else {
        None
    };
    Ok(
        json!({"items":items,"from":from,"to":to,"timezone":timezone,"limited":limited,"nextCursor":next,"historyLimited":true,"accountKey":account_key(user),"dayStart":recurrence::wall(from,zone)?.date().to_string()}),
    )
}
