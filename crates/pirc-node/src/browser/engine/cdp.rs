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
//! A crashed renderer (`Inspector.targetCrashed`) fails its session's
//! commands, pending and new, only for frame sessions (a page's own and its
//! out-of-process iframes', see [`Session::fail_on_crash`]), as Playwright's
//! `FrameSession._onTargetCrashed` marks them. A worker's session is not
//! marked: Playwright's `CRServiceWorker` takes the event as a restart, and
//! Chromium keeps the session for the restarted worker, whose requests the
//! guard must still be able to continue.
//!
//! Ported from playwright-core 1.63.0 `src/server/chromium/crConnection.ts`,
//! `src/server/pipeTransport.ts` (Apache-2.0, see
//! `crates/pirc-node/NOTICE`).

use std::collections::{HashMap, HashSet};
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

    /// The session's renderer crashed (`Inspector.targetCrashed`): what
    /// Playwright's dispatcher makes of a `crashed` protocol error (`Target
    /// crashed ` and the browser's log, none here).
    pub fn crashed() -> Self {
        Self::new("Target crashed ")
    }

    pub fn is_crashed(&self) -> bool {
        self.message == Self::crashed().message
    }

    /// Whether the command failed because its session or the connection is
    /// gone (Playwright's `isSessionClosedError`).
    pub fn is_closed(&self) -> bool {
        self.message == Self::closed().message
            || self.message.contains("Session with given id not found")
            || self.message.contains("Target closed")
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

/// A command's reply also delivered, in wire order, as an [`Event`] (see
/// [`Session::call_echo`]).
struct Echo {
    to: mpsc::UnboundedSender<Event>,
    method: String,
    tag: Value,
}

struct Pending {
    reply: Reply,
    echo: Option<Echo>,
    /// The session the command was sent to (`None`: the browser).
    session: Option<Arc<str>>,
}

impl Pending {
    /// Answer the command (and its echo, as from `session`).
    fn resolve(self, result: Result<Value, CdpError>, session: Option<Arc<str>>) {
        if let Some(echo) = self.echo {
            let params = match &result {
                Ok(result) => json!({ "tag": echo.tag, "result": result }),
                Err(error) => json!({ "tag": echo.tag, "error": error.message }),
            };
            let _ = echo.to.send(Event {
                session,
                method: echo.method,
                params,
            });
        }
        let _ = self.reply.send(result);
    }
}

#[derive(Default)]
struct State {
    pending: HashMap<u64, Pending>,
    listeners: HashMap<Option<Arc<str>>, Vec<mpsc::UnboundedSender<Event>>>,
    /// Sessions whose renderer crashed, until they detach: their commands
    /// fail at once (`CRSession._crashed`).
    crashed: HashSet<Arc<str>>,
    /// Frame sessions, which a renderer crash marks crashed (see
    /// [`Session::fail_on_crash`]), until they detach.
    frames: HashSet<Arc<str>>,
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
        echo: Option<Echo>,
    ) -> Result<Value, CdpError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(CdpError::closed());
            }
            if session.is_some_and(|session| state.crashed.contains(session)) {
                return Err(CdpError::crashed());
            }
            state.pending.insert(
                id,
                Pending {
                    reply,
                    echo,
                    session: session.cloned(),
                },
            );
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

    /// Write a command now; its reply is ignored.
    fn send(&self, session: Option<&Arc<str>>, method: &str, params: Value) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        {
            let state = self.state.lock().unwrap();
            if state.closed || session.is_some_and(|session| state.crashed.contains(session)) {
                return;
            }
        }
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session.as_ref());
        }
        let _ = self.outgoing.send(message.to_string().into_bytes());
    }

    fn fail_on_crash(&self, session: &Arc<str>) {
        let mut state = self.state.lock().unwrap();
        if !state.closed {
            state.frames.insert(session.clone());
        }
    }

    fn listen(&self, session: Option<Arc<str>>) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.listen_into(session, tx);
        rx
    }

    fn listen_into(&self, session: Option<Arc<str>>, tx: mpsc::UnboundedSender<Event>) {
        let mut state = self.state.lock().unwrap();
        if !state.closed {
            state.listeners.entry(session).or_default().push(tx);
        }
    }
}

