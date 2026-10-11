//! An agent process alone, with the test playing its node: the agent is
//! started as `pirc-node agent --session-dir …` in a temporary workspace,
//! gets its `configure` line, reaches a fake inference socket for scripted
//! model replies, and has its side-channel requests (write leases, gateway
//! operations, dialogs) answered by the test.
//!
//! The agent runs with its built-in features off (`PIRC_AGENT_FEATURES=
//! none`, the M4 target of the agent port, plans/rust-rewrite.md) unless a
//! scenario turns some on ([`AgentOptions::features`], M5).
//! `PIRC_CONFORMANCE_AGENT_BIN` runs another agent executable (the Rust
//! one) with the same arguments.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use crate::client::TIMEOUT;

/// The inference socket's bearer token.
const TOKEN: &str = "conformance-inference-token-0123456789";
/// Another agent executable to test with the same arguments.
const AGENT_VARIABLE: &str = "PIRC_CONFORMANCE_AGENT_BIN";

/// One scripted model reply, as the gateway would stream it.
#[derive(Clone, Debug)]
pub enum ModelReply {
    /// Text in two deltas, stop reason `stop`.
    Text(String),
    /// Thinking, then text.
    Thinking(String, String),
    /// Tool calls `(id, name, arguments)`, stop reason `toolUse`.
    Tools(Vec<(String, String, Value)>),
    /// Text, then tool calls.
    TextAndTools(String, Vec<(String, String, Value)>),
    /// The final message only: an `error` stop reason with this message.
    Failed(String),
    /// A transport error event (`model_error`).
    Error(String),
    /// Text, then nothing more until the agent gives up the request.
    Hang(String),
    /// These NDJSON events as they are.
    Raw(Vec<Value>),
    /// The reply, once the gate is opened: the request waits until the
    /// test lets it go, so a side request (a session title) ends at a
    /// known point of the transcript.
    Gated(Gate, Box<ModelReply>),
}

impl ModelReply {
    pub fn tool(id: &str, name: &str, args: Value) -> Self {
        Self::Tools(vec![(id.to_owned(), name.to_owned(), args)])
    }

    /// `reply`, held until `gate` opens.
    pub fn gated(gate: &Gate, reply: ModelReply) -> Self {
        Self::Gated(gate.clone(), Box::new(reply))
    }
}

/// Holds a [`ModelReply::Gated`] reply until opened.
#[derive(Clone, Debug, Default)]
pub struct Gate(Arc<tokio::sync::Notify>);

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Let the held reply go (now, or as soon as its request arrives).
    pub fn open(&self) {
        self.0.notify_one();
    }
}

/// What the model "used" for every reply.
fn usage() -> Value {
    json!({ "input": 100, "output": 10, "cacheRead": 40, "cacheWrite": 0, "totalTokens": 150 })
}

fn halves(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let half = chars.len().div_ceil(2);
    [&chars[..half], &chars[half..]]
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(|part| part.iter().collect())
        .collect()
}

