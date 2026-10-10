//! Workspace memory mirrored from the nodes, for the assistant's search
//! (`apps/gateway/src/daemon/memory-records.ts`). STUB: being ported (M2.6).

use serde_json::{Value, json};

use crate::app::App;
use crate::error::ApiResult;

/// Byte offsets of a node's mirrored ledgers, by ledger key (sent in `registered`).
pub fn watermarks(_app: &App, _node_id: &str) -> Value {
    json!({})
}

/// Store a `memory_mirror` chunk; returns the ledger's watermark.
pub fn ingest(
    _app: &App,
    _node_id: &str,
    _ledger_key: &str,
    _offset: u64,
    end: u64,
    _reset: bool,
    _lines: &[Value],
) -> ApiResult<u64> {
    Ok(end)
}
