//! Browser API for the single operator's model backends
//! (`backends/routes.ts`). Routes sit behind the forward-auth middleware
//! (device tokens are refused there); replies are secret-free snapshots and
//! are never cached (`features::no_store`).

use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::http::Uri;
use axum::routing::{get, post, put};
use pirc_providers::backends::BackendError;
use serde_json::{Value, json};

use crate::app::{AppState, ReqBody};
use crate::auth::Identity;
use crate::error::{ApiError, json_response};
use crate::http::{Body, ok};
use crate::routes::Handled;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers", get(snapshot).post(create))
        // Fastify routes each method separately: a static path of one method
        // does not hide `{id}` for the others (`test` is a valid backend ID).
        .route(
            "/api/providers/presets",
            get(presets).put(update).delete(remove),
        )
        .route(
            "/api/providers/discover",
            post(discover).put(update).delete(remove),
        )
        .route("/api/providers/test", post(test).put(update).delete(remove))
        .route(
            "/api/providers/default-model",
            put(set_default).delete(remove),
        )
        .route("/api/providers/{id}", put(update).delete(remove))
        .route("/api/provider-auth/sessions", post(start_auth))
        .route(
            "/api/provider-auth/sessions/{id}",
            get(auth_status).delete(cancel_auth),
        )
        .route("/api/provider-auth/sessions/{id}/input", post(auth_input))
}

fn api_error(error: BackendError) -> ApiError {
    ApiError::new(error.status, error.code, error.message)
}

/// `request.body ?? fallback`. A raw (non-JSON) body was a Buffer, which
/// no schema accepts: it stays a non-object value.
fn body_or(body: &Body, fallback: Value) -> Value {
    match body {
        Body::None | Body::Json(Value::Null) => fallback,
        Body::Json(value) => value.clone(),
        Body::Raw { .. } => json!([]),
    }
}

/// `z.object({ id: z.string().min(1).max(200) })` of the path.
fn id_param(id: &str) -> Result<&str, ApiError> {
    if (1..=200).contains(&id.encode_utf16().count()) {
        Ok(id)
    } else {
        Err(ApiError::invalid_input())
    }
}

async fn snapshot(State(app): State<AppState>) -> Handled {
    Ok(ok(app.backends.snapshot()))
}

async fn presets(State(app): State<AppState>) -> Handled {
    let presets: Vec<Value> = app.backends.presets().iter().map(|p| p.to_json()).collect();
    Ok(ok(json!({ "presets": presets })))
}

/// Probes of an unsaved form: keys are write-only and never returned.
async fn discover(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    let models = app
        .backends
        .discover(&body_or(&body, json!({})))
        .await
        .map_err(api_error)?;
    let models: Vec<Value> = models.iter().map(|m| m.to_json()).collect();
    Ok(ok(json!({ "models": models })))
}

async fn test(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    let result = app
        .backends
        .test_provider(&body_or(&body, json!({})))
        .await
        .map_err(api_error)?;
    Ok(ok(result.to_json()))
}

async fn create(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    let mut body = body_or(&body, json!({}));
    // `const { id, ...rest } = body`
    let id = match body
        .as_object_mut()
        .and_then(|object| object.shift_remove("id"))
    {
        Some(Value::String(id)) => id,
        _ => String::new(),
    };
    app.backends
        .save_provider(&id, &body, true)
        .map_err(api_error)?;
    Ok(json_response(201, &app.backends.snapshot()))
}

/// The static route wins over `{id}`; `default-model` is not a valid backend ID.
async fn set_default(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    app.backends
        .set_default(&body_or(&body, Value::Null))
        .map_err(api_error)?;
    Ok(ok(app.backends.snapshot()))
}

/// The last path segment: the `{id}` of a backend route, or the static
/// segment a route of another method shares the path with.
fn last_segment(uri: &Uri) -> String {
    let segment = uri.path().rsplit('/').next().unwrap_or_default();
    percent_decode(segment)
}

fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[index] == b'%'
            && let (Some(Some(high)), Some(Some(low))) = (
                bytes.get(index + 1).map(|b| hex(*b)),
                bytes.get(index + 2).map(|b| hex(*b)),
            )
        {
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn update(State(app): State<AppState>, uri: Uri, ReqBody(body): ReqBody) -> Handled {
    let id = last_segment(&uri);
    let id = id_param(&id)?;
    app.backends
        .save_provider(id, &body_or(&body, json!({})), false)
        .map_err(api_error)?;
    Ok(ok(app.backends.snapshot()))
}

async fn remove(State(app): State<AppState>, uri: Uri) -> Handled {
    let id = last_segment(&uri);
    app.backends
        .delete_provider(id_param(&id)?)
        .map_err(api_error)?;
    Ok(ok(app.backends.snapshot()))
}

/// `{ providerId: string(1..100), policyConsent?: boolean }.strict()`.
fn start_body(body: &Body) -> Result<(String, bool), ApiError> {
    let value = body_or(body, json!({}));
    let object = value
        .as_object()
        .filter(|object| {
            object
                .keys()
                .all(|key| key == "providerId" || key == "policyConsent")
        })
        .ok_or_else(ApiError::invalid_input)?;
    let provider_id = object
        .get("providerId")
        .and_then(Value::as_str)
        .filter(|id| (1..=100).contains(&id.encode_utf16().count()))
        .ok_or_else(ApiError::invalid_input)?;
    let consent = match object.get("policyConsent") {
        None => false,
        Some(Value::Bool(consent)) => *consent,
        Some(_) => return Err(ApiError::invalid_input()),
    };
    Ok((provider_id.to_owned(), consent))
}

async fn start_auth(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let (provider_id, consent) = start_body(&body)?;
    let session = app
        .backends
        .start_auth(&identity.user, &provider_id, consent)
        .map_err(api_error)?;
    Ok(json_response(201, &session))
}

async fn auth_status(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let session = app
        .backends
        .auth_status(&identity.user, id_param(&id)?)
        .map_err(api_error)?;
    Ok(ok(session))
}

async fn cancel_auth(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let session = app
        .backends
        .cancel_auth(&identity.user, id_param(&id)?)
        .map_err(api_error)?;
    Ok(ok(session))
}

/// `{ promptId: string(1..100), value?: string(..16384) }.strict()`,
/// checked before the path.
fn input_body(body: &Body) -> Result<(String, Option<String>), ApiError> {
    let value = body_or(body, json!({}));
    let object = value
        .as_object()
        .filter(|object| object.keys().all(|key| key == "promptId" || key == "value"))
        .ok_or_else(ApiError::invalid_input)?;
    let prompt_id = object
        .get("promptId")
        .and_then(Value::as_str)
        .filter(|id| (1..=100).contains(&id.encode_utf16().count()))
        .ok_or_else(ApiError::invalid_input)?;
    let answer = match object.get("value") {
        None => None,
        Some(Value::String(text)) if text.encode_utf16().count() <= 16_384 => Some(text.clone()),
        Some(_) => return Err(ApiError::invalid_input()),
    };
    Ok((prompt_id.to_owned(), answer))
}

async fn auth_input(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let (prompt_id, answer) = input_body(&body)?;
    let session = app
        .backends
        .auth_input(
            &identity.user,
            id_param(&id)?,
            &prompt_id,
            answer.as_deref(),
        )
        .map_err(api_error)?;
    Ok(ok(session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_default_like_the_routes() {
        assert_eq!(body_or(&Body::None, json!({})), json!({}));
        assert_eq!(body_or(&Body::Json(Value::Null), Value::Null), Value::Null);
        assert_eq!(
            body_or(&Body::Json(json!({ "a": 1 })), json!({})),
            json!({ "a": 1 })
        );
        assert!(
            !body_or(
                &Body::Raw {
                    bytes: Default::default(),
                    content_type: None
                },
                json!({})
            )
            .is_object()
        );
    }

    #[test]
    fn backend_ids_from_the_path() {
        let id = |path: &str| last_segment(&path.parse().unwrap());
        assert_eq!(id("/api/providers/test"), "test");
        assert_eq!(id("/api/providers/oauth:anthropic"), "oauth:anthropic");
        assert_eq!(id("/api/providers/a%20b%zz"), "a b%zz");
        assert_eq!(id("/api/providers/caf%C3%A9"), "café");
    }

    #[test]
    fn auth_bodies() {
        let start = |value: Value| start_body(&Body::Json(value));
        assert_eq!(
            start(json!({ "providerId": "anthropic" })).unwrap(),
            ("anthropic".to_owned(), false)
        );
        assert!(
            start(json!({ "providerId": "a", "policyConsent": true }))
                .unwrap()
                .1
        );
        for bad in [
            json!({}),
            json!({ "providerId": "" }),
            json!({ "providerId": "a", "x": 1 }),
            json!({ "providerId": "a", "policyConsent": "yes" }),
        ] {
            assert!(start(bad.clone()).is_err(), "{bad}");
        }
        let input = |value: Value| input_body(&Body::Json(value));
        assert_eq!(
            input(json!({ "promptId": "p" })).unwrap(),
            ("p".to_owned(), None)
        );
        assert!(input(json!({ "promptId": "p", "value": 1 })).is_err());
        assert!(input(json!({ "promptId": "p", "value": "x".repeat(16_385) })).is_err());
    }
}
