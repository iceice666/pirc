//! Requests the agent makes of its node over stdout, answered on stdin
//! (`agent/pending-requests.ts`, `gateway.ts`, `write-lease.ts`,
//! `sandbox-channel.ts`, `browser-channel.ts`): request lifetimes,
//! timeouts, cancellation and the per-channel response decoding.
//!
//! As in TS each channel is one per process ([`node_channels`]), writing to
//! stdout; `serve_rpc` routes the `*_response` lines here. Team children
//! forward write leases and sandbox requests to their parent instead
//! (`crate::features::team::channel`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::LocalBoxFuture;
use crate::rpc::Write;
use crate::signal::AbortSignal;
use crate::tools::AcquireWrite;

/// The message of a signal's default abort reason (`signal.throwIfAborted()`
/// with an `AbortController.abort()` that gave no reason, as Bun words it).
pub const PRE_ABORTED: &str = "The operation was aborted.";
/// The node answers within 30 s (or reports the gateway offline); this only
/// guards a lost reply (`LOST_REPLY_MS`).
pub const GATEWAY_LOST_REPLY_MS: u64 = 45_000;

/// A failed side-channel request.
#[derive(Clone, Debug, PartialEq)]
pub enum ChannelError {
    /// A plain `Error` (aborted gateway requests, the write broker, an
    /// already aborted signal).
    Plain(String),
    /// A channel's own error class (`GatewayError`, `BrowserError`,
    /// `SandboxRequestError`); `status` and `details` are the gateway's.
    Coded {
        code: String,
        message: String,
        status: Option<f64>,
        details: Option<Box<Value>>,
    },
}

impl ChannelError {
    pub fn coded(code: &str, message: &str) -> Self {
        Self::Coded {
            code: code.to_owned(),
            message: message.to_owned(),
            status: None,
            details: None,
        }
    }

    /// `error.message`.
    pub fn message(&self) -> &str {
        match self {
            Self::Plain(message) | Self::Coded { message, .. } => message,
        }
    }

    /// `error.code` of a channel error.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Plain(_) => None,
            Self::Coded { code, .. } => Some(code),
        }
    }
}

impl fmt::Display for ChannelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

/// Tells the node a request is abandoned.
pub type Cancel = Rc<dyn Fn(&str)>;
type Timer = (Pin<Box<tokio::time::Sleep>>, fn() -> ChannelError);
type Settler<T> = oneshot::Sender<Result<T, ChannelError>>;
type Settlers<T> = Rc<RefCell<HashMap<String, Settler<T>>>>;

/// How a request ends besides its answer.
pub struct RequestOptions {
    /// What an abort rejects with.
    pub abort_error: fn() -> ChannelError,
    /// Tell the node the request is abandoned (best effort).
    pub cancel: Option<Cancel>,
    /// A lost-reply timer and its error.
    pub timeout: Option<(Duration, fn() -> ChannelError)>,
}

/// `PendingRequests`: only request lifetimes live here; framing, response
/// decoding and errors belong to the channels.
pub struct PendingRequests<T> {
    pending: Settlers<T>,
}

impl<T: 'static> Default for PendingRequests<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: 'static> PendingRequests<T> {
    pub fn new() -> Self {
        Self {
            pending: Rc::new(RefCell::new(HashMap::new())),
        }
    }

