//! The terminal and browser streams multiplexed on the link
//! (`node/runtime.ts` `openTerminal`, `terminalStreams` and
//! `browserStreams` of `node/panel-routes.ts`). Owner: **panels**.
//!
//! `terminal_open` attaches a stream: the browser kind goes to
//! [`crate::browser::BrowserService`] (unavailable until M8: 4403 "The
//! browser is not available on this node"), the terminal kind to
//! [`crate::terminals::Terminals`]. Frames go out as `terminal_frame`
//! through `LinkSender::send` (browser `frame` frames are dropped while the
//! link's backlog exceeds `link::BROWSER_FRAME_BACKLOG_BYTES`). A failed
//! open is `terminal_closed` with 4401/4403/4404 by the error's status
//! (else 4400) and the message's first 120 UTF-16 units; a shell's exit is
//! the `exit` frame then `terminal_closed` 1000 "terminal exited". Input is
//! checked against the control lease per message. An already open
//! `streamId` is ignored.
//!
//! Locks: the stream table is held while a stream opens (so a shell that
//! exits meanwhile finds its stream and closes it; TS relied on PTY events
//! being asynchronous), never while input reaches a terminal.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use pirc_agent::tools::js::string_of;
use pirc_protocol::{NodeMessage, TerminalKind};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::browser::{BrowserTarget, Detach, FrameSink};
use crate::error::{ApiError, ApiResult};
use crate::link::{BROWSER_FRAME_BACKLOG_BYTES, LinkSender};
use crate::services::{Node, WeakNode};
use crate::store::Store as _;
use crate::terminals::{Listener, TerminalEvent};

pub struct Streams {
    node: WeakNode,
    streams: Mutex<HashMap<String, Connection>>,
}

enum Connection {
    Terminal {
        session_id: String,
        terminal_id: String,
        listener: u64,
    },
    Browser {
        input: UnboundedSender<Map<String, Value>>,
        target: BrowserTarget,
        /// False once detached: late answers are not sent.
        open: Arc<AtomicBool>,
        detach: Option<Detach>,
    },
}

/// What input needs of a connection, taken out of the table's lock.
enum Target {
    Terminal {
        session_id: String,
        terminal_id: String,
    },
    Browser {
        input: UnboundedSender<Map<String, Value>>,
        target: BrowserTarget,
        open: Arc<AtomicBool>,
    },
}

/// One worker per viewer preserves input order across awaited CDP actions.
/// Closing the viewer discards queued actions; observational log reads bypass it.
fn browser_input_queue<F, Fut>(
    open: Arc<AtomicBool>,
    mut execute: F,
) -> UnboundedSender<Map<String, Value>>
where
    F: FnMut(Map<String, Value>) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    let (sender, mut receiver) = unbounded_channel();
    tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            if !open.load(Ordering::Acquire) {
                break;
            }
            execute(message).await;
        }
    });
    sender
}

fn frame(link: &LinkSender, stream_id: &str, frame: Value) {
    link.send(&NodeMessage::TerminalFrame {
        stream_id: stream_id.to_owned(),
        frame: Some(frame),
    });
}

/// The close code of a failed open, by the error's status.
fn close_code(status: u16) -> i64 {
    match status {
        401 => 4401,
        403 => 4403,
        404 => 4404,
        _ => 4400,
    }
}

/// `String(message.clientId ?? '')` and `Number(message.generation)`
/// checked against the lease; a generation that is not an integer never
/// matches.
fn lease_holds(node: &Node, session_id: &str, message: &Map<String, Value>) -> bool {
    // A stream may outlive a catalog reload. Never let an existing lease
    // keep terminal/browser mutations alive after its mode is removed.
    if node.session_mode(session_id).is_err() {
        return false;
    }
    let client_id = match message.get("clientId") {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_of(value),
    };
    let generation = crate::panels::js_number(message.get("generation"));
    if !generation.is_finite() || generation.fract() != 0.0 {
        return false;
    }
    node.db
        .lock()
        .validate_lease(session_id, &client_id, generation as i64)
        .is_ok()
}