/// The NDJSON lines of a reply, and whether the stream then hangs.
fn reply_lines(reply: &ModelReply, model: &str) -> (Vec<Value>, bool) {
    let delta = |delta: Value| json!({ "type": "model_delta", "delta": delta });
    let end = |content: Vec<Value>, stop: &str, error: Option<&str>| {
        let mut message = json!({ "role": "assistant", "content": content,
            "api": "openai-completions", "provider": "fake", "model": model,
            "usage": usage(), "stopReason": stop, "timestamp": 1 });
        if let Some(error) = error {
            message["errorMessage"] = json!(error);
        }
        json!({ "type": "model_end", "message": message })
    };
    let mut lines = Vec::new();
    let mut content = Vec::new();
    let text = |lines: &mut Vec<Value>, content: &mut Vec<Value>, text: &str| {
        let index = content.len();
        lines.push(delta(
            json!({ "type": "text_start", "contentIndex": index }),
        ));
        for part in halves(text) {
            lines.push(delta(
                json!({ "type": "text_delta", "contentIndex": index, "delta": part }),
            ));
        }
        lines.push(delta(
            json!({ "type": "text_end", "contentIndex": index, "content": text }),
        ));
        content.push(json!({ "type": "text", "text": text }));
    };
    let tools =
        |lines: &mut Vec<Value>, content: &mut Vec<Value>, calls: &[(String, String, Value)]| {
            for (id, name, args) in calls {
                let index = content.len();
                let call = json!({ "type": "toolCall", "id": id, "name": name,
                "arguments": args });
                lines.push(delta(
                    json!({ "type": "toolcall_start", "contentIndex": index,
                "id": id, "toolName": name }),
                ));
                lines.push(delta(
                    json!({ "type": "toolcall_delta", "contentIndex": index,
                "delta": args.to_string() }),
                ));
                lines.push(delta(
                    json!({ "type": "toolcall_end", "contentIndex": index,
                "toolCall": call }),
                ));
                content.push(call);
            }
        };
    match reply {
        ModelReply::Text(value) => {
            text(&mut lines, &mut content, value);
            lines.push(end(content, "stop", None));
        }
        ModelReply::Thinking(thinking, value) => {
            lines.push(delta(
                json!({ "type": "thinking_start", "contentIndex": 0 }),
            ));
            lines.push(delta(
                json!({ "type": "thinking_delta", "contentIndex": 0, "delta": thinking }),
            ));
            lines.push(delta(
                json!({ "type": "thinking_end", "contentIndex": 0, "content": thinking }),
            ));
            content.push(json!({ "type": "thinking", "thinking": thinking }));
            text(&mut lines, &mut content, value);
            lines.push(end(content, "stop", None));
        }
        ModelReply::Tools(calls) => {
            tools(&mut lines, &mut content, calls);
            lines.push(end(content, "toolUse", None));
        }
        ModelReply::TextAndTools(value, calls) => {
            text(&mut lines, &mut content, value);
            tools(&mut lines, &mut content, calls);
            lines.push(end(content, "toolUse", None));
        }
        ModelReply::Failed(error) => lines.push(end(Vec::new(), "error", Some(error))),
        ModelReply::Error(code) => lines.push(json!({ "type": "model_error", "code": code })),
        ModelReply::Hang(value) => {
            lines.push(delta(json!({ "type": "text_start", "contentIndex": 0 })));
            lines.push(delta(
                json!({ "type": "text_delta", "contentIndex": 0, "delta": value }),
            ));
            return (lines, true);
        }
        ModelReply::Raw(events) => lines.extend(events.iter().cloned()),
        // The handler waits for the gate first.
        ModelReply::Gated(_, inner) => return reply_lines(inner, model),
    }
    (lines, false)
}

#[derive(Default)]
struct Inference {
    replies: VecDeque<ModelReply>,
    /// Replies for requests whose messages contain the marker, taken
    /// before the main queue (`llm.route` of the TS tests).
    routes: Vec<(String, VecDeque<ModelReply>)>,
    requests: Vec<Value>,
    models: Value,
}

type SharedInference = Arc<Mutex<Inference>>;

async fn inference(
    State(state): State<SharedInference>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        == Some(&format!("Bearer {TOKEN}"));
    let ndjson = |status: StatusCode, value: Value| {
        (
            status,
            [(header::CONTENT_TYPE, "application/x-ndjson")],
            format!("{value}\n"),
        )
            .into_response()
    };
    if !authorized {
        return ndjson(
            StatusCode::UNAUTHORIZED,
            json!({ "type": "model_error", "code": "unavailable" }),
        );
    }
    if method == Method::GET && uri.path() == "/models" {
        let models = state.lock().unwrap().models.clone();
        return (
            [(header::CONTENT_TYPE, "application/json")],
            models.to_string(),
        )
            .into_response();
    }
    if method != Method::POST || uri.path() != "/inference" {
        return ndjson(
            StatusCode::NOT_FOUND,
            json!({ "type": "model_error", "code": "invalid_request" }),
        );
    }
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let model = request["modelId"]
        .as_str()
        .unwrap_or("fake-model")
        .to_owned();
    let mut reply = {
        let mut state = state.lock().unwrap();
        let messages = request["messages"].to_string();
        state.requests.push(request);
        let routed = state
            .routes
            .iter_mut()
            .find(|(marker, replies)| !replies.is_empty() && messages.contains(marker.as_str()))
            .and_then(|(_, replies)| replies.pop_front());
        routed
            .or_else(|| state.replies.pop_front())
            .unwrap_or_else(|| ModelReply::Text("default reply".to_owned()))
    };
    while let ModelReply::Gated(gate, inner) = reply {
        gate.0.notified().await;
        reply = *inner;
    }
    let (lines, hang) = reply_lines(&reply, &model);
    let stream =
        futures_util::stream::unfold((lines.into_iter(), hang), |(mut lines, hang)| async move {
            tokio::time::sleep(Duration::from_millis(2)).await;
            match lines.next() {
                Some(line) => Some((
                    Ok::<_, Infallible>(Bytes::from(format!("{line}\n"))),
                    (lines, hang),
                )),
                None if hang => {
                    std::future::pending::<()>().await;
                    None
                }
                None => None,
            }
        });
    (
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(stream),
    )
        .into_response()
}