    /// Register a request under a fresh id, then `send` it. As in TS this
    /// happens at once, not when the result is first polled. An already
    /// aborted `signal` fails without sending.
    pub fn request(
        &self,
        signal: Option<&AbortSignal>,
        options: RequestOptions,
        send: impl FnOnce(&str),
    ) -> PendingRequest<T> {
        if signal.is_some_and(AbortSignal::aborted) {
            return PendingRequest::ready(Err(ChannelError::Plain(PRE_ABORTED.to_owned())));
        }
        let id = crate::random_uuid();
        let (sender, receiver) = oneshot::channel();
        self.pending.borrow_mut().insert(id.clone(), sender);
        if let Some(signal) = signal {
            let pending = self.pending.clone();
            let cancel = options.cancel.clone();
            let abort_error = options.abort_error;
            let request = id.clone();
            signal.on_abort(move || {
                let settler = pending.borrow_mut().remove(&request);
                if let Some(settler) = settler {
                    let _ = settler.send(Err(abort_error()));
                    if let Some(cancel) = cancel {
                        cancel(&request);
                    }
                }
            });
        }
        let timeout = options
            .timeout
            .map(|(after, error)| (Box::pin(tokio::time::sleep(after)), error));
        send(&id);
        PendingRequest {
            state: Some(Waiting {
                id,
                receiver,
                pending: self.pending.clone(),
                cancel: options.cancel,
                timeout,
            }),
            ready: None,
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.pending.borrow().contains_key(id)
    }

    /// Settle a request with its answer; `false` when it already ended.
    pub fn resolve(&self, id: &str, value: T) -> bool {
        self.settle(id, Ok(value))
    }

    pub fn reject(&self, id: &str, error: ChannelError) -> bool {
        self.settle(id, Err(error))
    }

    fn settle(&self, id: &str, result: Result<T, ChannelError>) -> bool {
        let settler = self.pending.borrow_mut().remove(id);
        match settler {
            Some(settler) => {
                let _ = settler.send(result);
                true
            }
            None => false,
        }
    }

    /// `closeAll`: reject every pending request, without cancellations.
    pub fn close_all(&self, error: impl Fn() -> ChannelError) {
        let settlers: Vec<_> = self.pending.borrow_mut().drain().collect();
        for (_, settler) in settlers {
            let _ = settler.send(Err(error()));
        }
    }
}

struct Waiting<T> {
    id: String,
    receiver: oneshot::Receiver<Result<T, ChannelError>>,
    pending: Settlers<T>,
    cancel: Option<Cancel>,
    timeout: Option<Timer>,
}

/// One request's outcome. Dropping it before it ends abandons the request:
/// its entry is removed and the node told (the channel's `cancel`), as an
/// abort would.
pub struct PendingRequest<T> {
    state: Option<Waiting<T>>,
    ready: Option<Result<T, ChannelError>>,
}

impl<T> PendingRequest<T> {
    fn ready(result: Result<T, ChannelError>) -> Self {
        Self {
            state: None,
            ready: Some(result),
        }
    }

    /// The request id (`None` when it was never sent).
    pub fn id(&self) -> Option<&str> {
        self.state.as_ref().map(|state| state.id.as_str())
    }
}

impl<T> Unpin for PendingRequest<T> {}

impl<T> Future for PendingRequest<T> {
    type Output = Result<T, ChannelError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(result) = self.ready.take() {
            return Poll::Ready(result);
        }
        let Some(state) = self.state.as_mut() else {
            panic!("PendingRequest polled after completion");
        };
        if let Poll::Ready(result) = Pin::new(&mut state.receiver).poll(cx) {
            self.state = None;
            return Poll::Ready(result.unwrap_or_else(|_| {
                Err(ChannelError::Plain("The request was dropped".to_owned()))
            }));
        }
        if let Some((sleep, error)) = state.timeout.as_mut()
            && sleep.as_mut().poll(cx).is_ready()
        {
            let error = *error;
            let removed = state.pending.borrow_mut().remove(&state.id).is_some();
            if removed {
                self.state = None;
                return Poll::Ready(Err(error()));
            }
            state.timeout = None;
        }
        Poll::Pending
    }
}

impl<T> Drop for PendingRequest<T> {
    fn drop(&mut self) {
        if let Some(state) = self.state.take() {
            let removed = state.pending.borrow_mut().remove(&state.id).is_some();
            if removed && let Some(cancel) = state.cancel {
                cancel(&state.id);
            }
        }
    }
}

fn id_of(message: &Value) -> Option<&str> {
    message.get("id").and_then(Value::as_str)
}

fn string_or(value: Option<&Value>, fallback: &str) -> String {
    value.and_then(Value::as_str).unwrap_or(fallback).to_owned()
}