fn dispatch(state: &Mutex<State>, message: Value) {
    let mut state = state.lock().unwrap();
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(pending) = state.pending.remove(&id) {
            let result = match message.get("error") {
                Some(error) => Err(CdpError::new(
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Protocol error"),
                )),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let session = message
                .get("sessionId")
                .and_then(Value::as_str)
                .map(Arc::from);
            pending.resolve(result, session);
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
    // A crashed renderer answers nothing more: a frame session's commands
    // fail (`_markAsCrashed`), now and from now on. A worker's session lives
    // on for the restarted worker (`CRServiceWorker`).
    if method == "Inspector.targetCrashed"
        && let Some(session) = &session
        && state.frames.contains(session)
    {
        state.crashed.insert(session.clone());
        fail_pending(&mut state, session, &CdpError::crashed());
    }
    // Chromium never answers a detached session's commands still in flight:
    // they fail as Playwright's `CRSession.dispose` fails them
    // (`Inspector.detached` comes first when the target goes away).
    if method == "Inspector.detached"
        && let Some(session) = &session
    {
        fail_pending(&mut state, session, &CdpError::closed());
    }
    // A detached session's listeners see their channel end.
    if let Some(detached) = detached {
        fail_pending(&mut state, &detached, &CdpError::closed());
        state.crashed.remove(&detached);
        state.frames.remove(&detached);
        state.listeners.remove(&Some(detached));
    }
}

/// Fail every command still waiting for `session`'s reply with `error`.
fn fail_pending(state: &mut State, session: &Arc<str>, error: &CdpError) {
    let ids: Vec<u64> = state
        .pending
        .iter()
        .filter(|(_, pending)| pending.session.as_ref() == Some(session))
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        if let Some(pending) = state.pending.remove(&id) {
            pending.resolve(Err(error.clone()), Some(session.clone()));
        }
    }
}

fn close(state: &Mutex<State>, closed: &watch::Sender<bool>) {
    let mut state = state.lock().unwrap();
    state.closed = true;
    for (_, pending) in state.pending.drain() {
        let _ = pending.reply.send(Err(CdpError::closed()));
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

    /// Whether this session's renderer crashed (its commands fail with
    /// [`CdpError::crashed`]), as the connection saw it: as soon as the
    /// event is read, before the session's listeners handle it.
    pub fn is_crashed(&self) -> bool {
        self.id
            .as_ref()
            .is_some_and(|id| self.connection.state.lock().unwrap().crashed.contains(id))
    }

    /// Send a command and wait for its result.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        self.connection
            .call(self.id.as_ref(), method, params, None)
            .await
    }

    /// Send a command now (after every command sent before it) without
    /// waiting for its reply, which is ignored: for cleanups that cannot
    /// wait (a `Drop`).
    pub fn send(&self, method: &str, params: Value) {
        self.connection.send(self.id.as_ref(), method, params);
    }

    /// [`Session::call`], with the reply also sent to `to` as an event
    /// `method` (params `{tag, result}` or `{tag, error}`, `session` the
    /// replying session's) in its place among the events read from the
    /// pipe: a listener on `to` sees it after every event Chromium sent
    /// before the reply, as Playwright's single event loop does.
    pub async fn call_echo(
        &self,
        method: &str,
        params: Value,
        to: &mpsc::UnboundedSender<Event>,
        echo_method: &str,
        tag: Value,
    ) -> Result<Value, CdpError> {
        let echo = Echo {
            to: to.clone(),
            method: echo_method.to_owned(),
            tag,
        };
        self.connection
            .call(self.id.as_ref(), method, params, Some(echo))
            .await
    }

    /// Mark this session as a frame session (a page's or an out-of-process
    /// iframe's): once its renderer crashes, its commands in flight and
    /// every later one fail with [`CdpError::crashed`] until it detaches
    /// (Playwright's `FrameSession._onTargetCrashed`). Call it before the
    /// target runs. Other sessions (workers) ignore `Inspector.targetCrashed`
    /// here.
    pub fn fail_on_crash(&self) {
        if let Some(id) = &self.id {
            self.connection.fail_on_crash(id);
        }
    }

    /// This session's events from now on, until it detaches or the
    /// connection closes.
    pub fn listen(&self) -> mpsc::UnboundedReceiver<Event> {
        self.connection.listen(self.id.clone())
    }

    /// This session's events from now on into `to`, which may collect
    /// several sessions' events: they keep the order they were read in.
    pub fn listen_into(&self, to: mpsc::UnboundedSender<Event>) {
        self.connection.listen_into(self.id.clone(), to)
    }
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("id", &self.id).finish()
    }
}

/// A fake browser for unit tests: a [`Connection`] whose commands it
/// reads and to which it sends replies and events.
#[cfg(test)]
pub(super) struct Fake {
    pub(super) connection: Arc<Connection>,
    commands: BufReader<pipe::Receiver>,
    replies: pipe::Sender,
}

