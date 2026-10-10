//! A scripted OpenAI-compatible chat-completions server, the only model
//! provider the gateway under test knows. It streams the same chunk layout as
//! `apps/gateway/test/fixtures/fake-llm.ts`, so recorded transcripts do not
//! depend on which implementation produced them.
//!
//! It also answers `GET /v1/models` (model discovery, also reached as
//! Anthropic's `/v1/models?limit=1000` when a base URL has no `/v1`) with
//! scripted replies, and logs which path and credentials each request
//! brought ([`FakeLlm::take_seen`]).

use std::collections::{BTreeMap, VecDeque};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// One scripted model response.
#[derive(Clone, Debug)]
pub enum Reply {
    /// Stream this text (in two chunks) and stop.
    Text(String),
    /// Call one tool with these arguments.
    Tool {
        id: String,
        name: String,
        args: Value,
    },
    /// Answer with a non-streaming HTTP error.
    Status(u16, String),
}

/// One scripted reply to `GET /v1/models`.
#[derive(Clone, Debug)]
pub enum ModelsReply {
    /// This status with this JSON body.
    Json(u16, Value),
    /// This status with this body as it is (`text/plain`), e.g. invalid JSON.
    Raw(u16, String),
    /// A `302 Found` to this location.
    Redirect(String),
}

/// Request headers that show which credentials reached the provider.
const SEEN_HEADERS: [&str; 4] = ["authorization", "x-api-key", "anthropic-version", "accept"];

#[derive(Default)]
struct Script {
    queue: VecDeque<Reply>,
    requests: Vec<Value>,
    models: VecDeque<ModelsReply>,
    seen: Vec<Value>,
}

impl Script {
    fn see(&mut self, method: &str, uri: &axum::http::Uri, headers: &HeaderMap) {
        let headers: BTreeMap<&str, &str> = SEEN_HEADERS
            .iter()
            .filter_map(|name| Some((*name, headers.get(*name)?.to_str().ok()?)))
            .collect();
        let path = uri.path_and_query().map_or(uri.path(), |p| p.as_str());
        self.seen
            .push(json!({ "request": format!("{method} {path}"), "headers": headers }));
    }
}

/// The running server; stops when dropped.
pub struct FakeLlm {
    url: String,
    script: Arc<Mutex<Script>>,
    task: JoinHandle<()>,
}

impl FakeLlm {
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let script = Arc::new(Mutex::new(Script::default()));
        let app = Router::new()
            .route("/v1/chat/completions", post(complete))
            .route("/v1/models", get(models))
            .with_state(script.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { url, script, task })
    }

    /// Base URL of the OpenAI-compatible API (ends in `/v1`).
    pub fn base_url(&self) -> String {
        format!("{}/v1", self.url)
    }

    /// `http://127.0.0.1:<port>`, without `/v1` (Anthropic-style base URL).
    pub fn root_url(&self) -> String {
        self.url.clone()
    }

    /// Queue replies to `GET /v1/models`; once the queue is empty it answers
    /// `200 {"object":"list","data":[]}`.
    pub fn push_models(&self, replies: impl IntoIterator<Item = ModelsReply>) {
        self.script.lock().unwrap().models.extend(replies);
    }

    /// Take the log of requests to either route since the last call: their
    /// method, path with query and credential headers ([`SEEN_HEADERS`]).
    pub fn take_seen(&self) -> Vec<Value> {
        std::mem::take(&mut self.script.lock().unwrap().seen)
    }

    /// Queue replies; once the queue is empty every request gets "default reply".
    pub fn push(&self, replies: impl IntoIterator<Item = Reply>) {
        self.script.lock().unwrap().queue.extend(replies);
    }

    /// Request bodies received so far.
    pub fn requests(&self) -> Vec<Value> {
        self.script.lock().unwrap().requests.clone()
    }
}

