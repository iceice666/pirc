//! `web.search` for agents with the gateway's Exa key
//! (`apps/gateway/src/daemon/web-search.ts`). STUB: being ported (M2.6).

use serde_json::Value;

use crate::agent_ops::OpContext;
use crate::app::AppState;
use crate::error::ApiResult;

/// A parsed `web.*` operation.
pub enum Op {}

/// `None`: not a `web.*` operation this module knows; `Some(Err(()))`:
/// invalid arguments.
pub fn parse_op(_op: &str, _args: &Value) -> Option<Result<Op, ()>> {
    None
}

pub async fn run_op(_app: &AppState, _context: &OpContext, op: Op) -> ApiResult<Value> {
    match op {}
}
