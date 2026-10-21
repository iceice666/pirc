use axum::{
    Router,
    extract::{Extension, Path, Query, State},
    routing::get,
};
use serde::Deserialize;
use serde_json::json;

use super::{Spec, create, get as event, query, remove, update};
use crate::{
    app::{AppState, ReqBody},
    auth::Identity,
    error::{ApiError, json_response},
    http::{no_content, ok},
    routes::Handled,
    util::now_ms,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/calendar", get(range))
        .route("/api/calendar/context", get(context))
        .route("/api/calendar/events", axum::routing::post(add))
        .route(
            "/api/calendar/events/{id}",
            get(show).patch(edit).delete(delete),
        )
        .route(
            "/api/calendar/permissions",
            get(permissions).patch(set_permissions),
        )
}

async fn context(State(app): State<AppState>, Extension(who): Extension<Identity>) -> Handled {
    let delivery: bool = app
        .db
        .lock()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM push_subscriptions WHERE owner_user=?)",
            [&who.user],
            |r| r.get(0),
        )
        .map_err(ApiError::from)?;
    Ok(ok(
        json!({"accountKey":super::account_key(&who.user),"reminderDeliveryAvailable":delivery}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    from: i64,
    to: i64,
    timezone: String,
    cursor: Option<String>,
}
async fn range(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Query(input): Query<Range>,
) -> Handled {
    Ok(ok(query(
        &app.db.lock(),
        &who.user,
        input.from,
        input.to,
        &input.timezone,
        input.cursor.as_deref(),
        now_ms(),
    )?))
}
fn id_ok(id: &str) -> Result<(), ApiError> {
    if (1..=100).contains(&id.len()) {
        Ok(())
    } else {
        Err(ApiError::invalid_input())
    }
}
async fn show(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    id_ok(&id)?;
    Ok(ok(json!({"event":event(&app.db.lock(),&who.user,&id)?})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct New {
    idempotency_key: String,
    event: Spec,
}
async fn add(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let input: New = body.parse()?;
    let saved = create(
        &app.db.lock(),
        &who.user,
        &input.idempotency_key,
        &input.event,
        now_ms(),
    )?;
    app.schedules_changed(&who.user);
    Ok(json_response(201, &json!({"event":saved})))
}
fn series() -> String {
    "series".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    revision: i64,
    event: Spec,
    #[serde(default = "series")]
    scope: String,
    occurrence: Option<String>,
}
async fn edit(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: Edit = body.parse()?;
    let saved = update(
        &app.db.lock(),
        &who.user,
        &id,
        &input.event,
        crate::calendar::Mutation {
            revision: input.revision,
            scope: &input.scope,
            occurrence: input.occurrence.as_deref(),
        },
        now_ms(),
    )?;
    app.schedules_changed(&who.user);
    Ok(ok(json!({"event":saved})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Delete {
    revision: i64,
    #[serde(default = "series")]
    scope: String,
    occurrence: Option<String>,
}
async fn delete(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: Delete = body.parse()?;
    remove(
        &app.db.lock(),
        &who.user,
        &id,
        input.revision,
        &input.scope,
        input.occurrence.as_deref(),
        now_ms(),
    )?;
    app.schedules_changed(&who.user);
    Ok(no_content())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Permissions {
    allow_read: bool,
    allow_propose: bool,
}
async fn permissions(State(app): State<AppState>, Extension(who): Extension<Identity>) -> Handled {
    let p = super::agent::permissions(&app.db.lock(), &who.user)?;
    Ok(ok(
        json!({"allowRead":p.allow_read,"allowPropose":p.allow_propose}),
    ))
}
async fn set_permissions(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let p: Permissions = body.parse()?;
    super::agent::set_permissions(
        &app.db.lock(),
        &who.user,
        super::agent::Permissions {
            allow_read: p.allow_read,
            allow_propose: p.allow_propose,
        },
    )?;
    app.schedules_changed(&who.user);
    Ok(ok(
        json!({"allowRead":p.allow_read,"allowPropose":p.allow_propose}),
    ))
}