impl Drop for FakeLlm {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn models(
    State(script): State<Arc<Mutex<Script>>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let reply = {
        let mut script = script.lock().unwrap();
        script.see("GET", &uri, &headers);
        script.models.pop_front()
    };
    let status = |code| StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    match reply.unwrap_or_else(|| ModelsReply::Json(200, json!({ "object": "list", "data": [] }))) {
        ModelsReply::Json(code, body) => (
            status(code),
            [(header::CONTENT_TYPE, "application/json")],
            body.to_string(),
        )
            .into_response(),
        ModelsReply::Raw(code, body) => (status(code), body).into_response(),
        ModelsReply::Redirect(location) => {
            (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
        }
    }
}

async fn complete(
    State(script): State<Arc<Mutex<Script>>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let reply = {
        let mut script = script.lock().unwrap();
        script.see("POST", &uri, &headers);
        script
            .requests
            .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
        script
            .queue
            .pop_front()
            .unwrap_or_else(|| Reply::Text("default reply".to_owned()))
    };
    if let Reply::Status(status, body) = reply {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return (status, body).into_response();
    }
    let events = chunks(&reply);
    let stream = futures_util::stream::unfold(events.into_iter(), |mut events| async move {
        let event = events.next()?;
        tokio::time::sleep(Duration::from_millis(1)).await;
        Some((Ok::<_, Infallible>(Bytes::from(event)), events))
    });
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}

fn chunks(reply: &Reply) -> Vec<String> {
    let chunk = |delta: Value, finish: Value| {
        let data = json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] });
        format!("data: {data}\n\n")
    };
    let mut out = Vec::new();
    match reply {
        Reply::Text(text) => {
            let chars: Vec<char> = text.chars().collect();
            let half = chars.len().div_ceil(2);
            for part in [&chars[..half], &chars[half..]] {
                if !part.is_empty() {
                    let part: String = part.iter().collect();
                    out.push(chunk(json!({ "content": part }), Value::Null));
                }
            }
            out.push(chunk(json!({}), json!("stop")));
        }
        Reply::Tool { id, name, args } => {
            let args = args.to_string();
            let split = args.char_indices().nth(5).map_or(args.len(), |(i, _)| i);
            out.push(chunk(
                json!({ "tool_calls": [{ "index": 0, "id": id, "type": "function",
                    "function": { "name": name, "arguments": "" } }] }),
                Value::Null,
            ));
            for part in [&args[..split], &args[split..]] {
                out.push(chunk(
                    json!({ "tool_calls": [{ "index": 0, "function": { "arguments": part } }] }),
                    Value::Null,
                ));
            }
            out.push(chunk(json!({}), json!("tool_calls")));
        }
        Reply::Status(..) => unreachable!("handled before streaming"),
    }
    let usage = json!({ "choices": [], "usage": { "prompt_tokens": 100, "completion_tokens": 10,
        "total_tokens": 110, "prompt_tokens_details": { "cached_tokens": 40 } } });
    out.push(format!("data: {usage}\n\n"));
    out.push("data: [DONE]\n\n".to_owned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_text_into_two_content_chunks_then_usage() {
        let events = chunks(&Reply::Text("hello".to_owned()));
        assert_eq!(events.len(), 5);
        assert!(events[0].contains(r#""content":"hel""#));
        assert!(events[1].contains(r#""content":"lo""#));
        assert!(events[2].contains(r#""finish_reason":"stop""#));
        assert!(events[3].contains(r#""usage""#));
        assert_eq!(events[4], "data: [DONE]\n\n");
    }

    #[tokio::test]
    async fn serves_scripted_model_lists_and_logs_credentials() {
        let llm = FakeLlm::start().await.unwrap();
        llm.push_models([ModelsReply::Redirect("/elsewhere".to_owned())]);
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let redirected = http
            .get(format!("{}/models", llm.base_url()))
            .bearer_auth("k")
            .send()
            .await
            .unwrap();
        assert_eq!(redirected.status(), 302);
        assert_eq!(redirected.headers()["location"], "/elsewhere");
        let listed = http
            .get(format!("{}/v1/models?limit=1000", llm.root_url()))
            .header("x-api-key", "a")
            .header("accept", "application/json")
            .header("user-agent", "not recorded")
            .send()
            .await
            .unwrap();
        assert_eq!(listed.status(), 200);
        let body: Value = serde_json::from_str(&listed.text().await.unwrap()).unwrap();
        assert_eq!(body, json!({ "object": "list", "data": [] }));
        assert_eq!(
            llm.take_seen(),
            vec![
                json!({ "request": "GET /v1/models", "headers": { "accept": "*/*",
                    "authorization": "Bearer k" } }),
                json!({ "request": "GET /v1/models?limit=1000", "headers": {
                    "accept": "application/json", "x-api-key": "a" } }),
            ]
        );
        assert!(llm.take_seen().is_empty());
    }

    #[test]
    fn streams_tool_arguments_in_two_parts() {
        let events = chunks(&Reply::Tool {
            id: "c1".to_owned(),
            name: "read".to_owned(),
            args: json!({ "path": "a.txt" }),
        });
        assert!(events[0].contains(r#""name":"read""#));
        assert!(events[1].contains(r#""arguments":"{\"pat""#));
        assert!(events[3].contains(r#""finish_reason":"tool_calls""#));
    }
}
