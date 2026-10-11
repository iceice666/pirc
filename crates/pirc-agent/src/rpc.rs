//! JSONL RPC with the node (`agent/rpc.ts`): commands on stdin, responses
//! and events on stdout, and `RpcUi`, whose dialogs are
//! `extension_ui_request`s answered by `extension_ui_response`.

use std::rc::Rc;

use serde_json::Value;

use crate::agent::Agent;

/// Writes one JSON value per stdout line, in call order.
pub type Write = Rc<dyn Fn(Value)>;

/// `RpcUi`: dialogs are serialized so only one is open.
pub struct RpcUi {
    write: Write,
}

impl RpcUi {
    pub fn new(write: Write) -> Rc<Self> {
        let _ = write;
        todo!("M4 rpc: RpcUi::new")
    }

    /// `respond`: an `extension_ui_response`.
    pub fn respond(&self, response: &Value) {
        let _ = (response, &self.write);
        todo!("M4 rpc: RpcUi::respond")
    }

    /// `cancelAll`.
    pub fn cancel_all(&self) {
        todo!("M4 rpc: RpcUi::cancel_all")
    }
}

/// `handleCommand`: one RPC command; `Ok(Some(data))` is the response's
/// `data`, `Err` its `error`.
pub async fn handle_command(agent: &Rc<Agent>, command: &Value) -> Result<Option<Value>, String> {
    let _ = (agent, command);
    todo!("M4 rpc: handleCommand")
}
