//! Auto mode (`agent/auto-mode/index.ts`, `rules.ts`): a pre-execution
//! filter for shell actions. The rules (deny-list, read/write/danger) are
//! M4's; the model classifier is M5's (`useModel: false` meanwhile).

use serde_json::{Map, Value};

use crate::host::AgentHost;
use crate::signal::AbortSignal;

/// `AutoMode`.
#[derive(Default)]
pub struct AutoMode {}

impl AutoMode {
    pub fn new() -> Self {
        Self::default()
    }

    /// `gate`: `Ok(Some(refusal))` for the model, `Ok(None)` when the call
    /// may run (after taking the write lease when needed), `Err` when the
    /// lease was refused.
    pub async fn gate(
        &self,
        host: &dyn AgentHost,
        tool: &str,
        args: &Map<String, Value>,
        signal: &AbortSignal,
    ) -> Result<Option<String>, String> {
        let _ = (host, tool, args, signal);
        todo!("M4 tools: AutoMode::gate")
    }
}
