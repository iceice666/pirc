//! Owner-authenticated pots API. No observation injection or autonomous dispatch.
use axum::{
    Router,
    extract::{Extension, Path, Query, State},
    routing::get,
};
use serde::Deserialize;
use serde_json::json;

use super::*;
use crate::{
    app::{AppState, ReqBody},
    auth::Identity,
    db::Store,
    error::{ApiError, json_response},
    http::ok,
    routes::Handled,
    util::now_ms,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/pots", get(overview))
        .route(
            "/api/pots/responsibilities",
            get(responsibilities).post(create),
        )
        .route("/api/pots/responsibilities/{id}", get(responsibility))
        .route(
            "/api/pots/responsibilities/{id}/control",
            axum::routing::post(control_responsibility_route),
        )
        .route("/api/pots/suggestions", get(suggestions))
        .route("/api/pots/suggestions/{id}", get(suggestion))
        .route(
            "/api/pots/suggestions/{id}/control",
            axum::routing::post(control_suggestion_route),
        )
        .route(
            "/api/pots/suggestions/{id}/track",
            axum::routing::post(track),
        )
        .route("/api/pots/tasks", get(tasks))
        .route("/api/pots/tasks/{id}", get(task))
        .route(
            "/api/pots/tasks/{id}/control",
            axum::routing::post(control_task_route),
        )
        .route("/api/pots/tasks/{id}/start", axum::routing::post(start))
}

fn id_ok(id: &str) -> Result<(), ApiError> {
    if (1..=100).contains(&id.len()) {
        Ok(())
    } else {
        Err(ApiError::invalid_input())
    }
}
fn default_limit() -> u32 {
    LIST_MAX
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    #[serde(default = "default_limit")]
    limit: u32,
}

async fn overview(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Query(page): Query<Page>,
) -> Handled {
    let conn = app.db.lock();
    Ok(ok(json!({
        "actor": {"kind":"pots", "id":"personal"},
        "accountKey": &crate::util::sha256_hex(format!("pirc-pots:{}", who.user))[..32],
        "workspaces": conn.list_workspaces_for_user(&who.user)?.into_iter().take(LIST_MAX as usize).map(|w|json!({"id":w.id,"name":w.display_name})).collect::<Vec<_>>(),
        "executionAvailable": true,
        "observationMode":"session_progress_events",
        "responsibilities": list_responsibilities(&conn, &who.user, page.limit)?,
        "suggestions": list_suggestions(&conn, &who.user, page.limit)?,
        "tasks": list_tasks(&conn, &who.user, page.limit)?
    })))
}
async fn responsibilities(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Query(page): Query<Page>,
) -> Handled {
    Ok(ok(
        json!({"responsibilities":list_responsibilities(&app.db.lock(), &who.user, page.limit)?}),
    ))
}
async fn create(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let input: ResponsibilityInput = body.parse()?;
    Ok(json_response(
        201,
        &json!({"responsibility":create_responsibility(&app.db.lock(), &who.user, input, now_ms())?}),
    ))
}
async fn responsibility(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    id_ok(&id)?;
    Ok(ok(
        json!({"responsibility":get_responsibility(&app.db.lock(), &who.user, &id)?}),
    ))
}
async fn control_responsibility_route(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: ResponsibilityControl = body.parse()?;
    let responsibility = control_responsibility(&app.db.lock(), &who.user, &id, input, now_ms())?;
    execution::fence_invalid_pending(&app, Some(&who.user), None).await?;
    Ok(ok(json!({"responsibility":responsibility})))
}
async fn suggestions(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Query(page): Query<Page>,
) -> Handled {
    Ok(ok(
        json!({"suggestions":list_suggestions(&app.db.lock(), &who.user, page.limit)?}),
    ))
}
async fn suggestion(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    id_ok(&id)?;
    Ok(ok(
        json!({"suggestion":get_suggestion(&app.db.lock(), &who.user, &id)?}),
    ))
}
async fn control_suggestion_route(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: SuggestionControl = body.parse()?;
    Ok(ok(
        json!({"suggestion":control_suggestion(&app.db.lock(), &who.user, &id, input, now_ms())?}),
    ))
}
async fn track(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: AcceptInput = body.parse()?;
    Ok(ok(
        json!({"task":accept_tracking(&app.db.lock(), &who.user, &id, input, now_ms())?}),
    ))
}
async fn tasks(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Query(page): Query<Page>,
) -> Handled {
    Ok(ok(
        json!({"tasks":list_tasks(&app.db.lock(), &who.user, page.limit)?}),
    ))
}
async fn task(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    id_ok(&id)?;
    Ok(ok(
        json!({"task":get_task(&app.db.lock(), &who.user, &id)?}),
    ))
}
async fn control_task_route(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: TaskControl = body.parse()?;
    Ok(ok(
        json!({"task":execution::control_task_route(&app, &who.user, &id, input).await?}),
    ))
}
async fn start(
    State(app): State<AppState>,
    Extension(who): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    id_ok(&id)?;
    let input: StartInput = body.parse()?;
    Ok(ok(
        json!({"task":execution::start_task_route(&app, &who.user, &id, input).await?}),
    ))
}
