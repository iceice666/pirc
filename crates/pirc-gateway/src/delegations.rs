//! Tasks the assistant hands to other workspaces
//! (`apps/gateway/src/daemon/delegations.ts`) and their agent operations
//! (`delegation.create`, `delegation.status`). STUB: being ported (M2.6).

use serde_json::{Value, json};

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::error::ApiResult;

pub enum Op {}

pub fn parse_op(_op: &str, _args: &Value) -> Option<Result<Op, ()>> {
    None
}

pub async fn run_op(_app: &AppState, _context: &OpContext, op: Op) -> ApiResult<Value> {
    match op {}
}

/// Start following sessions (event subscription) and the expiry sweep.
pub fn start(_app: &AppState) {}

/// The directory workspaces the assistant can delegate to (`Delegations.workspaces`).
pub fn workspaces(_app: &App) -> ApiResult<Value> {
    Ok(json!([]))
}

/// Delegations of this assistant session waiting for the user's approval, as interactions.
pub fn pending_interactions(_app: &App, _session_id: &str) -> Vec<Value> {
    Vec::new()
}

/// Answer a delegation's confirmation; `None` when it is not one.
pub fn answer(
    _app: &AppState,
    _session_id: &str,
    _interaction_id: &str,
    _user: &str,
    _answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    Ok(None)
}
