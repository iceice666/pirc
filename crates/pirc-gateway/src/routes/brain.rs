//! The brain's API (plans/rewrite/02-brain-host.md): its prompts, and what
//! the engine page shows of its turns and context. Every allowed user may
//! read and write them (the brain is the household's).

use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::routing::{get, put};
use serde::Deserialize;
use serde_json::json;

use super::Handled;
use super::rooms::{id, positive, single};
use crate::app::{AppState, ReqBody};
use crate::brain::identity::{self, PromptName};
use crate::brain::store::{MAX_TURN_PAGE, TurnStore, room_dir};
use crate::db::rooms::RoomStore;
use crate::error::{ApiError, ApiResult};
use crate::http::ok;

const DEFAULT_TURN_PAGE: usize = 20;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/brain/prompts", get(list_prompts))
        .route("/api/brain/prompts/{name}", put(write_prompt))
        .route("/api/brain/turns", get(list_turns))
        .route("/api/brain/context", get(context))
}

/// Path parameters of the brain routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[("PUT", "/api/brain/prompts/{name}")];

async fn list_prompts(State(app): State<AppState>) -> Handled {
    let dir = &app.config.config_dir;
    Ok(ok(json!({ "prompts": {
        "soul": identity::inspect(dir, PromptName::Soul),
        "chat": identity::inspect(dir, PromptName::Chat),
    } })))
}

#[derive(Deserialize)]
struct WritePrompt {
    text: String,
}

/// The next turn reads it.
async fn write_prompt(
    State(app): State<AppState>,
    Path(name): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let name = PromptName::parse(&name).ok_or_else(|| ApiError::not_found("Prompt not found"))?;
    let WritePrompt { text } = body.parse()?;
    let prompt = identity::write(&app.config.config_dir, name, &text)?;
    Ok(ok(json!({ "prompt": prompt })))
}

/// `?room=` (required): an existing room's id.
fn room_param(app: &AppState, uri: &Uri) -> ApiResult<String> {
    let room = single(uri, "room")?.ok_or_else(ApiError::invalid_input)?;
    Ok(app.db.lock().get_room(id(&room)?)?.id)
}

/// A room's latest turns, newest first (`?room=`, `?limit=` up to 100).
async fn list_turns(State(app): State<AppState>, uri: Uri) -> Handled {
    let room_id = room_param(&app, &uri)?;
    let limit = positive(&uri, "limit")?.map_or(DEFAULT_TURN_PAGE, |limit| {
        usize::try_from(limit).unwrap_or(MAX_TURN_PAGE)
    });
    let turns = app.db.lock().list_turns(&room_id, limit)?;
    Ok(ok(json!({ "turns": turns })))
}

/// What the brain's latest model call in the room was given (a session's
/// context snapshot); `null` before its first.
async fn context(State(app): State<AppState>, uri: Uri) -> Handled {
    let room_id = room_param(&app, &uri)?;
    let snapshot = pirc_agent::context::read_context(&room_dir(&app.config.state_dir, &room_id))
        .map_err(|error| {
            crate::log::warn(&format!("brain: {room_id}'s context: {error}"));
            ApiError::internal()
        })?;
    Ok(ok(json!({ "context": snapshot })))
}