/// How the test answers the agent's side-channel requests.
#[derive(Default)]
pub struct Answers {
    /// Write lease paths refused (all others are granted).
    pub refuse_leases: Vec<String>,
    /// Dialog answers in order: fields merged into `extension_ui_response`
    /// (`{"confirmed": true}`, `{"value": "x"}`, `{"cancelled": true}`).
    /// `{"hold": true}` or `null` leaves that dialog unanswered.
    pub dialogs: VecDeque<Value>,
    /// Gateway operation results by `op` (`{"ok": true, "result": …}` or an
    /// error object), else `{"ok": false, "error": {"code": "not_found"}}`.
    pub gateway: HashMap<String, Value>,
    /// A team child's `team_call`s to its parent, answered in order: fields
    /// merged into `team_result` (`{"result": …}` or `{"error": "…"}`).
    /// `{"hold": true}`, `null` or an empty queue leaves the call open.
    pub team: VecDeque<Value>,
    /// Browser operation results by `op`, used in order (`{"ok": true,
    /// "result": …}` or `{"ok": false, "error": …}`). An operation with
    /// nothing queued is not answered (the agent waits, as for a human).
    pub browser: HashMap<String, VecDeque<Value>>,
    /// Sandbox request results in order, whatever the `op`; none queued is
    /// not answered.
    pub sandbox: VecDeque<Value>,
}

/// How the agent is started.
#[derive(Clone, Debug)]
pub struct AgentOptions {
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
    /// The node's agent `config.json` (merged over the default, which turns
    /// the auto-mode classifier model off).
    pub config: Value,
    /// Workspace files `(relative path, content)`.
    pub files: Vec<(String, String)>,
    /// Extra `configure` fields (`capabilities`, `instructions`, `role`).
    pub configure: Value,
    /// Extra agent arguments (`--model p/id`, `--thinking low`, …).
    pub args: Vec<String>,
    /// The public model catalog (default: one `fake` provider).
    pub models: Option<Value>,
}

impl AgentOptions {
    /// Run with these built-in features (`PIRC_AGENT_FEATURES`, a
    /// comma-separated list of feature names such as `todo,goal`).
    pub fn features(mut self, names: &str) -> Self {
        self.env
            .push(("PIRC_AGENT_FEATURES".to_owned(), names.to_owned()));
        self
    }
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            env: vec![("PIRC_WRITE_BROKER".to_owned(), "1".to_owned())],
            config: json!({}),
            files: vec![("README.md".to_owned(), "conformance\n".to_owned())],
            configure: json!({}),
            args: Vec::new(),
            models: None,
        }
    }
}

/// The default public catalog: the gateway's projection of one provider.
pub fn fake_models() -> Value {
    json!({
        "providers": { "fake": { "api": "openai-completions", "baseUrl": "https://gateway.invalid",
            "headers": {}, "compat": {},
            "models": [
                { "id": "fake-model", "name": "Fake model", "contextWindow": 100000,
                  "maxTokens": 1000, "reasoning": true, "input": ["text"], "compat": {} },
                { "id": "small-model", "contextWindow": 2000, "maxTokens": 500,
                  "reasoning": false, "input": ["text", "image"], "compat": {} },
            ] } },
        "defaultModel": { "provider": "fake", "id": "fake-model", "thinking": "low" },
    })
}

