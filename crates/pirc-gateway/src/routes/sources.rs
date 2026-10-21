//! The sources API (plans/rewrite/09-sources.md), next to the model
//! backends: device tokens cannot reach it without a management grant
//! (`auth::device_denied`), and no answer holds a credential. Adding or
//! changing a source tries it first and takes its baseline (what it holds
//! then wakes nobody); a Moodle site is signed in to here and only its
//! token is kept.

use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::http::Uri;
use axum::routing::{get, post};
use serde_json::{Value, json};

use super::Handled;
use super::rooms::{positive, single};
use crate::app::{AppState, ReqBody};
use crate::auth::Identity;
use crate::error::{ApiError, ApiResult, json_response};
use crate::http::ok;
use crate::sources::store::{self, NewSource, Source};
use crate::sources::{self, KINDS, calendar, email, moodle, service};
use crate::util::now_ms;

const NAME_MAX: usize = 100;
const ID_MAX: usize = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sources", get(list).post(create))
        .route("/api/sources/moodle/launch", post(launch))
        .route(
            "/api/sources/{id}",
            axum::routing::put(update).delete(remove),
        )
        .route("/api/sources/{id}/test", post(test))
        .route("/api/sources/{id}/pause", post(pause))
        .route("/api/sources/{id}/resume", post(resume))
        .route("/api/sources/{id}/poll", post(poll))
        .route("/api/sources/{id}/items", get(items))
}

/// Path parameters of the source routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[
    ("PUT", "/api/sources/{id}"),
    ("DELETE", "/api/sources/{id}"),
    ("POST", "/api/sources/{id}/test"),
    ("POST", "/api/sources/{id}/pause"),
    ("POST", "/api/sources/{id}/resume"),
    ("POST", "/api/sources/{id}/poll"),
    ("GET", "/api/sources/{id}/items"),
];

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "invalid_input", message)
}

fn id(text: &str) -> ApiResult<&str> {
    if text.is_empty() || text.len() > ID_MAX {
        return Err(ApiError::invalid_input());
    }
    Ok(text)
}

async fn list(State(app): State<AppState>) -> Handled {
    let conn = app.db.lock();
    let listed: Vec<Value> = store::list(&conn)?
        .iter()
        .map(|source| sources::view(&conn, source))
        .collect();
    Ok(ok(json!({
        "sources": listed,
        "kinds": KINDS,
        "webSearch": { "available": app.config.exa_api_key.is_some() },
    })))
}

/// A body's fields: an object with only these keys.
fn fields<'a>(
    body: &'a Option<&Value>,
    allowed: &[&str],
) -> ApiResult<&'a serde_json::Map<String, Value>> {
    let Some(Value::Object(fields)) = body else {
        return Err(ApiError::invalid_input());
    };
    if let Some(key) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("Unknown field {key}")));
    }
    Ok(fields)
}

fn object(fields: &serde_json::Map<String, Value>, key: &str) -> ApiResult<Option<Value>> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(format!("`{key}` is an object"))),
    }
}

fn name_of(fields: &serde_json::Map<String, Value>) -> ApiResult<Option<String>> {
    match fields.get("name") {
        None => Ok(None),
        Some(Value::String(name)) if (1..=NAME_MAX).contains(&name.trim().chars().count()) => {
            Ok(Some(name.trim().to_owned()))
        }
        Some(_) => Err(invalid(format!("`name` is 1 to {NAME_MAX} characters"))),
    }
}

/// A source not stored yet, to try.
fn draft(id: &str, kind: &str, name: &str, owner: &str, config: Value) -> Source {
    Source {
        id: id.to_owned(),
        kind: kind.to_owned(),
        name: name.to_owned(),
        owner: owner.to_owned(),
        config,
        paused_at: None,
        cursor: None,
        last_polled_at: None,
        last_error: None,
        failures: 0,
        noted_at: None,
        created_at: 0,
        updated_at: 0,
    }
}

/// A Moodle site signed in to: its configuration and `{token}`. With
/// `secret.launch` (the pasted `moodlemobile://` address of a launch this
/// gateway started), else `secret.username` and `secret.password`.
async fn moodle_login(app: &AppState, config: &Value, secret: &Value) -> ApiResult<(Value, Value)> {
    let url = config
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("The Moodle address (url) is required"))?;
    let base = moodle::base_url(url).map_err(invalid)?;
    let field = |key: &str| {
        secret
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let token = if let Some(launch) = field("launch") {
        let (signature, token) = moodle::launched(launch).map_err(invalid)?;
        let info = moodle::site_info(&base, &token).await?;
        let site_url = info
            .get("siteurl")
            .and_then(Value::as_str)
            .unwrap_or(base.as_str())
            .to_owned();
        let passports = service(app).passports(&site_key(&base), now_ms());
        if !passports.iter().any(|passport| {
            moodle::signed(&signature, &site_url, passport)
                || moodle::signed(&signature, base.as_str(), passport)
        }) {
            return Err(invalid(
                "That login was not started here (or is older than 30 minutes); start the app login again",
            ));
        }
        token
    } else {
        let (Some(username), Some(password)) = (field("username"), field("password")) else {
            return Err(invalid(
                "A user name and password, or the app login's address, is required",
            ));
        };
        moodle::login(&base, username, password).await?
    };
    let info = moodle::site_info(&base, &token).await?;
    Ok((moodle::config_of(&base, &info), json!({ "token": token })))
}