/// `message.error ?? {}` as an object to read fields from.
fn error_object(message: &Value) -> Option<&Map<String, Value>> {
    message.get("error").and_then(Value::as_object)
}

/// `NodeGateway`: `gateway_request` / `gateway_response`.
pub struct NodeGateway {
    pending: PendingRequests<Value>,
    write: Write,
    lost_reply: Duration,
}

impl NodeGateway {
    pub fn new(write: Write) -> Self {
        Self::with_lost_reply(write, GATEWAY_LOST_REPLY_MS)
    }

    pub fn with_lost_reply(write: Write, lost_reply_ms: u64) -> Self {
        Self {
            pending: PendingRequests::new(),
            write,
            lost_reply: Duration::from_millis(lost_reply_ms),
        }
    }

    /// Run a gateway operation: its result, or a `GatewayError`.
    pub fn request(
        &self,
        op: &str,
        args: Map<String, Value>,
        signal: Option<&AbortSignal>,
    ) -> PendingRequest<Value> {
        let options = RequestOptions {
            abort_error: || ChannelError::Plain("Aborted".to_owned()),
            cancel: None,
            timeout: Some((self.lost_reply, || {
                ChannelError::coded("gateway_timeout", "The gateway did not answer")
            })),
        };
        self.pending.request(signal, options, |id| {
            (self.write)(json!({ "type": "gateway_request", "id": id, "op": op, "args": args }));
        })
    }

    pub fn respond(&self, message: &Value) {
        let Some(id) = id_of(message).filter(|id| self.pending.contains(id)) else {
            return;
        };
        if message.get("ok") == Some(&Value::Bool(true)) {
            let result = message.get("result").cloned().unwrap_or(Value::Null);
            self.pending.resolve(id, result);
            return;
        }
        let error = error_object(message);
        let field = |name: &str| error.and_then(|error| error.get(name));
        self.pending.reject(
            id,
            ChannelError::Coded {
                code: string_or(field("code"), "internal_error"),
                message: string_or(field("message"), "The gateway request failed"),
                status: field("status").and_then(Value::as_f64),
                details: field("details").cloned().map(Box::new),
            },
        );
    }

    pub fn close_all(&self) {
        self.pending
            .close_all(|| ChannelError::coded("gateway_closed", "The gateway channel closed"));
    }
}

/// `NodeWriteBroker`: `write_lease_request` / `write_lease_response`.
pub struct NodeWriteBroker {
    pending: PendingRequests<()>,
    write: Write,
}

impl NodeWriteBroker {
    pub fn new(write: Write) -> Self {
        Self {
            pending: PendingRequests::new(),
            write,
        }
    }

    /// Ask for the lease on `root`.
    pub fn acquire(&self, root: &str, signal: Option<&AbortSignal>) -> PendingRequest<()> {
        let options = RequestOptions {
            abort_error: || ChannelError::Plain("Aborted".to_owned()),
            cancel: None,
            timeout: None,
        };
        self.pending.request(signal, options, |id| {
            (self.write)(json!({ "type": "write_lease_request", "id": id, "path": root }));
        })
    }

    pub fn respond(&self, message: &Value) {
        let Some(id) = id_of(message).filter(|id| self.pending.contains(id)) else {
            return;
        };
        if message.get("granted") == Some(&Value::Bool(true)) {
            self.pending.resolve(id, ());
        } else {
            let error = string_or(message.get("error"), "Write lease refused");
            self.pending.reject(id, ChannelError::Plain(error));
        }
    }

    pub fn close_all(&self) {
        self.pending
            .close_all(|| ChannelError::Plain("Write broker closed".to_owned()));
    }
}

/// `NodeBrowser`: `browser_request` / `browser_response`, `browser_cancel`.
/// No lost-reply timer: some operations wait for the user.
pub struct NodeBrowser {
    pending: PendingRequests<Value>,
    write: Write,
}

impl NodeBrowser {
    pub fn new(write: Write) -> Self {
        Self {
            pending: PendingRequests::new(),
            write,
        }
    }

