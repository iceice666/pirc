//! The gateway's features around sessions: device pairing, and (sub-item 6
//! of M2, still being ported) the assistant's memory, delegations,
//! schedules, push notifications, agent operations and web search. Until
//! they land, the hooks below behave as a gateway without them.

use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, Method, header};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{delete, get};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::{App, AppState, ReqBody};
use crate::auth::Identity;
use crate::error::{ApiError, ApiResult, json_response};
use crate::http::{no_content, ok};
use crate::routes::Handled;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/devices", get(list_devices).post(pair_device))
        .route("/api/devices/{id}", delete(revoke_device))
}

/// The routes of the TS gateway's device and model-backend scopes, whose
/// replies (authentication failures included) are never cached.
fn no_store_route(method: &Method, path: &str) -> bool {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let one = |s: &str| !s.is_empty();
    match (method.as_str(), segments.as_slice()) {
        ("GET" | "POST", ["api", "devices"]) => true,
        ("DELETE", ["api", "devices", id]) => one(id),
        ("GET" | "POST", ["api", "providers"]) => true,
        ("GET", ["api", "providers", "presets"]) => true,
        ("POST", ["api", "providers", "discover" | "test"]) => true,
        ("PUT" | "DELETE", ["api", "providers", id]) => one(id),
        ("POST", ["api", "provider-auth", "sessions"]) => true,
        ("GET" | "DELETE", ["api", "provider-auth", "sessions", id]) => one(id),
        ("POST", ["api", "provider-auth", "sessions", id, "input"]) => one(id),
        _ => false,
    }
}

/// Adds `cache-control: no-store` to the replies of [`no_store_route`]s.
pub async fn no_store(request: axum::extract::Request, next: Next) -> Response {
    let cached = !no_store_route(request.method(), request.uri().path());
    let mut response = next.run(request).await;
    if !cached {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

/// Device management needs forward auth: a device token can neither mint
/// nor revoke tokens (the auth middleware refuses it; checked again here).
fn owner(identity: &Identity) -> ApiResult<&str> {
    if identity.device_id.is_some() {
        return Err(ApiError::new(
            403,
            "forbidden",
            "Device tokens cannot manage devices",
        ));
    }
    Ok(&identity.user)
}

async fn list_devices(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Handled {
    let devices = app.devices.list(owner(&identity)?)?;
    Ok(ok(json!({ "devices": devices })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    name: String,
}

async fn pair_device(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let user = owner(&identity)?;
    let PairBody { name } = body.parse()?;
    let name = name.trim_matches(pirc_config::js_space);
    if !(1..=100).contains(&name.encode_utf16().count()) {
        return Err(ApiError::invalid_input().into());
    }
    let (device, token) = app.devices.create(user, name)?;
    Ok(json_response(
        201,
        &json!({ "device": device, "token": token }),
    ))
}

async fn revoke_device(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Handled {
    let user = owner(&identity)?;
    if id.encode_utf16().count() > 200 {
        return Err(ApiError::invalid_input().into());
    }
    app.devices.revoke(user, &id)?;
    Ok(no_content())
}

impl App {
    /// Memory hints (`memory=1`) for `user`.
    pub fn memory_changed(&self, user: &str) {
        self.hints.memory.notify(&user.to_owned());
    }

    /// Forget what the assistant's memory learned from a deleted chat (in
    /// the deletion's transaction).
    pub fn forget_session_memory(
        &self,
        _conn: &Connection,
        _user: &str,
        _session_id: &str,
    ) -> ApiResult<()> {
        Ok(())
    }

    /// Confirmations the gateway asks for itself (delegations, schedule
    /// proposals, memory), shown with the node's interactions.
    pub fn pending_gateway_interactions(&self, _session_id: &str, _user: &str) -> Vec<Value> {
        Vec::new()
    }

    /// Answer one of the gateway's own confirmations; `None` when the
    /// interaction is the node's.
    pub fn answer_gateway_interaction(
        &self,
        _session_id: &str,
        _interaction_id: &str,
        _user: &str,
        _answer: Option<Value>,
    ) -> ApiResult<Option<Value>> {
        Ok(None)
    }

    /// Byte offsets of a node's mirrored workspace-memory ledgers.
    pub fn mirror_watermarks(&self, _node_id: &str) -> Value {
        json!({})
    }

    /// Store a mirrored chunk; the ledger's new watermark.
    pub fn on_mirror(
        &self,
        _node_id: &str,
        _ledger_key: &str,
        _offset: u64,
        end: u64,
        _reset: bool,
        _lines: &[Value],
    ) -> ApiResult<u64> {
        Ok(end)
    }

    /// Answer an agent's gateway operation: `(status, body)`.
    pub async fn run_agent_op(
        &self,
        _node_id: &str,
        _session_id: &str,
        op: &str,
        _args: Value,
    ) -> (u16, Value) {
        (
            404,
            json!({ "error": { "code": "unknown_operation",
                "message": format!("Unknown gateway operation: {op}") } }),
        )
    }
}
