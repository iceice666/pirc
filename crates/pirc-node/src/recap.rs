//! The evidence a recap is written from (`node/recap.ts` `collectRecap`):
//! the agent's `gateway_request` with op `recap.collect` is answered here,
//! on the node, from the session files of the same owner's other sessions
//! in the same directory workspace. Owner: **runner**.
//!
//! The model call is the agent's (its recap feature); this only reads,
//! bounded and redacted (`pirc_agent::redact`), with every limit in UTF-16
//! units as TS counts them. The TS query also excluded sessions started by
//! schedules or delegations through the gateway's tables, which a node's
//! store never filled; those exclusions are dropped, the node-local
//! markers stay. Golden cases: `node-recap.test.ts`.

use serde_json::Value;

use crate::error::ApiResult;
use crate::services::Node;

/// `collectRecap(db, sessionId, args)`: the evidence object, or the error
/// the agent gets (`args` must be `{days?: 1..90}`, strict).
pub fn collect_recap(node: &Node, session_id: &str, args: &Value) -> ApiResult<Value> {
    let _ = (node, session_id, args);
    todo!("runner: port collectRecap")
}
