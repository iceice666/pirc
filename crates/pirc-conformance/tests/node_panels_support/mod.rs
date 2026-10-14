//! Shared by the node panel transcripts (`node_panels`): a session opened
//! through the gateway, requests recorded into a transcript, prompts run to
//! the end, Git with a fixed identity and clock, and condensing of large
//! or per-run values (file times, big contents) before recording.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

use pirc_conformance::{
    Api, Cluster, Response, Transcript, WORKSPACE_ID, WebSocket, browser_headers,
};
use serde_json::{Value, json};

/// Strings longer than this are recorded as their length and head.
const LONG: usize = 2_000;

/// A session of the node's workspace, driven through the gateway.
pub struct Panel {
    pub api: Api,
    pub headers: Vec<(&'static str, String)>,
    pub t: Transcript,
    pub id: String,
    /// `/api/sessions/<id>`
    pub session: String,
    /// The node's workspace directory (canonical).
    pub workspace: PathBuf,
    /// The control lease's generation, once acquired.
    pub generation: Option<u64>,
    /// Further per-run values and their placeholders ([`Panel::mask_as`]).
    masks: Vec<(String, String)>,
}

impl Panel {
    /// Create a session in [`WORKSPACE_ID`] (recorded).
    pub async fn open(cluster: &Cluster) -> Self {
        let api = cluster.api();
        let headers = browser_headers();
        // Paths also appear %-encoded in request lines.
        let mut literals = cluster.volatile();
        let encoded: Vec<_> = literals
            .iter()
            .map(|(value, placeholder)| (encode(value), *placeholder))
            .collect();
        literals.extend(encoded);
        let mut t = Transcript::new(literals);
        let created = api
            .send(
                "POST",
                "/api/sessions",
                &headers,
                Some(json!({ "workspaceId": WORKSPACE_ID })),
            )
            .await;
        t.response("create a session", "POST /api/sessions", &created);
        let id = created.body["session"]["id"].as_str().unwrap().to_owned();
        Self {
            api,
            headers,
            t,
            session: format!("/api/sessions/{id}"),
            id,
            workspace: cluster.dir.path().canonicalize().unwrap().join("workspace"),
            generation: None,
            masks: Vec::new(),
        }
    }

    /// `method` on `/api/sessions/<id><suffix>`, recorded with its response
    /// condensed by [`condense`].
    pub async fn call(
        &mut self,
        step: &str,
        method: &str,
        suffix: &str,
        body: Option<Value>,
    ) -> Response {
        let path = format!("{}{suffix}", self.session);
        self.call_path(step, method, &path, body).await
    }

    /// `GET /api/sessions/<id><suffix>`, recorded.
    pub async fn get(&mut self, step: &str, suffix: &str) -> Response {
        self.call(step, "GET", suffix, None).await
    }

