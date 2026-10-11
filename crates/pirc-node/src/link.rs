//! The node link: one outbound WebSocket to the gateway's `/node/connect`
//! (`node/runtime.ts` `connect`, the link half of `startNode`).
//!
//! Layout: [`LinkSender`], what every module sends frames with, is
//! implemented here. The client itself, [`run`], is owned by **core**.
//!
//! Hooks the client calls (each owned by the module named):
//!
//! | event | calls |
//! | --- | --- |
//! | socket open | send `register` (protocol, role, workspaces with roles), start the 15 s heartbeat |
//! | `registered` | [`LinkSender::set_registered`], `agent_gateway.connect()` (runner), `mirror.connect(mirrors)` (panels), send `activity`, `models.set(models, inference)` |
//! | `models` | `models.set(models, inference)` |
//! | `model_delta`/`model_end`/`model_error` | `inference.receive(frame)` (runner) |
//! | `request` | `router.handle` in a task, then send `response` |
//! | `terminal_open`/`terminal_input`/`terminal_close` | `streams.open`/`input`/`close` (panels) |
//! | `agent_response` | `agent_gateway.receive(...)` (runner) |
//! | `memory_mirror_ack` | `mirror.receive(ledger_key, watermark)` (panels) |
//! | socket closed | [`LinkSender::close`], `agent_gateway.disconnect()`, `mirror.disconnect()`, `inference.disconnect()`, `streams.close_all()`, reconnect in 3 s |
//!
//! Frames before `registered` are dropped; a frame that is not JSON closes
//! the socket with 1007 "invalid JSON"; one that does not parse as a
//! [`pirc_protocol::GatewayMessage`] is ignored; `registration_error` is
//! only logged.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use pirc_protocol::{INFERENCE_BUFFER_MAX_BYTES, NODE_FRAME_MAX_BYTES, NodeMessage};
use tokio::sync::mpsc;

use crate::services::Node;

/// Reconnect delay after the socket closes, whatever the reason (TS).
pub const RECONNECT_MS: u64 = 3_000;
/// `heartbeat` interval while the socket is open (the gateway drops a
/// node silent for 45 s).
pub const HEARTBEAT_MS: u64 = 15_000;
/// Run and lease changes within this window go out as one `activity` frame.
pub const ACTIVITY_COALESCE_MS: u64 = 100;
/// Browser live-view frames are skipped while this much is queued on the link.
pub const BROWSER_FRAME_BACKLOG_BYTES: usize = 4 * 1024 * 1024;

/// What every module sends frames to the gateway with. Cheap to clone; the
/// frames of one sender keep their order.
///
/// Semantics of the TS socket: a frame is written only while a socket is
/// open; [`LinkSender::buffered_amount`] is `ws`'s `bufferedAmount` (bytes
/// queued but not yet written).
#[derive(Clone, Default)]
pub struct LinkSender {
    state: Arc<Mutex<LinkState>>,
}

#[derive(Default)]
struct LinkState {
    socket: Option<Socket>,
    registered: bool,
    next_id: u64,
}

struct Socket {
    id: u64,
    queue: mpsc::UnboundedSender<String>,
    buffered: Arc<AtomicUsize>,
}

/// The frames one socket's writer sends, in order (core's writer task).
pub struct LinkQueue {
    pub id: u64,
    frames: mpsc::UnboundedReceiver<String>,
    buffered: Arc<AtomicUsize>,
}

impl LinkQueue {
    /// The next frame to write; `None` once the socket was replaced or closed.
    pub async fn recv(&mut self) -> Option<String> {
        self.frames.recv().await
    }

    /// `frame` (from [`LinkQueue::recv`]) has been written to the socket.
    pub fn written(&self, frame: &str) {
        self.buffered.fetch_sub(frame.len(), Ordering::AcqRel);
    }
}

impl LinkSender {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, LinkState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A new socket is open (core): it replaces any other, unregistered
    /// until [`LinkSender::set_registered`].
    pub fn open(&self) -> LinkQueue {
        let mut state = self.lock();
        state.next_id += 1;
        let (queue, frames) = mpsc::unbounded_channel();
        let buffered = Arc::new(AtomicUsize::new(0));
        state.socket = Some(Socket {
            id: state.next_id,
            queue,
            buffered: buffered.clone(),
        });
        state.registered = false;
        LinkQueue {
            id: state.next_id,
            frames,
            buffered,
        }
    }

    /// The gateway answered `registered` on socket `id` (core).
    pub fn set_registered(&self, id: u64) {
        let mut state = self.lock();
        if state.socket.as_ref().is_some_and(|socket| socket.id == id) {
            state.registered = true;
        }
    }

    /// Socket `id` closed (core). False when another socket had already
    /// replaced it: its close is not the link's.
    pub fn close(&self, id: u64) -> bool {
        let mut state = self.lock();
        if !state.socket.as_ref().is_some_and(|socket| socket.id == id) {
            return false;
        }
        state.socket = None;
        state.registered = false;
        true
    }

    pub fn is_registered(&self) -> bool {
        let state = self.lock();
        state.registered && state.socket.is_some()
    }

    /// Bytes queued on the open socket and not yet written.
    pub fn buffered_amount(&self) -> usize {
        self.lock()
            .socket
            .as_ref()
            .map_or(0, |socket| socket.buffered.load(Ordering::Acquire))
    }

    fn queue(socket: &Socket, frame: String) -> bool {
        socket.buffered.fetch_add(frame.len(), Ordering::AcqRel);
        let len = frame.len();
        if socket.queue.send(frame).is_err() {
            socket.buffered.fetch_sub(len, Ordering::AcqRel);
            return false;
        }
        true
    }