    pub fn request(
        &self,
        op: &str,
        args: Map<String, Value>,
        signal: Option<&AbortSignal>,
    ) -> PendingRequest<Value> {
        let write = self.write.clone();
        let options = RequestOptions {
            abort_error: || ChannelError::coded("aborted", "Aborted"),
            cancel: Some(Rc::new(move |id: &str| {
                write(json!({ "type": "browser_cancel", "id": id }));
            })),
            timeout: None,
        };
        self.pending.request(signal, options, |id| {
            (self.write)(json!({ "type": "browser_request", "id": id, "op": op, "args": args }));
        })
    }

    pub fn respond(&self, message: &Value) {
        let Some(id) = id_of(message).filter(|id| self.pending.contains(id)) else {
            return;
        };
        if message.get("ok") == Some(&Value::Bool(true)) {
            let result = message.get("result").cloned().unwrap_or(Value::Null);
            self.pending.resolve(id, result);
            return;
        }
        let error = error_object(message);
        let field = |name: &str| error.and_then(|error| error.get(name));
        self.pending.reject(
            id,
            ChannelError::coded(
                &string_or(field("code"), "browser_error"),
                &string_or(field("message"), "The browser request failed"),
            ),
        );
    }

    pub fn close_all(&self) {
        self.pending
            .close_all(|| ChannelError::coded("closed", "The browser channel closed"));
    }
}

/// `NodeSandboxChannel`: `sandbox_request` / `sandbox_response`,
/// `sandbox_cancel`. No lost-reply timer: approvals wait for the human.
pub struct NodeSandboxChannel {
    pending: PendingRequests<Value>,
    write: Write,
}

impl NodeSandboxChannel {
    pub fn new(write: Write) -> Self {
        Self {
            pending: PendingRequests::new(),
            write,
        }
    }

    /// `op` is `network` or `exec`; `tool_call_id` names the `ptc`
    /// operation asking.
    pub fn request(
        &self,
        op: &str,
        args: Map<String, Value>,
        signal: Option<&AbortSignal>,
        tool_call_id: Option<&str>,
    ) -> PendingRequest<Value> {
        let write = self.write.clone();
        let options = RequestOptions {
            abort_error: || ChannelError::coded("aborted", "Aborted"),
            cancel: Some(Rc::new(move |id: &str| {
                write(json!({ "type": "sandbox_cancel", "id": id }));
            })),
            timeout: None,
        };
        self.pending.request(signal, options, |id| {
            let mut frame = json!({ "type": "sandbox_request", "id": id, "op": op, "args": args });
            if let Some(tool_call_id) = tool_call_id.filter(|id| !id.is_empty()) {
                frame["toolCallId"] = json!(tool_call_id);
            }
            (self.write)(frame);
        })
    }

    pub fn respond(&self, message: &Value) {
        let Some(id) = id_of(message).filter(|id| self.pending.contains(id)) else {
            return;
        };
        if message.get("ok") == Some(&Value::Bool(true)) {
            let result = match message.get("result") {
                None | Some(Value::Null) => Value::Object(Map::new()),
                Some(result) => result.clone(),
            };
            self.pending.resolve(id, result);
            return;
        }
        let error = error_object(message);
        let field = |name: &str| error.and_then(|error| error.get(name));
        self.pending.reject(
            id,
            ChannelError::coded(
                &string_or(field("code"), "sandbox_error"),
                &string_or(field("message"), "The sandbox request failed"),
            ),
        );
    }

    pub fn close_all(&self) {
        self.pending
            .close_all(|| ChannelError::coded("closed", "The sandbox channel closed"));
    }
}

/// The process's node channels (TS: one lazily created singleton each).
pub struct NodeChannels {
    pub gateway: NodeGateway,
    pub write_broker: NodeWriteBroker,
    pub browser: NodeBrowser,
    pub sandbox: NodeSandboxChannel,
}

impl NodeChannels {
    pub fn new(write: Write) -> Self {
        Self {
            gateway: NodeGateway::new(write.clone()),
            write_broker: NodeWriteBroker::new(write.clone()),
            browser: NodeBrowser::new(write.clone()),
            sandbox: NodeSandboxChannel::new(write),
        }
    }

