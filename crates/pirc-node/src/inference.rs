//! The agents' inference endpoint (`node/inference.ts`): a private HTTP/1.1
//! server on a Unix socket that relays model calls to the gateway over the
//! link. Owner: **runner**.
//!
//! The server is hand-written over `tokio::net::UnixListener` (two
//! endpoints, one client: the agent's own hand-written client in
//! `pirc_agent::remote`), so the node links no HTTP server stack.
//!
//! What to reproduce: directory `<state>/i-XXXXXX` (0700) with `socket`
//! (0600); a 32-byte hex token checked as `Bearer` in constant time; 64
//! connections, 30 s for headers and body; `GET /models` (the current
//! catalog, `no-store`; over 16 MiB: 503 `limit_exceeded`) and
//! `POST /inference` (8 MiB body, 429 beyond [`pirc_protocol::INFERENCE_MAX_REQUESTS`],
//! an [`pirc_protocol::InferenceRequest`] or 400 `invalid_request`); errors
//! as NDJSON `{"type":"model_error","code":...}`; an accepted request
//! streams NDJSON with a node-generated request id, `model_start` through
//! [`crate::link::LinkSender::send_inference`], a 10-minute deadline, and
//! `model_cancel` exactly once when the agent goes away, the deadline
//! passes or a limit is hit (never after [`InferenceServer::disconnect`] or
//! a refused start). Golden cases: the node half of
//! `inference-transport.test.ts`.

use pirc_protocol::{GatewayMessage, InferenceConfig};

use crate::services::WeakNode;

pub struct InferenceServer {
    node: WeakNode,
}

impl InferenceServer {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// Listen (before the link connects); the socket path and token for
    /// the `configure` line and the sandbox policy.
    pub async fn start(&self) -> Result<InferenceConfig, String> {
        let _ = &self.node;
        todo!("runner: startNodeInference")
    }

    /// A `model_delta`, `model_end` or `model_error` frame from the
    /// gateway (other frames are ignored).
    pub fn receive(&self, frame: GatewayMessage) {
        let _ = frame;
        todo!("runner: inference.receive")
    }

    /// The link dropped: every stream ends with `unavailable`, without
    /// `model_cancel`.
    pub fn disconnect(&self) {
        todo!("runner: inference.disconnect")
    }

    /// Node shutdown: streams end with `unavailable` and `model_cancel`;
    /// connections close; the socket directory is removed.
    pub async fn close(&self) {
        todo!("runner: inference.close")
    }
}
