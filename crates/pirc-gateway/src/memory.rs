//! The assistant's memory (`apps/gateway/src/daemon/memory.ts`,
//! `memory-interactions.ts`, `memory-routes.ts`) and its agent operations
//! (`assistant.context`, `memory.note`, `memory.proposeUser`,
//! `memory.search`, `recall.remote` in `agent-ops.ts`). STUB: being ported
//! (M2.6).

use axum::Router;
use rusqlite::Connection;
use serde_json::Value;

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::error::ApiResult;

/// A parsed memory or assistant operation.
pub enum Op {}

pub fn parse_op(_op: &str, _args: &Value) -> Option<Result<Op, ()>> {
    None
}

pub async fn run_op(_app: &AppState, _context: &OpContext, op: Op) -> ApiResult<Value> {
    match op {}
}

/// `/api/memory*`.
pub fn routes() -> Router<AppState> {
    Router::new()
}

/// Forget what memory learned from a deleted chat (`MemoryStore.forgetSession`),
/// inside the deletion's transaction.
pub fn forget_session(
    _app: &App,
    _conn: &Connection,
    _user: &str,
    _session_id: &str,
) -> ApiResult<()> {
    Ok(())
}

/// The user's memory changed (`MemoryInteractions.changed`): its pending
/// proposals' interactions are published to their sessions. Hints are the caller's.
pub fn changed(_app: &App, _user: &str) {}

/// Pending USER-memory proposals of the session, as interactions.
pub fn pending_interactions(_app: &App, _session_id: &str, _user: &str) -> Vec<Value> {
    Vec::new()
}

/// Answer a memory proposal's interaction; `None` when it is not one.
pub fn answer(
    _app: &App,
    _session_id: &str,
    _interaction_id: &str,
    _user: &str,
    _answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    Ok(None)
}
