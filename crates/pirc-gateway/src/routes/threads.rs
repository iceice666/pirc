//! Workers and their threads in the web app (plans/rewrite/06-workers.md):
//! the workers the brain called (`GET /api/workers`), a thread with its
//! messages and workers (`GET /api/threads/:id`), and the people in it:
//! adding to it (`POST /api/threads/:id/messages`, handed to the worker)
//! and answering a worker's question (`POST /api/threads/:id/answer`).
//! Reading is every allowed user's (rooms are the household's); adding,
//! answering and Stop (`POST /api/delegations/:id/stop`) are for whom the
//! worker works for, whose session it is. No reply is cached.

use axum::Extension;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::routing::{get, post};
use serde_json::{Value, json};

use super::Handled;
use super::rooms::{id, positive, single};
use crate::app::{AppState, ReqBody};
use crate::auth::Identity;
use crate::db::rooms::RoomStore;
use crate::delegations;
use crate::error::ApiError;
use crate::http::ok;
use crate::threads;

const DEFAULT_PAGE: usize = 50;
const MAX_PAGE: usize = 200;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workers", get(workers))
        .route("/api/threads/{id}", get(thread))
        .route("/api/threads/{id}/messages", post(add))
        .route("/api/threads/{id}/answer", post(answer))
}

/// Path parameters of the thread routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/threads/{id}"),
    ("POST", "/api/threads/{id}/messages"),
    ("POST", "/api/threads/{id}/answer"),
];

/// `?status=active` (the default: queued, running and waiting) or `all`
/// (newest first, `?limit=` up to 200); `?room=` one room's.
async fn workers(State(app): State<AppState>, uri: Uri) -> Handled {
    let active = match single(&uri, "status")?.as_deref() {
        None | Some("active") => true,
        Some("all") => false,
        Some(_) => return Err(ApiError::invalid_input().into()),
    };
    let limit = positive(&uri, "limit")?.map_or(DEFAULT_PAGE, |limit| {
        usize::try_from(limit).unwrap_or(MAX_PAGE + 1)
    });
    if limit > MAX_PAGE {
        return Err(ApiError::invalid_input().into());
    }
    let room = match single(&uri, "room")? {
        None => None,
        Some(room) => Some(app.db.lock().get_room(id(&room)?)?.id),
    };
    let conn = app.db.lock();
    let list = delegations::list(&conn, room.as_deref(), active, limit)?;
    let workers: Vec<Value> = list
        .iter()
        .map(|delegation| delegations::public(&conn, delegation))
        .collect();
    Ok(ok(json!({ "workers": workers })))
}

/// The thread, its messages after `?after=` (a seq; up to `?limit=`, 500
/// at most), and its workers, the latest first.
async fn thread(State(app): State<AppState>, Path(thread_id): Path<String>, uri: Uri) -> Handled {
    let thread_id = id(&thread_id)?.to_owned();
    let after = positive(&uri, "after")?.unwrap_or(0);
    let limit = positive(&uri, "limit")?.map_or(threads::MAX_PAGE, |limit| {
        usize::try_from(limit).unwrap_or(threads::MAX_PAGE + 1)
    });
    if limit > threads::MAX_PAGE {
        return Err(ApiError::invalid_input().into());
    }
    let conn = app.db.lock();
    let thread = threads::get(&conn, &thread_id)?;
    let messages = threads::list(&conn, &thread.id, after, limit)?;
    let workers: Vec<Value> = delegations::in_thread(&conn, &thread.id)?
        .iter()
        .map(|delegation| delegations::public(&conn, delegation))
        .collect();
    Ok(ok(
        json!({ "thread": thread, "messages": messages, "workers": workers }),
    ))
}

/// `{text}`: said in the thread and handed to its worker.
async fn add(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(thread_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let thread_id = id(&thread_id)?.to_owned();
    let Some(Value::Object(fields)) = body.json() else {
        return Err(ApiError::invalid_input().into());
    };
    if fields.keys().any(|key| key != "text") {
        return Err(ApiError::invalid_input().into());
    }
    let Some(Value::String(text)) = fields.get("text") else {
        return Err(ApiError::invalid_input().into());
    };
    let added = delegations::interject(&app, &identity.user, &thread_id, text).await?;
    Ok(ok(added))
}

/// `{interactionId, answer}`: a worker's question answered, `answer` as
/// a session's dialog takes it (`{value}`, `{confirmed}`, `{cancelled}`).
async fn answer(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(thread_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let thread_id = id(&thread_id)?.to_owned();
    let Some(Value::Object(fields)) = body.json() else {
        return Err(ApiError::invalid_input().into());
    };
    if fields
        .keys()
        .any(|key| key != "interactionId" && key != "answer")
    {
        return Err(ApiError::invalid_input().into());
    }
    let (Some(Value::String(interaction_id)), Some(given @ Value::Object(_))) =
        (fields.get("interactionId"), fields.get("answer"))
    else {
        return Err(ApiError::invalid_input().into());
    };
    if interaction_id.is_empty() || interaction_id.len() > 200 {
        return Err(ApiError::invalid_input().into());
    }
    let answered =
        delegations::answer(&app, &identity.user, &thread_id, interaction_id, given).await?;
    Ok(ok(answered))
}