    /// Route a `*_response` line (`serveRpc`); `false` when `kind` is no
    /// channel's.
    pub fn route(&self, kind: &str, message: &Value) -> bool {
        match kind {
            "write_lease_response" => self.write_broker.respond(message),
            "gateway_response" => self.gateway.respond(message),
            "browser_response" => self.browser.respond(message),
            "sandbox_response" => self.sandbox.respond(message),
            _ => return false,
        }
        true
    }

    /// End every pending request (shutdown).
    pub fn close_all(&self) {
        self.write_broker.close_all();
        self.gateway.close_all();
        self.browser.close_all();
        self.sandbox.close_all();
    }
}

thread_local! {
    static NODE_CHANNELS: RefCell<Option<Rc<NodeChannels>>> = const { RefCell::new(None) };
}

/// This process's channels to its node, writing to stdout.
pub fn node_channels() -> Rc<NodeChannels> {
    NODE_CHANNELS.with(|cell| {
        cell.borrow_mut()
            .get_or_insert_with(|| Rc::new(NodeChannels::new(crate::rpc::stdout_write())))
            .clone()
    })
}

type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `teamChildName()`: a team member or subagent (`PIRC_TEAM_AGENT`).
pub fn team_child_name(env: Env<'_>) -> Option<String> {
    env("PIRC_TEAM_AGENT").filter(|name| !name.is_empty())
}

/// `processGateway`: only a node's main agent has one (`PIRC_GATEWAY=1`).
pub fn gateway_enabled(env: Env<'_>) -> bool {
    env("PIRC_GATEWAY").as_deref() == Some("1") && team_child_name(env).is_none()
}

/// `processBrowser` (`PIRC_BROWSER=1`, not a team child).
pub fn browser_enabled(env: Env<'_>) -> bool {
    env("PIRC_BROWSER").as_deref() == Some("1") && team_child_name(env).is_none()
}

/// Whether this process talks to a sandboxing node (`PIRC_SANDBOX=srt`)
/// itself. A team child's requests go through its parent
/// ([`process_sandbox_requester`]).
pub fn sandbox_enabled(env: Env<'_>) -> bool {
    env("PIRC_SANDBOX").as_deref() == Some("srt") && team_child_name(env).is_none()
}

pub fn process_gateway() -> Option<Rc<NodeChannels>> {
    gateway_enabled(&process_env).then(node_channels)
}

pub fn process_browser() -> Option<Rc<NodeChannels>> {
    browser_enabled(&process_env).then(node_channels)
}

pub fn process_sandbox_channel() -> Option<Rc<NodeChannels>> {
    sandbox_enabled(&process_env).then(node_channels)
}

/// `SandboxRequester`: whatever carries this process's sandbox requests to
/// the node.
#[derive(Clone)]
pub enum SandboxRequester {
    /// The node itself (a node's main agent).
    Node(Rc<NodeChannels>),
    /// The parent agent, which passes the request on (`viaParent`).
    Parent,
}

impl SandboxRequester {
    /// `request(op, args, signal, toolCallId)`. The parent is not told the
    /// `ptc` operation asking: only this session's own requests carry it.
    pub fn request(
        &self,
        op: &str,
        args: Map<String, Value>,
        signal: Option<&AbortSignal>,
        tool_call_id: Option<&str>,
    ) -> LocalBoxFuture<'static, Result<Value, ChannelError>> {
        match self {
            Self::Node(channels) => {
                Box::pin(channels.sandbox.request(op, args, signal, tool_call_id))
            }
            Self::Parent => {
                let call = crate::features::team::channel::parent_channel().call(
                    "sandbox_request",
                    json!({ "op": op, "args": args }),
                    signal,
                );
                Box::pin(async move {
                    let answer = call.await?;
                    if let Some(error) = answer
                        .get("error")
                        .filter(|e| crate::tools::js::truthy(Some(e)))
                    {
                        return Err(ChannelError::coded(
                            &crate::tools::js::string_of(error.get("code").unwrap_or(&Value::Null)),
                            &crate::tools::js::string_of(
                                error.get("message").unwrap_or(&Value::Null),
                            ),
                        ));
                    }
                    Ok(match answer.get("result") {
                        None | Some(Value::Null) => Value::Object(Map::new()),
                        Some(result) => result.clone(),
                    })
                })
            }
        }
    }
}