fn site_key(base: &url::Url) -> String {
    base.as_str().trim_end_matches('/').to_owned()
}

/// A kind's configuration and credentials from what the API was given.
async fn configure(
    app: &AppState,
    kind: &str,
    config: &Value,
    secret: &Value,
) -> ApiResult<(Value, Value)> {
    match kind {
        "email" => email::configure(config, secret).map_err(invalid),
        "calendar" => calendar::configure(config, secret).map_err(invalid),
        "moodle" => moodle_login(app, config, secret).await,
        "workspace" => Ok((sources_workspace(app, config)?, json!({}))),
        _ => Err(invalid(format!("`kind` is one of {}", KINDS.join(", ")))),
    }
}

fn sources_workspace(app: &AppState, config: &Value) -> ApiResult<Value> {
    crate::sources::workspace_config(app, config).map_err(invalid)
}

/// `{kind, name, config?, secret?}`: tried, then kept.
async fn create(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let body = body.json();
    let fields = fields(&body, &["kind", "name", "config", "secret"])?;
    let kind = fields
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| KINDS.contains(kind))
        .ok_or_else(|| invalid(format!("`kind` is one of {}", KINDS.join(", "))))?;
    let name = name_of(fields)?.ok_or_else(|| invalid("`name` is required"))?;
    let config = object(fields, "config")?.unwrap_or_else(|| json!({}));
    let secret = object(fields, "secret")?.unwrap_or_else(|| json!({}));
    let (config, secret) = configure(&app, kind, &config, &secret).await?;
    let source_id = store::new_source_id(&app.db.lock(), kind, &name)?;
    let tried = draft(&source_id, kind, &name, &identity.user, config.clone());
    let said = sources::test(&app, &tried, &secret)
        .await
        .map_err(ApiError::from)?;
    let sources = service(&app);
    sources.put_secret(&source_id, secret).map_err(|error| {
        crate::log::error(&format!("sources: cannot keep a credential: {error}"));
        ApiError::internal()
    })?;
    let inserted = store::insert(
        &app.db.lock(),
        &NewSource {
            id: &source_id,
            kind,
            name: &name,
            owner: &identity.user,
            config: &config,
        },
        now_ms(),
    );
    let source = match inserted {
        Ok(source) => source,
        Err(error) => {
            let _ = sources.remove_secret(&source_id);
            return Err(error.into());
        }
    };
    // Its baseline, at once: what it holds now wakes nobody.
    let baseline = sources::poller::poll_now(&app, &source.id, true).await;
    if let Err(error) = &baseline {
        crate::log::warn(&format!("sources: {}: {}", source.id, error.message));
    }
    sources.changed.notify_one();
    let conn = app.db.lock();
    let view = sources::view(&conn, &store::get(&conn, &source.id)?);
    Ok(json_response(201, &json!({ "source": view, "test": said })))
}