impl Streams {
    pub fn new(node: WeakNode) -> Self {
        Self {
            node,
            streams: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Connection>> {
        self.streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `terminal_open` (kind absent: terminal).
    pub fn open(
        &self,
        stream_id: &str,
        kind: TerminalKind,
        user: &str,
        session_id: &str,
        terminal_id: &str,
    ) {
        let Some(node) = self.node.upgrade() else {
            return;
        };
        let mut streams = self.lock();
        if streams.contains_key(stream_id) {
            return;
        }
        let opened = match kind {
            TerminalKind::Browser => self.open_browser(&node, stream_id, user, session_id),
            TerminalKind::Terminal => {
                self.open_terminal(&node, stream_id, user, session_id, terminal_id)
            }
        };
        match opened {
            Ok(connection) => {
                streams.insert(stream_id.to_owned(), connection);
            }
            Err(error) => {
                node.link.send(&NodeMessage::TerminalClosed {
                    stream_id: stream_id.to_owned(),
                    code: close_code(error.status),
                    reason: crate::util::head16(&error.message, 120).to_owned(),
                });
            }
        }
    }

    /// Anyone who may view the session may watch; input needs the lease.
    fn open_terminal(
        &self,
        node: &Node,
        stream_id: &str,
        user: &str,
        session_id: &str,
        terminal_id: &str,
    ) -> ApiResult<Connection> {
        if !node.config.terminals_enabled {
            return Err(ApiError::forbidden("Terminals are disabled on this node"));
        }
        if !node.config.allowed_users.contains(user) {
            return Err(ApiError::forbidden("User is not allowed on this node"));
        }
        let session = node.db.lock().claim_session(session_id, user, false)?;
        let link = node.link.clone();
        let weak = self.node.clone();
        let id = stream_id.to_owned();
        let listener: Listener = Arc::new(move |event: &TerminalEvent| match event {
            TerminalEvent::Output(data) => {
                frame(&link, &id, json!({ "type": "output", "data": data }));
            }
            TerminalEvent::Exit(code) => {
                frame(&link, &id, json!({ "type": "exit", "exitCode": code }));
                if let Some(node) = weak.upgrade() {
                    node.streams.terminal_exited(&id);
                }
            }
        });
        let link = node.link.clone();
        let attached =
            node.terminals
                .attach(&session.id, terminal_id, listener, |info, replay| {
                    frame(
                        &link,
                        stream_id,
                        json!({ "type": "ready", "terminal": info, "replay": replay }),
                    );
                    if info.exited {
                        frame(
                            &link,
                            stream_id,
                            json!({ "type": "exit", "exitCode": info.exit_code }),
                        );
                    }
                })?;
        Ok(Connection::Terminal {
            session_id: session.id,
            terminal_id: terminal_id.to_owned(),
            listener: attached.listener,
        })
    }

    /// The shell exited: end the relayed stream.
    fn terminal_exited(&self, stream_id: &str) {
        let Some(connection) = self.lock().remove(stream_id) else {
            return;
        };
        self.detach(connection);
        if let Some(node) = self.node.upgrade() {
            node.link.send(&NodeMessage::TerminalClosed {
                stream_id: stream_id.to_owned(),
                code: 1000,
                reason: "terminal exited".to_owned(),
            });
        }
    }

    fn open_browser(
        &self,
        node: &Node,
        stream_id: &str,
        user: &str,
        session_id: &str,
    ) -> ApiResult<Connection> {
        if !node.browser.enabled() {
            return Err(crate::browser::unavailable());
        }
        if !node.config.allowed_users.contains(user) {
            return Err(ApiError::forbidden("User is not allowed on this node"));
        }
        let (session, workspace) = {
            let db = node.db.lock();
            let session = db.claim_session(session_id, user, false)?;
            let workspace = db.get_workspace(&session.workspace_id)?;
            (session, workspace)
        };
        let mode = node.workspace_mode(&workspace)?;
        let target = BrowserTarget {
            session_id: session.id.clone(),
            workspace_id: workspace.id.clone(),
            root: crate::util::session_root(&workspace, &session.id, &mode)?,
        };
        let link = node.link.clone();
        let id = stream_id.to_owned();
        let sink: FrameSink = Arc::new(move |value: Value| {
            // Live frames are disposable: dropped while the link is backed up.
            if value.get("type").and_then(Value::as_str) == Some("frame")
                && link.buffered_amount() > BROWSER_FRAME_BACKLOG_BYTES
            {
                return;
            }
            frame(&link, &id, value);
        });
        let detach = node.browser.attach(&session.id, sink);
        let open = Arc::new(AtomicBool::new(true));
        let weak = self.node.clone();
        let worker_open = open.clone();
        let worker_target = target.clone();
        let session_id = session.id;
        let id = stream_id.to_owned();
        let input = browser_input_queue(open.clone(), move |message| {
            let weak = weak.clone();
            let open = worker_open.clone();
            let target = worker_target.clone();
            let session_id = session_id.clone();
            let id = id.clone();
            async move {
                let Some(node) = weak.upgrade() else { return };
                // Control can change while an earlier input is in flight.
                if !lease_holds(&node, &session_id, &message) {
                    frame(
                        &node.link,
                        &id,
                        json!({ "type": "error", "code": "lost_control",
                        "message": "Take control of the session to use the browser" }),
                    );
                    return;
                }
                let answer = node.browser.input(target, Value::Object(message)).await;
                if !open.load(Ordering::Acquire) {
                    return;
                }
                match answer {
                    Ok(Some(value)) => frame(&node.link, &id, value),
                    Ok(None) => {}
                    Err(error) => frame(
                        &node.link,
                        &id,
                        json!({ "type": "error", "code": error.code,
                        "message": crate::util::head16(&error.message, 500) }),
                    ),
                }
            }
        });
        Ok(Connection::Browser {
            input,
            target,
            open,
            detach: Some(detach),
        })
    }

    /// `terminal_input`: the browser's message, raw.
    pub fn input(&self, stream_id: &str, message: Option<Value>) {
        let Some(node) = self.node.upgrade() else {
            return;
        };
        let target = match self.lock().get(stream_id) {
            None => return,
            Some(Connection::Terminal {
                session_id,
                terminal_id,
                ..
            }) => Target::Terminal {
                session_id: session_id.clone(),
                terminal_id: terminal_id.clone(),
            },
            Some(Connection::Browser {
                input,
                target,
                open,
                ..
            }) => Target::Browser {
                input: input.clone(),
                target: target.clone(),
                open: open.clone(),
            },
        };
        let message = match message {
            Some(Value::Object(message)) => message,
            _ => Map::new(),
        };
        let kind = message.get("type").and_then(Value::as_str);
        match target {
            Target::Terminal {
                session_id,
                terminal_id,
            } => {
                if !lease_holds(&node, &session_id, &message) {
                    frame(
                        &node.link,
                        stream_id,
                        json!({ "type": "error", "code": "lost_control",
                            "message": "Take control to type here" }),
                    );
                    return;
                }
                let result = match (kind, message.get("data")) {
                    (Some("input"), Some(Value::String(data))) => {
                        node.terminals.input(&session_id, &terminal_id, data)
                    }
                    (Some("resize"), _) => node.terminals.resize(
                        &session_id,
                        &terminal_id,
                        crate::panels::js_number(message.get("cols")),
                        crate::panels::js_number(message.get("rows")),
                    ),
                    // Anything else is ignored.
                    _ => Ok(()),
                };
                if let Err(error) = result {
                    frame(
                        &node.link,
                        stream_id,
                        json!({ "type": "error", "code": "not_found", "message": error.message }),
                    );
                }
            }
            Target::Browser {
                input,
                target,
                open,
            } => {
                if kind != Some("log_image") {
                    let _ = input.send(message);
                    return;
                }
                // Log image reads remain available while mutating input is busy.
                let browser = node.browser.clone();
                let link = node.link.clone();
                let id = stream_id.to_owned();
                tokio::spawn(async move {
                    let answer = browser.input(target, Value::Object(message)).await;
                    if !open.load(Ordering::Acquire) {
                        return;
                    }
                    match answer {
                        Ok(Some(value)) => frame(&link, &id, value),
                        Ok(None) => {}
                        Err(error) => frame(
                            &link,
                            &id,
                            json!({ "type": "error", "code": error.code,
                                "message": crate::util::head16(&error.message, 500) }),
                        ),
                    }
                });
            }
        }
    }

    fn detach(&self, connection: Connection) {
        match connection {
            Connection::Terminal {
                terminal_id,
                listener,
                ..
            } => {
                if let Some(node) = self.node.upgrade() {
                    node.terminals.detach(&terminal_id, listener);
                }
            }
            Connection::Browser { open, detach, .. } => {
                open.store(false, Ordering::Release);
                if let Some(detach) = detach {
                    detach();
                }
            }
        }
    }

    /// `terminal_close`: detach the stream (the terminal lives on).
    pub fn close(&self, stream_id: &str) {
        let connection = self.lock().remove(stream_id);
        if let Some(connection) = connection {
            self.detach(connection);
        }
    }

    /// The link dropped or the node closes: detach every stream.
    pub fn close_all(&self) {
        let connections: Vec<Connection> = self.lock().drain().map(|(_, c)| c).collect();
        for connection in connections {
            self.detach(connection);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{Semaphore, mpsc};

    #[tokio::test]
    async fn browser_actions_stay_ordered_while_first_action_waits() {
        let open = Arc::new(AtomicBool::new(true));
        let gate = Arc::new(Semaphore::new(0));
        let (seen, mut events) = mpsc::unbounded_channel();
        let queue = browser_input_queue(open, {
            let gate = gate.clone();
            move |message| {
                let seen = seen.clone();
                let gate = gate.clone();
                async move {
                    let number = message["n"].as_u64().unwrap();
                    seen.send((number, "start")).unwrap();
                    if number == 1 {
                        gate.acquire().await.unwrap().forget();
                    }
                    seen.send((number, "end")).unwrap();
                }
            }
        });
        queue
            .send(json!({"n":1}).as_object().unwrap().clone())
            .unwrap();
        queue
            .send(json!({"n":2}).as_object().unwrap().clone())
            .unwrap();
        assert_eq!(events.recv().await, Some((1, "start")));
        tokio::task::yield_now().await;
        assert!(events.try_recv().is_err());
        gate.add_permits(1);
        assert_eq!(events.recv().await, Some((1, "end")));
        assert_eq!(events.recv().await, Some((2, "start")));
        assert_eq!(events.recv().await, Some((2, "end")));
    }

    #[tokio::test]
    async fn closed_viewer_discards_actions_queued_behind_in_flight_input() {
        let open = Arc::new(AtomicBool::new(true));
        let gate = Arc::new(Semaphore::new(0));
        let (seen, mut events) = mpsc::unbounded_channel();
        let queue = browser_input_queue(open.clone(), {
            let gate = gate.clone();
            move |message| {
                let seen = seen.clone();
                let gate = gate.clone();
                async move {
                    seen.send(message["n"].clone()).unwrap();
                    gate.acquire().await.unwrap().forget();
                }
            }
        });
        queue
            .send(json!({"n":1}).as_object().unwrap().clone())
            .unwrap();
        queue
            .send(json!({"n":2}).as_object().unwrap().clone())
            .unwrap();
        assert_eq!(events.recv().await, Some(json!(1)));
        open.store(false, Ordering::Release);
        gate.add_permits(1);
        drop(queue);
        assert_eq!(events.recv().await, None);
    }
}
