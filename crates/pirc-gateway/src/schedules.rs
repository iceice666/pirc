//! Scheduled agent runs (`apps/gateway/src/daemon/schedules.ts`,
//! `schedule-routes.ts`, docs/history/cron.md) and their agent operations
//! (`schedule.*`). STUB: being ported (M2.6).

use axum::Router;
use serde_json::Value;

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

/// `/api/schedules*`.
pub fn routes() -> Router<AppState> {
    Router::new()
}

/// Start the scheduler (ticks, event subscription, proposal expiry).
pub fn start(_app: &AppState) {}

/// Schedule proposals of this session waiting for the user, as interactions.
pub fn pending_interactions(_app: &App, _session_id: &str) -> Vec<Value> {
    Vec::new()
}

/// Answer a schedule proposal's confirmation; `None` when it is not one.
pub fn answer(
    _app: &AppState,
    _session_id: &str,
    _interaction_id: &str,
    _user: &str,
    _answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    Ok(None)
}