#[cfg(test)]
impl Fake {
    pub(super) fn new() -> Self {
        let (commands_tx, commands_rx) = pipe::pipe().unwrap();
        let (replies_tx, replies_rx) = pipe::pipe().unwrap();
        Self {
            connection: Connection::new(commands_tx, replies_rx),
            commands: BufReader::new(commands_rx),
            replies: replies_tx,
        }
    }

    /// The next command the connection wrote (failing after 5 s).
    pub(super) async fn command(&mut self) -> Value {
        let mut buffer = Vec::new();
        let read = self.commands.read_until(0, &mut buffer);
        tokio::time::timeout(std::time::Duration::from_secs(5), read)
            .await
            .expect("a command within 5 s")
            .unwrap();
        buffer.pop();
        serde_json::from_slice(&buffer).unwrap()
    }

    pub(super) async fn send(&mut self, message: Value) {
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        self.replies.write_all(&bytes).await.unwrap();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    async fn settled<T>(task: &mut tokio::task::JoinHandle<T>) -> Option<T> {
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .ok()
            .map(Result::unwrap)
    }

    #[tokio::test]
    async fn a_detached_session_fails_its_commands_in_flight() {
        for detach in [
            json!({ "method": "Target.detachedFromTarget",
                "params": { "sessionId": "S", "targetId": "T" } }),
            json!({ "method": "Inspector.detached",
                "params": { "reason": "Render process gone." }, "sessionId": "S" }),
        ] {
            let mut fake = Fake::new();
            let page = fake.connection.session("S");
            let other = fake.connection.session("O");
            let browser = fake.connection.browser();
            let mut on_page = tokio::spawn(async move {
                page.call("Runtime.evaluate", json!({ "expression": "1" }))
                    .await
            });
            let on_other =
                tokio::spawn(async move { other.call("Runtime.enable", json!({})).await });
            let on_browser =
                tokio::spawn(async move { browser.call("Browser.getVersion", json!({})).await });
            for _ in 0..3 {
                fake.command().await;
            }
            fake.send(detach).await;
            assert_eq!(settled(&mut on_page).await, Some(Err(CdpError::closed())));
            // Other sessions' commands still wait for their replies.
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(!on_other.is_finished());
            assert!(!on_browser.is_finished());
            on_other.abort();
            on_browser.abort();
        }
    }

    #[tokio::test]
    async fn a_crashed_session_fails_its_commands() {
        let mut fake = Fake::new();
        let page = fake.connection.session("S");
        page.fail_on_crash();
        let mut pending = {
            let page = page.clone();
            tokio::spawn(async move { page.call("Runtime.evaluate", json!({})).await })
        };
        fake.command().await;
        fake.send(json!({ "method": "Inspector.targetCrashed", "params": {}, "sessionId": "S" }))
            .await;
        assert_eq!(settled(&mut pending).await, Some(Err(CdpError::crashed())));
        assert_eq!(
            page.call("Runtime.evaluate", json!({})).await,
            Err(CdpError::crashed())
        );
        // Once detached, the session id is closed, not crashed.
        fake.send(json!({ "method": "Target.detachedFromTarget",
            "params": { "sessionId": "S", "targetId": "T" } }))
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let later = tokio::spawn(async move { page.call("Runtime.enable", json!({})).await });
        assert_eq!(fake.command().await["method"], "Runtime.enable");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!later.is_finished());
    }

    /// A worker's renderer crash is a restart (`CRServiceWorker`): its
    /// session keeps sending, so the restarted worker's paused requests can
    /// still be continued.
    #[tokio::test]
    async fn a_worker_session_survives_its_renderer_crash() {
        let mut fake = Fake::new();
        let worker = fake.connection.session("W");
        let pending = {
            let worker = worker.clone();
            tokio::spawn(async move { worker.call("Runtime.evaluate", json!({})).await })
        };
        let id = fake.command().await["id"].clone();
        fake.send(json!({ "method": "Inspector.targetCrashed", "params": {}, "sessionId": "W" }))
            .await;
        let later = {
            let worker = worker.clone();
            tokio::spawn(async move {
                worker
                    .call("Fetch.continueRequest", json!({ "requestId": "R" }))
                    .await
            })
        };
        let command = fake.command().await;
        assert_eq!(command["method"], "Fetch.continueRequest");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!pending.is_finished());
        fake.send(json!({ "id": id, "result": { "ok": true }, "sessionId": "W" }))
            .await;
        fake.send(json!({ "id": command["id"], "result": {}, "sessionId": "W" }))
            .await;
        let mut pending = pending;
        let mut later = later;
        assert_eq!(settled(&mut pending).await, Some(Ok(json!({ "ok": true }))));
        assert_eq!(settled(&mut later).await, Some(Ok(json!({}))));
    }
}
