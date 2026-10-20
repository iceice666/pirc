//! The brain's memory in the web app (plans/rewrite/03-memory.md): the
//! person reviews their preferences (removes, restores earlier versions,
//! forgets), browses and searches the facts, and forgets a fact ("don't
//! keep this" on a room's line). Device tokens may use these routes too.
//! Preference changes answer with the whole view; no reply is cached.

use axum::Router;
use axum::extract::{Extension, Path, Query, Request, State};
use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use serde_json::{Map, Value, json};

use super::schema::{int, len16, optional, strict};
use super::store::Store;
use crate::app::{App, AppState, ReqBody};
use crate::auth::Identity;
use crate::db::rooms::RoomStore as _;
use crate::error::{ApiError, ApiResult, json_response};
use crate::http::{Body, ok};
use crate::memory_records::{self, Scopes, person};
use crate::routes::Handled;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/memory", get(view_route))
        .route("/api/memory/preferences", get(view_route))
        .route("/api/memory/preferences/{id}/history", get(history))
        .route("/api/memory/preferences/{id}/remove", post(remove))
        .route("/api/memory/preferences/{id}/forget", post(forget))
        .route("/api/memory/preferences/{id}/restore", post(restore))
        .route("/api/memory/records", get(records))
        .route(
            "/api/memory/records/{id}",
            get(record).delete(forget_record),
        )
        .route("/api/memory/records/{id}/history", get(record_history))
        .route_layer(middleware::from_fn(scope))
}

/// The routes' own scope: Fastify refused a path parameter over 100
/// characters with 414 before anything else, and every reply of the scope
/// says `no-store`.
async fn scope(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    // `/api/memory/preferences/<id>/...`, `/api/memory/records/<id>`
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

/// The preferences page: active and removed preferences, the budget, and
/// the names of the rooms they were said in.
fn view(app: &App, user: &str) -> ApiResult<Value> {
    let conn = app.db.lock();
    let store = super::store(app, &conn);
    let preferences = store.list(user, None)?;
    let mut rooms = Map::new();
    for room_id in preferences
        .iter()
        .filter_map(|preference| preference.created_in_room.as_deref())
    {
        if !rooms.contains_key(room_id)
            && let Ok(room) = conn.get_room(room_id)
        {
            rooms.insert(room_id.to_owned(), json!(room.name));
        }
    }
    let pick = |status: &str| -> Vec<Value> {
        preferences
            .iter()
            .filter(|preference| preference.status == status)
            .map(|preference| serde_json::to_value(preference).unwrap_or_default())
            .collect()
    };
    Ok(json!({
        "usage": store.usage(user)?,
        "preferences": pick("active"),
        "removed": pick("removed"),
        "rooms": rooms,
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

async fn remove(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(_): ReqBody,
) -> Handled {
    let id = id_param(&id)?;
    let actor = format!("user:{}", identity.user);
    change(&app, &identity.user, |store| {
        store.remove(&identity.user, id, &actor).map(drop)
    })
}

async fn forget(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(_): ReqBody,
) -> Handled {
    let id = id_param(&id)?;
    super::lines::forget_preference(&app, &identity.user, id)?;
    Ok(ok(view(&app, &identity.user)?))
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

/// `?scope=person|repo|all` (default `person`), `q` to search (else the
/// newest first), `limit` (1 to 100, default 50).
#[derive(serde::Deserialize)]
struct RecordsQuery {
    scope: Option<String>,
    q: Option<String>,
    limit: Option<String>,
}

async fn records(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Query(query): Query<RecordsQuery>,
) -> Handled {
    let scopes = match query.scope.as_deref() {
        None => Scopes::Person,
        Some(name) => Scopes::parse(name).ok_or_else(ApiError::invalid_input)?,
    };
    let limit = match query.limit.as_deref() {
        None => 50,
        Some(limit) => limit
            .parse::<usize>()
            .ok()
            .filter(|limit| (1..=100).contains(limit))
            .ok_or_else(ApiError::invalid_input)?,
    };
    let users = [identity.user.clone()];
    let hits = match query.q.as_deref().map(str::trim) {
        Some(q) if !q.is_empty() => {
            if len16(q) > 500 {
                return Err(ApiError::invalid_input().into());
            }
            memory_records::search_facts(&app, &users, q, limit.min(20), scopes)?
        }
        _ => memory_records::recent(&app, &identity.user, scopes, limit)?,
    };
    Ok(ok(json!({ "records": hits })))
}

/// A household fact and its logged changes.
async fn record(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let id = id_param(&id)?;
    let conn = app.db.lock();
    let fact = person::get(&conn, &identity.user, id)?;
    Ok(ok(json!({ "record": fact })))
}

async fn record_history(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let id = id_param(&id)?;
    let versions = person::history(&app.db.lock(), &identity.user, id)?;
    Ok(ok(json!({ "versions": versions })))
}

/// Forget a household fact ("don't keep this"). A repository's notes are
/// forgotten in their node's workspace ledger, which the gateway mirrors.
async fn forget_record(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let id = id_param(&id)?;
    let actor = format!("user:{}", identity.user);
    let fact = super::lines::forget_fact(&app, &identity.user, id, &actor)?;
    Ok(ok(json!({ "record": fact })))
}