/// A running agent; stopped when dropped.
pub struct AgentRun {
    child: Child,
    /// `None` once closed ([`AgentRun::finish`]).
    stdin: Option<ChildStdin>,
    lines: mpsc::UnboundedReceiver<Value>,
    /// Lines read while waiting for something else, in order.
    backlog: VecDeque<Value>,
    inference: SharedInference,
    pub answers: Arc<Mutex<Answers>>,
    server: tokio::task::JoinHandle<()>,
    next_id: u64,
    pub workspace: PathBuf,
    pub session_dir: PathBuf,
    pub config_dir: PathBuf,
    /// Root of every temporary directory the agent uses.
    pub dir: TempDir,
}

impl Drop for AgentRun {
    fn drop(&mut self) {
        self.server.abort();
        let _ = self.child.start_kill();
    }
}

/// `PIRC_CONFORMANCE_AGENT_BIN`, resolved.
pub(crate) fn agent_override() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(AGENT_VARIABLE)?);
    let path = if path.is_absolute() {
        path
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path)
    };
    Some(
        path.canonicalize()
            .unwrap_or_else(|e| panic!("{AGENT_VARIABLE}: {e}")),
    )
}

/// The agent executable and its leading arguments, or `None` (skipped).
fn agent_command() -> Option<(PathBuf, Vec<String>)> {
    if let Some(path) = agent_override() {
        return Some((path, vec!["agent".to_owned()]));
    }
    let bin_dir = crate::cluster::bin_dir()?;
    Some((bin_dir.join("pirc-node"), vec!["agent".to_owned()]))
}

