//! The Chrome DevTools Protocol connection: one per Chromium, over the pipe
//! Playwright also uses (`--remote-debugging-pipe`: commands on the
//! browser's fd 3, replies and events on its fd 4, each message one JSON
//! text ended by a NUL byte). No port is opened, so nothing else on the host
//! (agents included) can drive the browser.
//!
//! Flat sessions (`Target.setAutoAttach {flatten: true}`): a command or
//! event for a target carries its `sessionId`; [`Session`] is one of them
//! (or the browser itself). Events are delivered per session to every
//! listener, in order, on unbounded channels (as Playwright's event
//! emitters do).
//!
//! Layout: implemented here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::pipe;
use tokio::sync::{mpsc, oneshot, watch};

/// A failed command: CDP's error message, or why the connection is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CdpError {
    pub message: String,
}

impl CdpError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The connection (or the session's target) is gone.
    pub fn closed() -> Self {
        Self::new("Target page, context or browser has been closed")
    }
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CdpError {}

/// An event: `method` and `params`, for `session` (`None`: the browser).
#[derive(Clone, Debug)]
pub struct Event {
    pub session: Option<Arc<str>>,
    pub method: String,
    pub params: Value,
}

type Reply = oneshot::Sender<Result<Value, CdpError>>;

#[derive(Default)]
struct State {
    pending: HashMap<u64, Reply>,
    listeners: HashMap<Option<Arc<str>>, Vec<mpsc::UnboundedSender<Event>>>,
    closed: bool,
}

/// The browser-wide connection.
pub struct Connection {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    state: Arc<Mutex<State>>,
    next: AtomicU64,
    closed: watch::Receiver<bool>,
}

impl Connection {
    /// Speak CDP over the browser's pipe ends: `commands` is its fd 3 (we
    /// write), `replies` its fd 4 (we read).
    pub fn new(commands: pipe::Sender, replies: pipe::Receiver) -> Arc<Self> {
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let state: Arc<Mutex<State>> = Arc::default();
        let (closed_tx, closed) = watch::channel(false);
        let closed_tx = Arc::new(closed_tx);
        {
            let state = state.clone();
            let closed_tx = closed_tx.clone();
            let mut commands = commands;
            tokio::spawn(async move {
                while let Some(mut message) = queue.recv().await {
                    message.push(0);
                    if commands.write_all(&message).await.is_err() {
                        break;
                    }
                }
                close(&state, &closed_tx);
            });
        }
        {
            let state = state.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(replies);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(0, &mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if buffer.last() == Some(&0) {
                        buffer.pop();
                    }
                    let Ok(message) = serde_json::from_slice::<Value>(&buffer) else {
                        continue;
                    };
                    dispatch(&state, message);
                }
                close(&state, &closed_tx);
            });
        }
        Arc::new(Self {
            outgoing,
            state,
            next: AtomicU64::new(1),
            closed,
        })
    }

    /// The browser itself.
    pub fn browser(self: &Arc<Self>) -> Session {
        Session {
            connection: self.clone(),
            id: None,
        }
    }

    /// A flat session by id (from `Target.attachedToTarget`).
    pub fn session(self: &Arc<Self>, id: &str) -> Session {
        Session {
            connection: self.clone(),
            id: Some(Arc::from(id)),
        }
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Resolves once the connection is gone (the browser exited or closed
    /// its pipe).
    pub async fn wait_closed(&self) {
        let mut closed = self.closed.clone();
        let _ = closed.wait_for(|closed| *closed).await;
    }

    async fn call(
        &self,
        session: Option<&Arc<str>>,
        method: &str,
        params: Value,
    ) -> Result<Value, CdpError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(CdpError::closed());
            }
            state.pending.insert(id, reply);
        }
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session.as_ref());
        }
        if self
            .outgoing
            .send(message.to_string().into_bytes())
            .is_err()
        {
            self.state.lock().unwrap().pending.remove(&id);
            return Err(CdpError::closed());
        }
        answer.await.unwrap_or_else(|_| Err(CdpError::closed()))
    }

    fn listen(&self, session: Option<Arc<str>>) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut state = self.state.lock().unwrap();
        if !state.closed {
            state.listeners.entry(session).or_default().push(tx);
        }
        rx
    }
}

fn dispatch(state: &Mutex<State>, message: Value) {
    let mut state = state.lock().unwrap();
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(reply) = state.pending.remove(&id) {
            let result = match message.get("error") {
                Some(error) => Err(CdpError::new(
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Protocol error"),
                )),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = reply.send(result);
        }
        return;
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let session: Option<Arc<str>> = message
        .get("sessionId")
        .and_then(Value::as_str)
        .map(Arc::from);
    let event = Event {
        session: session.clone(),
        method: method.to_owned(),
        params: message.get("params").cloned().unwrap_or(Value::Null),
    };
    let detached = (method == "Target.detachedFromTarget")
        .then(|| event.params["sessionId"].as_str().map(Arc::<str>::from))
        .flatten();
    if let Some(listeners) = state.listeners.get_mut(&session) {
        listeners.retain(|listener| listener.send(event.clone()).is_ok());
    }
    // A detached session's listeners see their channel end.
    if let Some(detached) = detached {
        state.listeners.remove(&Some(detached));
    }
}

fn close(state: &Mutex<State>, closed: &watch::Sender<bool>) {
    let mut state = state.lock().unwrap();
    state.closed = true;
    for (_, reply) in state.pending.drain() {
        let _ = reply.send(Err(CdpError::closed()));
    }
    state.listeners.clear();
    drop(state);
    let _ = closed.send(true);
}

/// One CDP session (a target attached in flat mode), or the browser.
#[derive(Clone)]
pub struct Session {
    connection: Arc<Connection>,
    id: Option<Arc<str>>,
}

impl Session {
    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    pub fn connection(&self) -> &Arc<Connection> {
        &self.connection
    }

    /// Send a command and wait for its result.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        self.connection.call(self.id.as_ref(), method, params).await
    }

    /// This session's events from now on, until it detaches or the
    /// connection closes.
    pub fn listen(&self) -> mpsc::UnboundedReceiver<Event> {
        self.connection.listen(self.id.clone())
    }
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("id", &self.id).finish()
    }
}
