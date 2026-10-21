//! Faces in the web app (plans/rewrite/10-faces.md): the member list and
//! each face's page. Every allowed user may change a face (the brain is
//! the household's); a change applies from the next turn and is sent as
//! `face_changed`. No reply is cached.
//!
//! - `GET /api/faces` (`?hidden=1` with the hidden ones): `{faces,
//!   presence}`, the host first and the archived ones last.
//! - `POST /api/faces`: `{name, bio?, tone?, avatar?, color?, roleMd?,
//!   territory?: {rooms, workspaces, sources}}`.
//! - `PATCH /api/faces/:id`: the same fields, plus `archived` and `hidden`
//!   (only an archived face can be hidden; the host is never archived and
//!   its territory is fixed).
//! - `GET /api/faces/:id/activity`: its open loops, its latest workers and
//!   wakes.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::routing::get;
use serde::Deserialize;
use serde_json::{Value, json};

use super::rooms::{id, single};
use super::{Handled, created};
use crate::app::{AppState, ReqBody};
use crate::brain::faces::{self, FacePatch, NewFace, Territory};
use crate::brain::loops;
use crate::error::ApiError;
use crate::http::ok;

/// Workers and wakes on a face's page.
const ACTIVITY: usize = 20;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/faces", get(list).post(create))
        .route("/api/faces/{id}", get(get_face).patch(update))
        .route("/api/faces/{id}/activity", get(activity))
}

/// Path parameters of the face routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/faces/{id}"),
    ("PATCH", "/api/faces/{id}"),
    ("GET", "/api/faces/{id}/activity"),
];

async fn list(State(app): State<AppState>, uri: Uri) -> Handled {
    let hidden = match single(&uri, "hidden")?.as_deref() {
        None | Some("0") => false,
        Some("1") => true,
        Some(_) => return Err(ApiError::invalid_input().into()),
    };
    let list = faces::list(&app.db.lock(), hidden)?;
    Ok(ok(
        json!({ "faces": list, "presence": faces::presences(&app) }),
    ))
}

async fn get_face(State(app): State<AppState>, Path(face_id): Path<String>) -> Handled {
    let face = faces::get(&app.db.lock(), id(&face_id)?)?;
    let mut presence = faces::state(&app, &face.id);
    presence["faceId"] = json!(face.id);
    Ok(ok(json!({ "face": face, "presence": presence })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateFace {
    name: String,
    #[serde(default)]
    bio: String,
    #[serde(default)]
    tone: String,
    avatar: Option<String>,
    color: Option<String>,
    #[serde(default)]
    role_md: String,
    #[serde(default)]
    territory: Territory,
}

async fn create(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    let new: CreateFace = body.parse()?;
    let face = faces::create(
        &app.db.lock(),
        &NewFace {
            name: new.name,
            bio: new.bio,
            tone: new.tone,
            avatar: new.avatar,
            color: new.color,
            role_md: new.role_md,
            territory: new.territory,
        },
    )?;
    faces::changed(&app, &face);
    Ok(created(json!({ "face": face })))
}

/// `Some(value)` for a present key, `null` included.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateFace {
    name: Option<String>,
    bio: Option<String>,
    tone: Option<String>,
    /// Absent: unchanged; `null`: cleared.
    #[serde(default, deserialize_with = "present")]
    avatar: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    color: Option<Value>,
    role_md: Option<String>,
    territory: Option<Territory>,
    archived: Option<bool>,
    hidden: Option<bool>,
}

/// A nullable string field: `Some(None)` clears it.
fn nullable(value: Option<Value>) -> Result<Option<Option<String>>, ApiError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(text)) => Ok(Some(Some(text))),
        Some(_) => Err(ApiError::invalid_input()),
    }
}

async fn update(
    State(app): State<AppState>,
    Path(face_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let update: UpdateFace = body.parse()?;
    let patch = FacePatch {
        name: update.name,
        bio: update.bio,
        tone: update.tone,
        avatar: nullable(update.avatar)?,
        color: nullable(update.color)?,
        role_md: update.role_md,
        territory: update.territory,
        archived: update.archived,
        hidden: update.hidden,
    };
    let untouched = patch.name.is_none()
        && patch.bio.is_none()
        && patch.tone.is_none()
        && patch.avatar.is_none()
        && patch.color.is_none()
        && patch.role_md.is_none()
        && patch.territory.is_none()
        && patch.archived.is_none()
        && patch.hidden.is_none();
    if untouched {
        return Err(ApiError::invalid_input().into());
    }
    let face = faces::update(&app.db.lock(), id(&face_id)?, &patch)?;
    faces::changed(&app, &face);
    Ok(ok(json!({ "face": face })))
}

async fn activity(State(app): State<AppState>, Path(face_id): Path<String>) -> Handled {
    let conn = app.db.lock();
    let face = faces::get(&conn, id(&face_id)?)?;
    let mine = |other: Option<&str>| other.unwrap_or(crate::db::rooms::HOST_FACE_ID) == face.id;
    let open: Vec<loops::OpenLoop> = loops::list_open(&conn)?
        .into_iter()
        .filter(|open_loop| mine(open_loop.face_id.as_deref()))
        .collect();
    let workers: Vec<Value> = crate::delegations::list(&conn, None, false, 500)?
        .into_iter()
        .filter(|delegation| delegation.face() == face.id)
        .take(ACTIVITY)
        .map(|delegation| crate::delegations::public(&conn, &delegation))
        .collect();
    let wakes = crate::wake::of_face(&conn, &face.id, ACTIVITY)?;
    Ok(ok(
        json!({ "loops": open, "workers": workers, "wakes": wakes }),
    ))
}