/// `{name?, config?, secret?}`: a new configuration or credential is
/// tried first, and starts the source over (the next poll is a baseline).
async fn update(
    State(app): State<AppState>,
    Path(source_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let source = store::get(&app.db.lock(), id(&source_id)?)?;
    let body = body.json();
    let fields = fields(&body, &["name", "config", "secret"])?;
    let name = name_of(fields)?;
    let (config, secret) = (object(fields, "config")?, object(fields, "secret")?);
    let mut said = None;
    let mut new_config = None;
    if config.is_some() || secret.is_some() {
        let sources = service(&app);
        let old_secret = sources.secret(&source.id);
        let given_config = match (&config, source.kind.as_str()) {
            (Some(config), _) => config.clone(),
            // A new password for the same site.
            (None, "moodle") => json!({ "url": source.config_str("url") }),
            (None, _) => source.config.clone(),
        };
        let given_secret = match (&secret, source.kind.as_str()) {
            (Some(secret), _) => secret.clone(),
            (None, "moodle") => {
                return Err(invalid("Sign in again to change a Moodle source").into());
            }
            (None, _) => old_secret,
        };
        let (config, secret) = configure(&app, &source.kind, &given_config, &given_secret).await?;
        let tried = draft(
            &source.id,
            &source.kind,
            &source.name,
            &source.owner,
            config.clone(),
        );
        said = Some(
            sources::test(&app, &tried, &secret)
                .await
                .map_err(ApiError::from)?,
        );
        sources.put_secret(&source.id, secret).map_err(|error| {
            crate::log::error(&format!("sources: cannot keep a credential: {error}"));
            ApiError::internal()
        })?;
        new_config = Some(config);
        sources.changed.notify_one();
    }
    let source = store::update(
        &app.db.lock(),
        &source.id,
        name.as_deref(),
        new_config.as_ref(),
        now_ms(),
    )?;
    if new_config.is_some() && source.paused_at.is_none() {
        // The new configuration's baseline.
        if let Err(error) = sources::poller::poll_now(&app, &source.id, true).await {
            crate::log::warn(&format!("sources: {}: {}", source.id, error.message));
        }
    }
    let conn = app.db.lock();
    let source = store::get(&conn, &source.id)?;
    Ok(ok(
        json!({ "source": sources::view(&conn, &source), "test": said }),
    ))
}

async fn remove(State(app): State<AppState>, Path(source_id): Path<String>) -> Handled {
    let source = store::get(&app.db.lock(), id(&source_id)?)?;
    store::delete(&app.db.lock(), &source.id)?;
    if let Err(error) = service(&app).remove_secret(&source.id) {
        crate::log::warn(&format!(
            "sources: cannot remove {}'s credential: {error}",
            source.id
        ));
    }
    Ok(ok(json!({ "deleted": source.id })))
}

async fn test(State(app): State<AppState>, Path(source_id): Path<String>) -> Handled {
    let source = store::get(&app.db.lock(), id(&source_id)?)?;
    let secret = service(&app).secret(&source.id);
    let said = sources::test(&app, &source, &secret)
        .await
        .map_err(ApiError::from)?;
    Ok(ok(json!({ "ok": true, "test": said })))
}

async fn set_paused(app: &AppState, source_id: &str, paused: bool) -> Handled {
    let conn = app.db.lock();
    store::get(&conn, id(source_id)?)?;
    let source = store::set_paused(&conn, source_id, paused, now_ms())?;
    service(app).changed.notify_one();
    Ok(ok(json!({ "source": sources::view(&conn, &source) })))
}

async fn pause(State(app): State<AppState>, Path(source_id): Path<String>) -> Handled {
    set_paused(&app, &source_id, true).await
}

async fn resume(State(app): State<AppState>, Path(source_id): Path<String>) -> Handled {
    set_paused(&app, &source_id, false).await
}

/// Read a source now: what changed, and the wake it caused.
async fn poll(State(app): State<AppState>, Path(source_id): Path<String>) -> Handled {
    let outcome = sources::poller::poll_now(&app, id(&source_id)?, true).await?;
    let conn = app.db.lock();
    let source = store::get(&conn, &source_id)?;
    Ok(ok(json!({
        "source": sources::view(&conn, &source),
        "baseline": outcome.baseline,
        "changed": outcome.changed,
        "wake": outcome.wake,
        "error": outcome.error.map(|error| json!({ "message": error.message, "auth": error.auth })),
    })))
}

/// What a source's polls saw, the latest first (`?limit=` up to 100).
async fn items(State(app): State<AppState>, Path(source_id): Path<String>, uri: Uri) -> Handled {
    let limit = positive(&uri, "limit")?.map_or(30, |limit| limit as usize);
    if limit > store::MAX_ITEMS {
        return Err(ApiError::invalid_input().into());
    }
    let query = single(&uri, "q")?;
    let conn = app.db.lock();
    let source = store::get(&conn, id(&source_id)?)?;
    let found = match query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
    {
        Some(query) => store::search_items(&conn, query, Some(&source.id), limit)?,
        None => store::recent_items(&conn, &source.id, limit)?,
    };
    Ok(ok(json!({ "items": found })))
}

/// `{url}`: start a Moodle app login. The person opens `launchUrl`, signs
/// in, and pastes the `moodlemobile://token=…` address it ends at as
/// `secret.launch` (within 30 minutes).
async fn launch(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    let body = body.json();
    let fields = fields(&body, &["url"])?;
    let url = fields
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("`url` is required"))?;
    let base = moodle::base_url(url).map_err(invalid)?;
    let passport = service(&app).new_passport(&site_key(&base), now_ms());
    Ok(ok(json!({
        "site": site_key(&base),
        "launchUrl": moodle::launch_url(&base, &passport).as_str(),
    })))
}
