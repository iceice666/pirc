//! The node side of the agent → gateway channel (`node/agent-gateway.ts`):
//! runners hand over their agent's `gateway_request` here, and the answer
//! comes back as an `agent_response` on the link. Owner: **runner**.
//!
//! Every request gets exactly one answer: the gateway's; 503
//! `gateway_offline` "This node is not connected to the gateway" while the
//! link is not registered or the frame cannot be sent; 503 "The gateway
//! connection dropped; the outcome is unknown" when it drops mid-request;
//! 504 `gateway_timeout` after [`pirc_protocol::AGENT_REQUEST_TIMEOUT_MS`];
//! 429 `too_many_requests` beyond 64 pending on the node. Request ids are
//! random UUIDs; frames go through `LinkSender::send_agent_frame`.

use serde_json::{Value, json};

use crate::services::WeakNode;

/// `AgentAnswer`: the gateway's status and body (`{result}` on 2xx,
/// otherwise `{error: {code, message, details?}}`).
#[derive(Clone, Debug, PartialEq)]
pub struct AgentAnswer {
    pub status: u16,
    pub body: Value,
}

/// `agentError(status, code, message, details?)`.
pub fn agent_error(status: u16, code: &str, message: &str, details: Option<Value>) -> AgentAnswer {
    let mut error = json!({ "code": code, "message": message });
    if let Some(details) = details {
        error["details"] = details;
    }
    AgentAnswer {
        status,
        body: json!({ "error": error }),
    }
}

pub struct AgentGateway {
    node: WeakNode,
}

impl AgentGateway {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// The link is registered.
    pub fn connect(&self) {
        let _ = &self.node;
        todo!("runner: DaemonAgentGateway.connect")
    }

    /// The link is gone: waiting requests are answered offline.
    pub fn disconnect(&self) {
        todo!("runner: DaemonAgentGateway.disconnect")
    }

    /// An `agent_response` frame (`body` absent is `null`).
    pub fn receive(&self, request_id: &str, status: u16, body: Option<Value>) {
        let _ = (request_id, status, body);
        todo!("runner: DaemonAgentGateway.receive")
    }

    /// Ask the gateway on behalf of `session_id`, a session of this node.
    /// Never fails: every outcome is an answer.
    pub async fn request(&self, session_id: &str, op: &str, args: Value) -> AgentAnswer {
        let _ = (session_id, op, args);
        todo!("runner: DaemonAgentGateway.request")
    }
}
