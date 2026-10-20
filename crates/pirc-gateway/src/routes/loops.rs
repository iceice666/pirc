//! Open loops in the web app (plans/rewrite/04-open-loops.md): the list,
//! and the person's own hand on one ("not needed", "not done yet", a new
//! time). Every allowed user may (the brain is the household's); each
//! change is said in the loop's room and sent as `loop_changed`. No reply
//! is cached.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::routing::{get, patch};
use serde_json::{Value, json};

use super::Handled;
use super::rooms::{positive, single};
use crate::app::{AppState, ReqBody};
use crate::brain::loops::{self, AnchorInput, Changes, Event};
use crate::error::{ApiError, ApiResult};
use crate::http::ok;
use crate::util::now_ms;

const DEFAULT_PAGE: usize = 50;
/// Why a loop the person closes is closed.
const NOT_NEEDED: &str = "not needed any more";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/loops", get(list))
        .route("/api/loops/{id}", patch(change))
}

/// Path parameters of the loop routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[("PATCH", "/api/loops/{id}")];

/// `?status=open` (the default: all of them, as the prompt orders them),
/// `closed` (newest first, `?limit=` up to 200) or `all` (both).
async fn list(State(app): State<AppState>, uri: Uri) -> Handled {
    let status = single(&uri, "status")?.unwrap_or_else(|| "open".to_owned());
    let limit = positive(&uri, "limit")?.map_or(DEFAULT_PAGE, |limit| {
        usize::try_from(limit).unwrap_or(loops::MAX_PAGE)
    });
    if limit > loops::MAX_PAGE {
        return Err(ApiError::invalid_input().into());
    }
    let conn = app.db.lock();
    let list = match status.as_str() {
        "open" => loops::list_open(&conn)?,
        "closed" => loops::list_closed(&conn, limit)?,
        "all" => {
            let mut list = loops::list_open(&conn)?;
            list.extend(loops::list_closed(&conn, limit)?);
            list
        }
        _ => return Err(ApiError::invalid_input().into()),
    };
    Ok(ok(json!({ "loops": list, "limit": loops::OPEN_LIMIT })))
}

/// `{status: "closed", reason?}`, `{status: "open"}` or `{anchor: {...} | null}`.
async fn change(
    State(app): State<AppState>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    if id.is_empty() || id.len() > 40 {
        return Err(ApiError::invalid_input().into());
    }
    let Some(Value::Object(fields)) = body.json() else {
        return Err(ApiError::invalid_input().into());
    };
    if fields
        .keys()
        .any(|key| !["status", "reason", "anchor"].contains(&key.as_str()))
    {
        return Err(ApiError::invalid_input().into());
    }
    let status = match fields.get("status") {
        None => None,
        Some(Value::String(status)) if status == "open" || status == "closed" => {
            Some(status.as_str())
        }
        Some(_) => return Err(ApiError::invalid_input().into()),
    };
    let reason = match fields.get("reason") {
        None => None,
        Some(Value::String(reason)) if status == Some("closed") => Some(reason.as_str()),
        Some(_) => return Err(ApiError::invalid_input().into()),
    };
    let now = now_ms();
    let anchor = match fields.get("anchor") {
        None => None,
        Some(_) if status.is_some() => return Err(ApiError::invalid_input().into()),
        Some(Value::Null) => Some(None),
        Some(value) => Some(Some(anchor(&app, value, now)?)),
    };
    let open_loop = match (status, anchor) {
        (Some("closed"), _) => {
            let closed = loops::close(&app.db.lock(), &id, reason.unwrap_or(NOT_NEEDED), now);
            let (open_loop, unchanged) = closed?;
            if !unchanged {
                let room = loops::home_room(&app, &open_loop);
                loops::say(&app, &room, &open_loop, Event::Closed);
            }
            open_loop
        }
        (Some(_), _) => {
            let reopened = loops::reopen(&app.db.lock(), &id, now);
            let (open_loop, unchanged) = reopened?;
            if !unchanged {
                let room = loops::home_room(&app, &open_loop);
                loops::say(&app, &room, &open_loop, Event::Reopened);
                app.memory_changed(&open_loop.user);
            }
            open_loop
        }
        (None, Some(anchor)) => {
            let changes = Changes {
                anchor: Some(anchor),
                ..Default::default()
            };
            let updated = loops::update(&app.db.lock(), &id, &changes, now);
            let open_loop = updated?;
            loops::changed(&app, &open_loop);
            open_loop
        }
        (None, None) => return Err(ApiError::invalid_input().into()),
    };
    Ok(ok(json!({ "loop": open_loop })))
}

fn anchor(app: &AppState, value: &Value, now: i64) -> ApiResult<loops::Anchor> {
    let input: AnchorInput =
        serde_json::from_value(value.clone()).map_err(|_| ApiError::invalid_input())?;
    input
        .resolve(&app.config.timezone, now)
        .map_err(|message| ApiError::new(400, "invalid_input", message))
}
