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

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use pirc_protocol::{AGENT_REQUEST_TIMEOUT_MS, NodeMessage};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::services::WeakNode;
use crate::util::uuid;

/// Requests waiting for the gateway, node-wide.
const MAX_PENDING: usize = 64;

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

fn offline(message: &str) -> AgentAnswer {
    agent_error(503, "gateway_offline", message, None)
}

const NOT_CONNECTED: &str = "This node is not connected to the gateway";
const DROPPED: &str = "The gateway connection dropped; the outcome is unknown";

type Sender = Arc<dyn Fn(&NodeMessage) -> bool + Send + Sync>;

#[derive(Default)]
struct State {
    /// TS kept the link's `send` here between `connect` and `disconnect`.
    connected: bool,
    pending: HashMap<String, oneshot::Sender<AgentAnswer>>,
}

pub struct AgentGateway {
    send: Sender,
    timeout: Duration,
    state: Arc<Mutex<State>>,
}

impl AgentGateway {
    pub fn new(node: WeakNode) -> Self {
        Self::with_sender(
            Arc::new(move |message| {
                node.upgrade()
                    .is_some_and(|node| node.link.send_agent_frame(message))
            }),
            Duration::from_millis(AGENT_REQUEST_TIMEOUT_MS),
        )
    }

    /// A gateway channel with its own frame sender (tests).
    pub fn with_sender(send: Sender, timeout: Duration) -> Self {
        Self {
            send,
            timeout,
            state: Arc::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The link is registered.
    pub fn connect(&self) {
        self.lock().connected = true;
    }

    /// The link is gone: waiting requests are answered offline.
    pub fn disconnect(&self) {
        let pending: Vec<_> = {
            let mut state = self.lock();
            state.connected = false;
            state.pending.drain().collect()
        };
        for (_, waiter) in pending {
            let _ = waiter.send(offline(DROPPED));
        }
    }

    /// An `agent_response` frame (`body` absent is `null`).
    pub fn receive(&self, request_id: &str, status: u16, body: Option<Value>) {
        let waiter = self.lock().pending.remove(request_id);
        if let Some(waiter) = waiter {
            let _ = waiter.send(AgentAnswer {
                status,
                body: body.unwrap_or(Value::Null),
            });
        }
    }

    /// Ask the gateway on behalf of `session_id`, a session of this node.
    /// Never fails: every outcome is an answer.
    pub async fn request(&self, session_id: &str, op: &str, args: Value) -> AgentAnswer {
        let request_id = uuid();
        let answer = {
            let mut state = self.lock();
            if !state.connected {
                return offline(NOT_CONNECTED);
            }
            if state.pending.len() >= MAX_PENDING {
                return agent_error(
                    429,
                    "too_many_requests",
                    "Too many gateway requests are in flight on this node",
                    None,
                );
            }
            let (waiter, answer) = oneshot::channel();
            state.pending.insert(request_id.clone(), waiter);
            answer
        };
        // A request whose asker went away (its runner exited) is not kept.
        let _forget = Forget {
            state: &self.state,
            request_id: &request_id,
        };
        let frame = NodeMessage::AgentRequest {
            request_id: request_id.clone(),
            session_id: session_id.to_owned(),
            op: op.to_owned(),
            args: Some(args),
        };
        if !(self.send)(&frame) {
            return offline(NOT_CONNECTED);
        }
        match tokio::time::timeout(self.timeout, answer).await {
            Ok(Ok(answer)) => answer,
            // Only `disconnect` drops a waiter without answering it.
            Ok(Err(_)) => offline(DROPPED),
            Err(_) => agent_error(
                504,
                "gateway_timeout",
                "The gateway did not answer in time; the outcome is unknown",
                None,
            ),
        }
    }
}

struct Forget<'a> {
    state: &'a Mutex<State>,
    request_id: &'a str,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending
            .remove(self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder(accept: bool) -> (AgentGateway, Arc<Mutex<Vec<NodeMessage>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sink = sent.clone();
        let gateway = AgentGateway::with_sender(
            Arc::new(move |message: &NodeMessage| {
                sink.lock().unwrap().push(message.clone());
                accept
            }),
            Duration::from_millis(50),
        );
        (gateway, sent)
    }

    fn request_id(message: &NodeMessage) -> String {
        match message {
            NodeMessage::AgentRequest { request_id, .. } => request_id.clone(),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn answers_offline_timeout_and_the_gateway() {
        let (gateway, sent) = recorder(true);
        assert_eq!(
            gateway.request("s", "a.b", json!({})).await,
            offline(NOT_CONNECTED)
        );
        assert!(sent.lock().unwrap().is_empty());
        gateway.connect();
        let gateway = Arc::new(gateway);
        let asking = tokio::spawn({
            let gateway = gateway.clone();
            async move { gateway.request("s", "a.b", json!({ "x": 1 })).await }
        });
        while sent.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let first = sent.lock().unwrap()[0].clone();
        assert_eq!(
            serde_json::to_value(&first).unwrap()["args"],
            json!({ "x": 1 })
        );
        gateway.receive(&request_id(&first), 200, None);
        assert_eq!(
            asking.await.unwrap(),
            AgentAnswer {
                status: 200,
                body: Value::Null
            }
        );
        // No answer in time.
        let answer = gateway.request("s", "a.b", json!({})).await;
        assert_eq!(answer.status, 504);
        assert_eq!(answer.body["error"]["code"], "gateway_timeout");
        assert!(gateway.lock().pending.is_empty());
        // The link drops mid-request.
        let asking = tokio::spawn({
            let gateway = gateway.clone();
            async move { gateway.request("s", "a.b", json!({})).await }
        });
        while sent.lock().unwrap().len() < 3 {
            tokio::task::yield_now().await;
        }
        gateway.disconnect();
        assert_eq!(asking.await.unwrap(), offline(DROPPED));
    }

    #[tokio::test]
    async fn refused_frames_and_the_pending_limit() {
        let (gateway, _) = recorder(false);
        gateway.connect();
        assert_eq!(
            gateway.request("s", "a.b", json!({})).await,
            offline(NOT_CONNECTED)
        );
        let (gateway, _) = recorder(true);
        gateway.connect();
        for index in 0..MAX_PENDING {
            gateway
                .lock()
                .pending
                .insert(index.to_string(), oneshot::channel().0);
        }
        assert_eq!(gateway.request("s", "a.b", json!({})).await.status, 429);
    }
}