    /// [`Panel::get`] with one more request header, shown in the request line.
    pub async fn get_with(
        &mut self,
        step: &str,
        suffix: &str,
        header: (&'static str, &str),
    ) -> Response {
        let path = format!("{}{suffix}", self.session);
        let mut headers = self.headers.clone();
        headers.push((header.0, header.1.to_owned()));
        let response = self.api.send("GET", &path, &headers, None).await;
        self.record(
            step,
            &format!("GET {path} ({}: {})", header.0, header.1),
            &response,
        );
        response
    }

    /// Any request with the browser's headers, recorded.
    pub async fn call_path(
        &mut self,
        step: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Response {
        let response = self.api.send(method, path, &self.headers, body).await;
        self.record(step, &format!("{method} {path}"), &response);
        response
    }

    /// Record a response, condensed and masked.
    pub fn record(&mut self, step: &str, request: &str, response: &Response) {
        let condensed = Response {
            status: response.status,
            headers: response.headers.clone(),
            body: self.mask(condense(response.body.clone())),
        };
        let request = self.mask_text(request);
        self.t.response(step, &request, &condensed);
    }

    /// Record `value` as `placeholder` from now on (a generated id the
    /// normalizer does not know, such as a background task's).
    pub fn mask_as(&mut self, value: &str, placeholder: &str) {
        self.masks.push((value.to_owned(), placeholder.to_owned()));
    }

    fn mask_text(&self, text: &str) -> String {
        // A background task's log directory (`mkdtemp`).
        let mut text = pirc_conformance::mask_background_log_dir(text);
        for (value, placeholder) in &self.masks {
            text = text.replace(value.as_str(), placeholder);
        }
        text
    }

    fn mask(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.mask_text(&text)),
            Value::Array(items) => items.into_iter().map(|item| self.mask(item)).collect(),
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(key, item)| {
                        // A process id (background tasks).
                        if key == "pid" && item.is_number() {
                            return (key, json!("<pid>"));
                        }
                        (self.mask_text(&key), self.mask(item))
                    })
                    .collect(),
            ),
            other => other,
        }
    }

    /// Acquire the control lease (recorded); returns its generation.
    pub async fn acquire(&mut self) -> u64 {
        let acquired = self
            .call(
                "acquire control",
                "POST",
                "/control/acquire",
                Some(json!({ "clientId": "browser" })),
            )
            .await;
        let generation = acquired.body["lease"]["generation"].as_u64().unwrap();
        self.generation = Some(generation);
        generation
    }

    /// The lease body (`clientId`, `generation`).
    pub fn lease(&self) -> Value {
        json!({ "clientId": "browser", "generation": self.generation.expect("the lease") })
    }

    /// The session's events from now on.
    pub async fn watch(&self) -> WebSocket {
        let snapshot = self
            .api
            .send(
                "GET",
                &format!("{}/snapshot", self.session),
                &self.headers,
                None,
            )
            .await;
        let watermark = &snapshot.body["watermark"];
        let events = format!(
            "/api/events?sessionId={}&cursor={}:{}",
            self.id, watermark["epoch"], watermark["sequence"]
        );
        self.api.connect(&events, &self.headers).await.open()
    }

    /// Send a prompt command (recorded) and, when it is accepted, wait for
    /// the run to settle. Returns the command's response.
    pub async fn prompt(&mut self, step: &str, command_id: &str, payload: Value) -> Response {
        let mut live = self.watch().await;
        let sent = self.command(step, command_id, payload).await;
        if sent.status == 202 {
            settled(&mut live).await;
        }
        live.close().await;
        sent
    }

    /// Send a command (recorded) without waiting for its effects.
    pub async fn command(&mut self, step: &str, command_id: &str, payload: Value) -> Response {
        let mut command = self.lease();
        command["commandId"] = json!(command_id);
        command["payload"] = payload;
        self.call(step, "POST", "/commands", Some(command)).await
    }

    /// `GET /api/sessions/<id><suffix>` (not recorded) until `done` holds
    /// for its body; returns the body.
    pub async fn poll(&self, suffix: &str, done: impl Fn(&Value) -> bool) -> Value {
        let path = format!("{}{suffix}", self.session);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let response = self.api.send("GET", &path, &self.headers, None).await;
            if done(&response.body) {
                return response.body;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "GET {path} never satisfied the condition; last: {}",
                response.body
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    pub fn note(&mut self, step: &str, value: Value) {
        let value = self.mask(condense(value));
        self.t.note(step, value);
    }

    pub fn into_value(self) -> Value {
        self.t.into_value()
    }
}

/// Wait for the agent to settle.
pub async fn settled(live: &mut WebSocket) {
    live.until(|frame| frame["type"] == "pi_event" && frame["data"]["type"] == "agent_settled")
        .await;
}

/// Large and per-run values made recordable: a file's `modifiedAt` (float
/// milliseconds) becomes `<mtime>` when it is a number; strings longer
/// than [`LONG`] bytes become their UTF-8 length, number of characters,
/// first 64 and last 16 characters.
pub fn condense(value: Value) -> Value {
    match value {
        Value::Array(items) => items.into_iter().map(condense).collect(),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, item)| {
                    if key == "modifiedAt" && item.is_number() {
                        return (key, json!("<mtime>"));
                    }
                    (key, condense(item))
                })
                .collect(),
        ),
        Value::String(text) if text.len() > LONG => {
            let chars: Vec<char> = text.chars().collect();
            let head: String = chars[..64].iter().collect();
            let tail: String = chars[chars.len() - 16..].iter().collect();
            json!({ "<long string>": { "bytes": text.len(), "chars": chars.len(),
                "head": head, "tail": tail } })
        }
        other => other,
    }
}

/// Run `git` in `dir` as a fixed author with a fixed clock and no user or
/// system configuration, so commit ids are the same on every run.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test Author")
        .env("GIT_AUTHOR_EMAIL", "author@example.com")
        .env("GIT_COMMITTER_NAME", "Test Committer")
        .env("GIT_COMMITTER_EMAIL", "committer@example.com")
        .env("GIT_AUTHOR_DATE", "2026-01-02T03:04:05Z")
        .env("GIT_COMMITTER_DATE", "2026-01-02T03:04:05Z")
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// `%`-encode a query value (everything but unreserved characters).
pub fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
