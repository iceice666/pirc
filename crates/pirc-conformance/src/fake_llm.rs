//! A scripted OpenAI-compatible chat-completions server, the only model
//! provider the gateway under test knows. It streams the same chunk layout as
//! `apps/gateway/test/fixtures/fake-llm.ts`, so recorded transcripts do not
//! depend on which implementation produced them.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
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

#[derive(Default)]
struct Script {
    queue: VecDeque<Reply>,
    requests: Vec<Value>,
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

async fn complete(State(script): State<Arc<Mutex<Script>>>, body: Bytes) -> Response {
    let reply = {
        let mut script = script.lock().unwrap();
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
