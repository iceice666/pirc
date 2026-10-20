//! Wakes in the web app (plans/rewrite/05-self-wake.md): what the brain
//! will wake up for and how its wakes went (the engine's list), and a
//! person cancelling one that has not started (the room line's Cancel).
//! Every allowed user may (the brain is the household's). No reply is
//! cached.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::routing::{delete, get};
use serde_json::json;

use super::Handled;
use super::rooms::{id, positive, single};
use crate::app::AppState;
use crate::db::rooms::RoomStore;
use crate::error::ApiError;
use crate::http::ok;
use crate::util::now_ms;
use crate::wake::{self, Kind, Status};

const DEFAULT_PAGE: usize = 50;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/wakes", get(list))
        .route("/api/wakes/{id}", delete(cancel))
}

/// Path parameters of the wake routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[("DELETE", "/api/wakes/{id}")];

/// `?status=pending` (the default: pending and running, the next first),
/// `ended` (the latest first, `?limit=` up to 200) or `all` (both);
/// `?room=` one room's. With the day's count and quota.
async fn list(State(app): State<AppState>, uri: Uri) -> Handled {
    let status = single(&uri, "status")?.unwrap_or_else(|| "pending".to_owned());
    let limit = positive(&uri, "limit")?.map_or(DEFAULT_PAGE, |limit| {
        usize::try_from(limit).unwrap_or(wake::MAX_PAGE)
    });
    if limit > wake::MAX_PAGE {
        return Err(ApiError::invalid_input().into());
    }
    let room = match single(&uri, "room")? {
        None => None,
        Some(room) => Some(app.db.lock().get_room(id(&room)?)?.id),
    };
    let conn = app.db.lock();
    let room = room.as_deref();
    let list = match status.as_str() {
        "pending" => wake::list(&conn, room, Status::Pending, wake::MAX_PAGE)?,
        "ended" => wake::list(&conn, room, Status::Ended, limit)?,
        "all" => {
            let mut list = wake::list(&conn, room, Status::Pending, wake::MAX_PAGE)?;
            list.extend(wake::list(&conn, room, Status::Ended, limit)?);
            list
        }
        _ => return Err(ApiError::invalid_input().into()),
    };
    let zone = wake::quota::zone(&app.config.timezone);
    let used = wake::quota::used(&conn, now_ms(), zone)?;
    Ok(ok(json!({
        "wakes": list,
        "today": { "used": used, "limit": app.config.wakes_per_day },
    })))
}

/// Cancel a wake that has not started (said in its room when the brain
/// had said it would come back); one that ended is returned as it is,
/// one that is running is 409.
async fn cancel(State(app): State<AppState>, Path(wake_id): Path<String>) -> Handled {
    if wake_id.is_empty() || wake_id.len() > 60 {
        return Err(ApiError::invalid_input().into());
    }
    let (found, unchanged) = wake::cancel(&app.db.lock(), &wake_id, now_ms())?;
    if !unchanged {
        wake::changed(&app, &found);
        if found.kind == Kind::SelfScheduled.as_str() {
            wake::say(&app, &found, true);
        }
        // An anchor wake cancelled: its loop closes if its time was the
        // thing itself.
        wake::settle(&app, &found);
    }
    Ok(ok(json!({ "wake": found })))
}
