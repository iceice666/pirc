//! The assistant's memory in the web app (Settings → Memory;
//! `apps/gateway/src/daemon/memory-routes.ts`): the user reviews USER
//! entries and MEMORY notes, restores earlier versions and forgets entries. Device tokens
//! may use these routes too. Every change answers with the whole view, and
//! no reply is cached.

use std::collections::HashSet;

use axum::Router;
use axum::extract::{Extension, Path, Request, State};
use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use serde_json::{Map, Value, json};

use super::schema::{int, len16, optional, strict};
use super::store::Store;
use crate::app::{App, AppState, ReqBody};
use crate::auth::Identity;
use crate::db::Store as _;
use crate::error::{ApiError, ApiResult, json_response};
use crate::http::{Body, ok};
use crate::routes::Handled;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/memory", get(view_route))
        .route("/api/memory/entries/{id}/history", get(history))
        .route("/api/memory/entries/{id}/forget", post(forget))
        .route("/api/memory/entries/{id}/restore", post(restore))
        .route_layer(middleware::from_fn(scope))
}

/// The routes' own scope: Fastify refused a path parameter over 100
/// characters with 414 before anything else, and every reply of the scope
/// says `no-store`.
async fn scope(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    // `/api/memory/entries/<id>/...`
    if path.split('/').nth(4).is_some_and(|id| id.len() > 100) {
        return json_response(
            414,
            &json!({
                "error": "Bad Request",
                "code": "FST_ERR_MAX_PARAM_LENGTH",
                "message": format!("'{path}' is exceeding the max param length"),
                "statusCode": 414,
            }),
        );
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `z.string().min(1).max(40)`.
fn id_param(id: &str) -> ApiResult<&str> {
    if (1..=40).contains(&len16(id)) {
        Ok(id)
    } else {
        Err(ApiError::invalid_input())
    }
}

/// `request.body ?? {}`, then `{<field>: positive int, optional}.strict()`.
fn revision_body(body: &Body, field: &str) -> ApiResult<Option<i64>> {
    let empty = json!({});
    let value = match body {
        Body::None => &empty,
        Body::Json(Value::Null) => &empty,
        Body::Json(value) => value,
        // A raw body was a Buffer: an object whose keys are its indexes.
        Body::Raw { bytes, .. } if bytes.is_empty() => &empty,
        Body::Raw { .. } => return Err(ApiError::invalid_input()),
    };
    let object = strict(value, &[field]).ok_or_else(ApiError::invalid_input)?;
    optional(object, field, |value| int(value).filter(|n| *n > 0))
        .map_err(|()| ApiError::invalid_input())
}

/// Everything the page shows, with the names of the chats it refers to.
fn view(app: &App, user: &str) -> ApiResult<Value> {
    let conn = app.db.lock();
    let store = super::store(app, &conn);
    let entries = store.entries(user, None, None)?;
    let mut seen = HashSet::new();
    let mut sessions = Map::new();
    let ids = entries
        .iter()
        .filter_map(|entry| entry.source_session())
        .filter(|id| !id.is_empty());
    for session_id in ids {
        if !seen.insert(session_id.to_owned()) {
            continue;
        }
        // A chat that is gone keeps its id on the page.
        if let Ok(session) = conn.get_session(session_id)
            && session.owner_user.as_deref() == Some(user)
        {
            sessions.insert(session_id.to_owned(), json!(session.name));
        }
    }
    let pick = |wanted: &dyn Fn(&super::store::Entry) -> bool| -> Vec<Value> {
        entries
            .iter()
            .filter(|entry| wanted(entry))
            .map(|entry| serde_json::to_value(entry).unwrap_or_default())
            .collect()
    };
    Ok(json!({
        "usage": store.usage(user)?,
        "user": pick(&|entry| entry.kind == "user" && entry.status == "active"),
        "notes": pick(&|entry| entry.kind == "note" && entry.status == "active"),
        "removed": pick(&|entry| entry.status == "removed"),
        "sessions": sessions,
    }))
}

/// Run a change, tell the user's open clients, and answer with the new view.
fn change(app: &App, user: &str, apply: impl FnOnce(&Store<'_>) -> ApiResult<()>) -> Handled {
    {
        let conn = app.db.lock();
        apply(&super::store(app, &conn))?;
    }
    app.memory_changed(user);
    Ok(ok(view(app, user)?))
}

async fn view_route(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Handled {
    Ok(ok(view(&app, &identity.user)?))
}

async fn history(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let id = id_param(&id)?;
    let versions = {
        let conn = app.db.lock();
        super::store(&app, &conn).history(&identity.user, id)?
    };
    Ok(ok(json!({ "versions": versions })))
}

async fn forget(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(_): ReqBody,
) -> Handled {
    let id = id_param(&id)?;
    change(&app, &identity.user, |store| {
        store.forget(&identity.user, id)
    })
}

async fn restore(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let id = id_param(&id)?;
    let revision = revision_body(&body, "revision")?;
    change(&app, &identity.user, |store| {
        store.restore(&identity.user, id, revision).map(drop)
    })
}
