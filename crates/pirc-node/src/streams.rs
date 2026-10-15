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
//! `streamId` is ignored. A browser stream's input runs in the order it
//! arrived, one message at a time (a mouse up after its down, keys after
//! the navigation sent before them), as TS's single thread sent them.
//!
//! Locks: the stream table is held while a stream opens (so a shell that
//! exits meanwhile finds its stream and closes it; TS relied on PTY events
//! being asynchronous), never while input reaches a terminal.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use pirc_agent::tools::js::string_of;
use pirc_protocol::{NodeMessage, TerminalKind};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

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
        session_id: String,
        /// False once detached: late answers are not sent, and queued
        /// input is dropped.
        open: Arc<AtomicBool>,
        /// Input for the stream's worker, which handles it in order.
        queue: mpsc::UnboundedSender<Map<String, Value>>,
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
        session_id: String,
        queue: mpsc::UnboundedSender<Map<String, Value>>,
    },
}

/// A browser stream's worker: its input, one message at a time, in order,
/// until the stream is detached (its sender dropped).
async fn browser_inputs(
    browser: Arc<dyn crate::browser::BrowserService>,
    link: LinkSender,
    id: String,
    target: BrowserTarget,
    open: Arc<AtomicBool>,
    mut inputs: mpsc::UnboundedReceiver<Map<String, Value>>,
) {
    while let Some(message) = inputs.recv().await {
        if !open.load(Ordering::Acquire) {
            return;
        }
        let answer = browser.input(target.clone(), Value::Object(message)).await;
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
    }
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
        let target = BrowserTarget {
            session_id: session.id.clone(),
            workspace_id: workspace.id.clone(),
            root: crate::chat::session_root(&workspace, &session.id)?,
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
        let (queue, inputs) = mpsc::unbounded_channel();
        tokio::spawn(browser_inputs(
            node.browser.clone(),
            node.link.clone(),
            stream_id.to_owned(),
            target,
            open.clone(),
            inputs,
        ));
        Ok(Connection::Browser {
            session_id: session.id,
            open,
            queue,
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
                session_id, queue, ..
            }) => Target::Browser {
                session_id: session_id.clone(),
                queue: queue.clone(),
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
            Target::Browser { session_id, queue } => {
                // The action log's images are for anyone who may watch.
                if kind != Some("log_image") && !lease_holds(&node, &session_id, &message) {
                    frame(
                        &node.link,
                        stream_id,
                        json!({ "type": "error", "code": "lost_control",
                            "message": "Take control of the session to use the browser" }),
                    );
                    return;
                }
                // The worker is gone only once the stream is.
                let _ = queue.send(message);
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
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use crate::browser::{BoxFuture, BrowserService, Detach, FrameSink};

    /// Records when each input starts and ends; `"slow"` takes a while, as
    /// a navigation does.
    struct Recording(Arc<Mutex<Vec<String>>>);

    impl BrowserService for Recording {
        fn enabled(&self) -> bool {
            true
        }

        fn handle(&self, _: BrowserTarget, _: String, _: Value) -> BoxFuture<'_, ApiResult<Value>> {
            unreachable!()
        }

        fn handle_with_abort(
            &self,
            _: BrowserTarget,
            _: String,
            _: Value,
            _: tokio::sync::watch::Receiver<bool>,
        ) -> BoxFuture<'_, ApiResult<Value>> {
            unreachable!()
        }

        fn attach(&self, _: &str, _: FrameSink) -> Detach {
            unreachable!()
        }

        fn input(
            &self,
            _: BrowserTarget,
            message: Value,
        ) -> BoxFuture<'_, ApiResult<Option<Value>>> {
            let log = self.0.clone();
            Box::pin(async move {
                let name = message["type"].as_str().unwrap_or_default().to_owned();
                log.lock().unwrap().push(format!("start {name}"));
                if name == "slow" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                log.lock().unwrap().push(format!("end {name}"));
                Ok(None)
            })
        }

        fn close_session(&self, _: &str) -> BoxFuture<'_, ()> {
            unreachable!()
        }

        fn shutdown(&self) -> BoxFuture<'_, ()> {
            unreachable!()
        }
    }

    fn message(kind: &str) -> Map<String, Value> {
        json!({ "type": kind }).as_object().unwrap().clone()
    }

    /// A viewer's input used to be handled on a task per message, so a key
    /// or a mouse up could run before the navigation or the mouse down sent
    /// before it. Each message now starts once the one before has ended.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn browser_input_runs_in_order() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let open = Arc::new(AtomicBool::new(true));
        let (queue, inputs) = mpsc::unbounded_channel();
        let worker = tokio::spawn(browser_inputs(
            Arc::new(Recording(log.clone())),
            LinkSender::new(),
            "stream".to_owned(),
            BrowserTarget {
                session_id: "s".to_owned(),
                workspace_id: "w".to_owned(),
                root: PathBuf::from("/"),
            },
            open.clone(),
            inputs,
        ));
        for kind in ["slow", "down", "up", "key", "slow", "text"] {
            queue.send(message(kind)).unwrap();
        }
        drop(queue);
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .unwrap()
            .unwrap();
        let expected: Vec<String> = ["slow", "down", "up", "key", "slow", "text"]
            .iter()
            .flat_map(|kind| [format!("start {kind}"), format!("end {kind}")])
            .collect();
        assert_eq!(*log.lock().unwrap(), expected);

        // Once the stream is detached, what is still queued is dropped.
        log.lock().unwrap().clear();
        let (queue, inputs) = mpsc::unbounded_channel();
        let worker = tokio::spawn(browser_inputs(
            Arc::new(Recording(log.clone())),
            LinkSender::new(),
            "stream".to_owned(),
            BrowserTarget {
                session_id: "s".to_owned(),
                workspace_id: "w".to_owned(),
                root: PathBuf::from("/"),
            },
            open.clone(),
            inputs,
        ));
        queue.send(message("slow")).unwrap();
        queue.send(message("key")).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        open.store(false, Ordering::Release);
        drop(queue);
        worker.await.unwrap();
        assert_eq!(*log.lock().unwrap(), ["start slow", "end slow"]);
    }
}