fn merge(base: &mut Value, extra: &Value) {
    match (base, extra) {
        (Value::Object(base), Value::Object(extra)) => {
            for (key, value) in extra {
                merge(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (base, extra) => *base = extra.clone(),
    }
}

impl AgentRun {
    /// Start an agent, or `None` (test skipped) without executables.
    pub async fn start(options: AgentOptions) -> Option<Self> {
        agent_command()?;
        // A root whose length does not depend on where the repository is
        // checked out: the context snapshot's token estimates count the
        // workspace path.
        let base = Path::new("/tmp/pirc-conformance");
        std::fs::create_dir_all(base).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("agent-")
            .tempdir_in(base)
            .unwrap();
        Self::start_in(dir, options).await
    }

    /// Close this agent (as [`AgentRun::finish`]) and start another on the
    /// same workspace, session and config directories: a new process
    /// resuming the session. The files and config of `options` are
    /// written again.
    pub async fn restart(mut self, options: AgentOptions) -> Option<Self> {
        self.stdin.take();
        tokio::time::timeout(TIMEOUT, self.child.wait())
            .await
            .expect("the agent did not exit after stdin closed")
            .ok()?;
        self.server.abort();
        let placeholder = tempfile::tempdir().unwrap();
        let dir = std::mem::replace(&mut self.dir, placeholder);
        drop(self);
        Self::start_in(dir, options).await
    }

    async fn start_in(dir: TempDir, options: AgentOptions) -> Option<Self> {
        let (program, mut args) = agent_command()?;
        let root = dir.path().canonicalize().unwrap();
        let make = |name: &str| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        };
        let (workspace, session_dir, config_dir, home) = (
            make("workspace"),
            make("session"),
            make("config"),
            make("home"),
        );
        for (file, content) in &options.files {
            let path = workspace.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let mut config = json!({ "features": { "autoMode": { "useModel": false } } });
        merge(&mut config, &options.config);
        std::fs::write(config_dir.join("config.json"), config.to_string()).unwrap();

        let socket = root.join("inference.sock");
        // A restarted agent's socket is still there.
        let _ = std::fs::remove_file(&socket);
        let models = options.models.clone().unwrap_or_else(fake_models);
        let inference: SharedInference = Arc::new(Mutex::new(Inference {
            models: models.clone(),
            ..Inference::default()
        }));
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let app = Router::new()
            .fallback(inference_handler)
            .with_state(inference.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        args.extend([
            "--session-dir".to_owned(),
            session_dir.display().to_string(),
        ]);
        args.extend(options.args.iter().cloned());
        let mut command = bash_shim(&program, &args);
        command
            .current_dir(&workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("PIRC_CONFIG_DIR", &config_dir)
            .env("PIRC_AGENT_FEATURES", "none")
            .envs(options.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .unwrap_or_else(|e| panic!("cannot start {}: {e}", program.display()));
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let answers = Arc::new(Mutex::new(Answers::default()));
        let (sender, lines) = mpsc::unbounded_channel();
        tokio::spawn(read_lines(stdout, sender));

        let mut configure = json!({ "type": "configure", "models": models,
            "capabilities": { "version": 1 } });
        configure["models"]["inference"] =
            json!({ "socketPath": socket.display().to_string(), "token": TOKEN });
        merge(&mut configure, &options.configure);
        stdin
            .write_all(format!("{configure}\n").as_bytes())
            .await
            .unwrap();
        Some(Self {
            child,
            stdin: Some(stdin),
            lines,
            backlog: VecDeque::new(),
            inference,
            answers,
            server,
            next_id: 0,
            workspace,
            session_dir,
            config_dir,
            dir,
        })
    }

    /// Values that differ between runs.
    pub fn volatile(&self) -> Vec<(String, &'static str)> {
        let canonical = self.dir.path().canonicalize().unwrap();
        vec![
            (canonical.display().to_string(), "<tmp>"),
            (self.dir.path().display().to_string(), "<tmp>"),
        ]
    }

    /// Queue model replies; once empty, every request gets "default reply".
    pub fn push(&self, replies: impl IntoIterator<Item = ModelReply>) {
        self.inference.lock().unwrap().replies.extend(replies);
    }

    /// Queue replies for requests whose messages contain `marker` (a side
    /// request running next to the main one); they are taken before the
    /// main queue.
    pub fn route(&self, marker: &str, replies: impl IntoIterator<Item = ModelReply>) {
        let mut inference = self.inference.lock().unwrap();
        match inference.routes.iter_mut().find(|(m, _)| m == marker) {
            Some((_, queue)) => queue.extend(replies),
            None => inference
                .routes
                .push((marker.to_owned(), replies.into_iter().collect())),
        }
    }

    /// Inference requests received since the last call.
    pub fn take_requests(&self) -> Vec<Value> {
        std::mem::take(&mut self.inference.lock().unwrap().requests)
    }

    /// How many inference requests arrived and were not taken yet.
    pub fn pending_requests(&self) -> usize {
        self.inference.lock().unwrap().requests.len()
    }

    /// Wait until an inference request arrived (one not taken yet).
    pub async fn wait_for_request(&self) {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while self.pending_requests() == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for an inference request"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Replace the catalog `/models` serves.
    pub fn set_models(&self, models: Value) {
        self.inference.lock().unwrap().models = models;
    }

    /// Write one stdin line.
    pub async fn send(&mut self, value: Value) {
        self.send_raw(&format!("{value}\n")).await;
    }

    /// Write raw stdin text.
    pub async fn send_raw(&mut self, text: &str) {
        let stdin = self.stdin.as_mut().expect("stdin is closed");
        stdin.write_all(text.as_bytes()).await.unwrap();
    }

    /// Send an RPC command with a fresh id; returns the id.
    pub async fn command(&mut self, mut command: Value) -> String {
        self.next_id += 1;
        let id = format!("c{}", self.next_id);
        command["id"] = json!(id);
        self.send(command).await;
        id
    }

    /// The next line from the agent (answering side-channel requests as
    /// they pass); `None` once stdout closed.
    pub async fn next(&mut self) -> Option<Value> {
        if let Some(line) = self.backlog.pop_front() {
            return Some(line);
        }
        let line = tokio::time::timeout(TIMEOUT, self.lines.recv())
            .await
            .expect("timed out waiting for the agent")?;
        self.answer(&line).await;
        Some(line)
    }

    /// Lines until one satisfies `done` (included).
    pub async fn until(&mut self, mut done: impl FnMut(&Value) -> bool) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let line = self
                .next()
                .await
                .unwrap_or_else(|| panic!("agent exited after {seen:?}"));
            let stop = done(&line);
            seen.push(line);
            if stop {
                return seen;
            }
        }
    }

    /// Run a command and wait for its response, leaving other lines in the
    /// backlog (in order). Returns the response.
    pub async fn call(&mut self, command: Value) -> Value {
        let id = self.command(command).await;
        let mut kept = VecDeque::new();
        let response = loop {
            let line = match self.backlog.pop_front() {
                Some(line) => line,
                None => {
                    let line = tokio::time::timeout(TIMEOUT, self.lines.recv())
                        .await
                        .expect("timed out waiting for a response")
                        .expect("agent exited before responding");
                    self.answer(&line).await;
                    line
                }
            };
            if line["type"] == "response" && line["id"] == id.as_str() {
                break line;
            }
            kept.push_back(line);
        };
        kept.extend(self.backlog.drain(..));
        self.backlog = kept;
        response
    }

    /// Events until `agent_settled`, without responses (which `call`
    /// returns): the agent's own event stream.
    pub async fn settle(&mut self) -> Vec<Value> {
        self.until(|line| line["type"] == "agent_settled")
            .await
            .into_iter()
            .filter(|line| line["type"] != "response")
            .collect()
    }

    /// Answer a side-channel request.
    async fn answer(&mut self, line: &Value) {
        let reply = {
            let mut answers = self.answers.lock().unwrap();
            match line["type"].as_str() {
                Some("write_lease_request") => {
                    let path = line["path"].as_str().unwrap_or_default();
                    Some(if answers.refuse_leases.iter().any(|p| p == path) {
                        json!({ "type": "write_lease_response", "id": line["id"],
                            "granted": false, "error": "Another session holds the write lease" })
                    } else {
                        json!({ "type": "write_lease_response", "id": line["id"], "granted": true })
                    })
                }
                Some("gateway_request") => {
                    let op = line["op"].as_str().unwrap_or_default();
                    let mut reply = answers.gateway.get(op).cloned().unwrap_or_else(|| {
                        json!({ "ok": false, "error": { "code": "not_found",
                            "message": "No such operation", "status": 404 } })
                    });
                    reply["type"] = json!("gateway_response");
                    reply["id"] = line["id"].clone();
                    Some(reply)
                }
                Some("team_call") => match answers.team.pop_front() {
                    Some(mut reply) if !reply.is_null() && reply["hold"] != true => {
                        reply["type"] = json!("team_result");
                        reply["id"] = line["id"].clone();
                        Some(reply)
                    }
                    _ => None,
                },
                Some("browser_request") => {
                    let op = line["op"].as_str().unwrap_or_default();
                    answers
                        .browser
                        .get_mut(op)
                        .and_then(VecDeque::pop_front)
                        .map(|mut reply| {
                            reply["type"] = json!("browser_response");
                            reply["id"] = line["id"].clone();
                            reply
                        })
                }
                Some("sandbox_request") => answers.sandbox.pop_front().map(|mut reply| {
                    reply["type"] = json!("sandbox_response");
                    reply["id"] = line["id"].clone();
                    reply
                }),
                Some("extension_ui_request")
                    if matches!(
                        line["method"].as_str(),
                        Some("select" | "confirm" | "input" | "editor")
                    ) =>
                {
                    let mut reply = answers
                        .dialogs
                        .pop_front()
                        .unwrap_or_else(|| json!({ "cancelled": true }));
                    // `null` or `{"hold": true}`: left open for the test to answer or cancel.
                    if reply.is_null() || reply["hold"] == true {
                        None
                    } else {
                        reply["type"] = json!("extension_ui_response");
                        reply["id"] = line["id"].clone();
                        Some(reply)
                    }
                }
                _ => None,
            }
        };
        if let Some(reply) = reply {
            self.send(reply).await;
        }
    }

    /// The session file, one value per line.
    pub fn session_entries(&self) -> Vec<Value> {
        std::fs::read_to_string(self.session_dir.join("session.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Close stdin and wait for the agent to exit: the lines it wrote
    /// meanwhile (shutdown hooks), and its exit code.
    pub async fn close(mut self) -> (Vec<Value>, Option<i32>) {
        self.stdin.take();
        let mut lines: Vec<Value> = self.backlog.drain(..).collect();
        loop {
            let line = tokio::time::timeout(TIMEOUT, self.lines.recv())
                .await
                .expect("the agent did not exit after stdin closed");
            match line {
                Some(line) => lines.push(line),
                None => break,
            }
        }
        let status = tokio::time::timeout(TIMEOUT, self.child.wait())
            .await
            .expect("the agent did not exit after stdin closed")
            .ok();
        (lines, status.and_then(|status| status.code()))
    }

    /// Close stdin and wait for the agent to exit; its exit code.
    pub async fn finish(mut self) -> Option<i32> {
        // Dropping the pipe is what closes it.
        self.stdin.take();
        let status = tokio::time::timeout(TIMEOUT, self.child.wait())
            .await
            .expect("the agent did not exit after stdin closed")
            .ok()?;
        status.code()
    }
}

async fn inference_handler(
    state: State<SharedInference>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    inference(state, method, uri, headers, body).await
}

async fn read_lines(stdout: tokio::process::ChildStdout, sender: mpsc::UnboundedSender<Value>) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str(&line)
            .unwrap_or_else(|_| json!({ "type": "<not json>", "text": line }));
        if sender.send(value).is_err() {
            return;
        }
    }
}

/// The agent's command. Where `/bin/bash` is missing (NixOS), the agent
/// runs in a throwaway user and mount namespace whose `/bin` holds `sh`
/// and `bash`, since the shell tools run `/bin/bash`.
fn bash_shim(program: &Path, args: &[String]) -> Command {
    if Path::new("/bin/bash").exists() {
        let mut command = Command::new(program);
        command.args(args);
        return command;
    }
    let sh = std::fs::canonicalize("/bin/sh").expect("/bin/sh");
    let bash = sh.with_file_name("bash");
    assert!(
        bash.exists(),
        "no /bin/bash and no bash next to {}",
        sh.display()
    );
    let quote = |value: &str| format!("'{}'", value.replace('\'', r"'\''"));
    let exec = std::iter::once(program.display().to_string())
        .chain(args.iter().cloned())
        .map(|arg| quote(&arg))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "mount -t tmpfs tmpfs /bin && touch /bin/sh /bin/bash && mount --bind {} /bin/sh && mount --bind {} /bin/bash && exec {exec}",
        quote(&sh.display().to_string()),
        quote(&bash.display().to_string()),
    );
    let mut command = Command::new("unshare");
    command.args(["-rm", "/bin/sh", "-c", &script]);
    command
}

/// A scenario's transcript: session entry ids (8 random hex digits)
/// become `<entry:N>`, and inference requests show their system prompt and
/// tools only when they change.
pub struct Recorder {
    pub t: crate::Transcript,
    entries: HashMap<String, String>,
    prompt: Option<Value>,
    tools: Option<Value>,
}

const ENTRY_KEYS: [&str; 5] = ["id", "parentId", "firstKeptEntryId", "entryId", "leafId"];

impl Recorder {
    pub fn new(agent: &AgentRun) -> Self {
        Self {
            t: crate::Transcript::new(agent.volatile()),
            entries: HashMap::new(),
            prompt: None,
            tools: None,
        }
    }

    fn mask(&mut self, value: &mut Value) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| self.mask(item)),
            Value::Object(object) => {
                for (key, item) in object.iter_mut() {
                    if let Value::String(text) = item
                        && ENTRY_KEYS.contains(&key.as_str())
                        && text.len() == 8
                        && text
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        let count = self.entries.len() + 1;
                        *text = self
                            .entries
                            .entry(text.clone())
                            .or_insert_with(|| format!("<entry:{count}>"))
                            .clone();
                    } else {
                        self.mask(item);
                    }
                }
            }
            _ => {}
        }
    }

    pub fn note(&mut self, step: &str, mut value: Value) {
        self.mask(&mut value);
        self.t.note(step, value);
    }

    /// Inference requests; a system prompt or tool list equal to the
    /// previous one is shown as `"<unchanged>"`.
    pub fn requests(&mut self, step: &str, requests: Vec<Value>) {
        let mut shown = Vec::new();
        for mut request in requests {
            for (key, seen) in [
                ("systemPrompt", &mut self.prompt),
                ("tools", &mut self.tools),
            ] {
                if let Some(value) = request.get_mut(key) {
                    if seen.as_ref() == Some(value) {
                        *value = json!("<unchanged>");
                    } else {
                        *seen = Some(value.clone());
                    }
                }
            }
            shown.push(request);
        }
        self.note(step, json!(shown));
    }

    /// The agent's events since the last call, then the requests it made.
    pub fn turn(&mut self, step: &str, agent: &AgentRun, events: Vec<Value>) {
        self.note(&format!("{step}: events"), json!(events));
        self.requests(&format!("{step}: model requests"), agent.take_requests());
    }

    pub fn session(&mut self, agent: &AgentRun) {
        self.note("session file", json!(agent.session_entries()));
    }

    pub fn into_value(self) -> Value {
        self.t.into_value()
    }
}