/// `processSandboxChannel()`: under a sandboxing node (`PIRC_SANDBOX=srt`),
/// the node, or the parent for a team child; else `None`.
pub fn process_sandbox_requester() -> Option<SandboxRequester> {
    sandbox_requester_with(&process_env)
}

fn sandbox_requester_with(env: Env<'_>) -> Option<SandboxRequester> {
    if env("PIRC_SANDBOX").as_deref() != Some("srt") {
        return None;
    }
    Some(if team_child_name(env).is_some() {
        SandboxRequester::Parent
    } else {
        SandboxRequester::Node(node_channels())
    })
}

/// `relaySandboxRequest`: the parent's side of a child's `sandbox_request`,
/// passed on (to the node, or up to this agent's own parent) with the
/// child named in the reason. Errors are values, since the team channel
/// carries only messages; `Err` is an unexpected failure.
pub async fn relay_sandbox_request(
    requester: Option<SandboxRequester>,
    child: &str,
    message: &Value,
    signal: Option<&AbortSignal>,
) -> Result<Value, String> {
    let Some(requester) = requester else {
        return Ok(json!({ "error": { "code": "unavailable",
            "message": "This team is not running inside a node sandbox" } }));
    };
    let op = match message.get("op").and_then(Value::as_str) {
        Some(op @ ("network" | "exec")) => op,
        _ => {
            return Ok(json!({ "error": { "code": "invalid_input",
                "message": "Unknown sandbox operation" } }));
        }
    };
    let mut args = match message.get("args") {
        Some(Value::Object(args)) => args.clone(),
        _ => Map::new(),
    };
    let reason = match args.get("reason") {
        Some(Value::String(reason)) if !crate::tools::js::trim(reason).is_empty() => {
            crate::tools::js::trim(reason).to_owned()
        }
        _ => "(no reason given)".to_owned(),
    };
    args.insert(
        "reason".to_owned(),
        json!(format!("[asked by {child}] {reason}")),
    );
    match requester.request(op, args, signal, None).await {
        Ok(result) => Ok(json!({ "result": result })),
        Err(ChannelError::Coded { code, message, .. }) => {
            Ok(json!({ "error": { "code": code, "message": message } }))
        }
        Err(ChannelError::Plain(message)) => Err(message),
    }
}

/// `processWriteLease()`: a team child's parent, which shares its own
/// lease; the node's broker under `PIRC_WRITE_BROKER=1`; else `None`
/// (standalone agents are always granted).
pub fn process_write_lease() -> Option<AcquireWrite> {
    write_lease_with(&process_env, node_channels)
}

fn write_lease_with(env: Env<'_>, channels: fn() -> Rc<NodeChannels>) -> Option<AcquireWrite> {
    if team_child_name(env).is_some() {
        // An abort drops the call, which tells the parent (`team_cancel`).
        return Some(Rc::new(
            move |root: String| -> LocalBoxFuture<'static, Result<(), String>> {
                let call = crate::features::team::channel::parent_channel().call(
                    "write_lease",
                    json!({ "path": root }),
                    None,
                );
                Box::pin(async move {
                    call.await
                        .map(|_| ())
                        .map_err(|error| error.message().to_owned())
                })
            },
        ));
    }
    if env("PIRC_WRITE_BROKER").as_deref() != Some("1") {
        return None;
    }
    Some(Rc::new(
        move |root: String| -> LocalBoxFuture<'static, Result<(), String>> {
            let request = channels().write_broker.acquire(&root, None);
            Box::pin(async move { request.await.map_err(|error| error.message().to_owned()) })
        },
    ))
}

#[cfg(test)]
mod tests;