    /// `send`: written if a socket is open, registered or not (`register`,
    /// `heartbeat`, `response`, `event`, terminal frames); dropped
    /// otherwise. Returns whether it was queued.
    pub fn send(&self, message: &NodeMessage) -> bool {
        let state = self.lock();
        let Some(socket) = &state.socket else {
            return false;
        };
        Self::queue(socket, frame(message))
    }

    /// `sendAgentFrame`: frames that need a registered link (agent
    /// requests, mirrored memory). False when there is none or the frame is
    /// larger than [`NODE_FRAME_MAX_BYTES`], so the caller can answer or
    /// retry later.
    pub fn send_agent_frame(&self, message: &NodeMessage) -> bool {
        let state = self.lock();
        let (Some(socket), true) = (&state.socket, state.registered) else {
            return false;
        };
        let frame = frame(message);
        frame.len() <= NODE_FRAME_MAX_BYTES && Self::queue(socket, frame)
    }

    /// The inference relay's `send` (`model_start`, `model_cancel`): as
    /// [`LinkSender::send_agent_frame`], and false when the frame would
    /// push the socket's backlog past [`INFERENCE_BUFFER_MAX_BYTES`].
    pub fn send_inference(&self, message: &NodeMessage) -> bool {
        let state = self.lock();
        let (Some(socket), true) = (&state.socket, state.registered) else {
            return false;
        };
        let frame = frame(message);
        frame.len() <= NODE_FRAME_MAX_BYTES
            && socket.buffered.load(Ordering::Acquire) + frame.len() <= INFERENCE_BUFFER_MAX_BYTES
            && Self::queue(socket, frame)
    }
}

fn frame(message: &NodeMessage) -> String {
    serde_json::to_string(message).expect("node frames serialize")
}

/// Connect to `config.daemon_url` and keep connected until the node closes
/// (owner: **core**). Reproduce `runtime.ts`:
///
/// - URL: `/node/connect` resolved against the daemon URL; one with
///   username, password, query or fragment is refused ("Invalid daemon
///   URL"). Headers `x-pirc-node-id` and `authorization: Bearer <token>`;
///   at most [`NODE_FRAME_MAX_BYTES`] per message; `wss://` through rustls
///   (ring) with the platform's roots.
/// - On open: `register` (protocol [`pirc_protocol::NODE_PROTOCOL_VERSION`],
///   role, the store's workspaces of this node with `roles` from
///   `pirc_agent::roles` for directory workspaces, left out when they fail
///   to load), then `heartbeat` every [`HEARTBEAT_MS`].
/// - Events: every [`crate::events::EventHub`] event goes out as `event`
///   while registered (none are replayed after a reconnect).
/// - Activity: after `registered`, and [`ACTIVITY_COALESCE_MS`] after the
///   first `node.activity` notification (one timer, not reset), send
///   `activity` with every open run (`store.active_runs()`) and every
///   write-lease holder (`writes.holders()`, `writeLease: true`).
/// - The hooks of the module table above; on close, reconnect after
///   [`RECONNECT_MS`] unless the node is closing (4426 is logged as a
///   protocol mismatch first).
pub async fn run(node: Node) {
    let _ = node;
    todo!("core: the node link client")
}

#[cfg(test)]
mod tests {
    use pirc_protocol::{NodeRole, Registration};

    use super::*;

    fn register() -> NodeMessage {
        NodeMessage::Register(Registration {
            role: NodeRole::Node,
            protocol: Some(9),
            workspaces: Vec::new(),
        })
    }

    #[tokio::test]
    async fn frames_follow_the_socket() {
        let link = LinkSender::new();
        assert!(!link.send(&NodeMessage::Heartbeat));
        let mut first = link.open();
        assert!(link.send(&register()));
        assert!(!link.send_agent_frame(&NodeMessage::Heartbeat));
        assert!(!link.send_inference(&NodeMessage::Heartbeat));
        link.set_registered(first.id);
        assert!(link.is_registered());
        assert!(link.send_agent_frame(&NodeMessage::Heartbeat));
        assert_eq!(link.buffered_amount(), 82);
        let frame = first.recv().await.unwrap();
        assert!(frame.starts_with(r#"{"type":"register""#));
        first.written(&frame);
        assert_eq!(first.recv().await.unwrap(), r#"{"type":"heartbeat"}"#);
        first.written(r#"{"type":"heartbeat"}"#);
        assert_eq!(link.buffered_amount(), 0);
        // A new socket replaces the first: its close is not the link's.
        let second = link.open();
        assert!(!link.is_registered());
        assert!(first.recv().await.is_none());
        assert!(!link.close(first.id));
        assert!(link.close(second.id));
        assert!(!link.send(&NodeMessage::Heartbeat));
    }

    #[test]
    fn inference_respects_the_backlog() {
        let link = LinkSender::new();
        let queue = link.open();
        link.set_registered(queue.id);
        let big = NodeMessage::ModelCancel {
            request_id: "x".repeat(INFERENCE_BUFFER_MAX_BYTES - 40),
        };
        assert!(link.send_inference(&big));
        assert!(!link.send_inference(&NodeMessage::ModelCancel {
            request_id: "y".repeat(100)
        }));
        let huge = NodeMessage::ModelCancel {
            request_id: "z".repeat(NODE_FRAME_MAX_BYTES),
        };
        assert!(!link.send_agent_frame(&huge));
        drop(queue);
        assert!(!link.send(&NodeMessage::Heartbeat));
    }
}
