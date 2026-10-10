//! Cancellation and routing behaviour the recorded parity scenarios cannot
//! express (they cancel only from inside a delta callback).

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use pirc_protocol::{AssistantDelta, AssistantMessage, InferenceRequest, Models, StopReason};
use pirc_providers::Inference;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::Notify;

#[derive(Clone, Copy)]
enum Mode {
    /// Never send response headers.
    Silent,
    /// Send one text chunk, then keep the body open.
    Hang,
    /// A complete text reply.
    Text,
}

struct Shared {
    mode: Mode,
    requests: AtomicUsize,
    arrived: Notify,
    body_dropped: AtomicBool,
}

/// Flags the response body as dropped, i.e. the client went away.
struct DropGuard(Arc<Shared>);

impl Drop for DropGuard {
    fn drop(&mut self) {
        self.0.body_dropped.store(true, Ordering::SeqCst);
    }
}

fn data(value: serde_json::Value) -> String {
    format!("data: {value}\n\n")
}

async fn handle(State(shared): State<Arc<Shared>>) -> Response {
    shared.requests.fetch_add(1, Ordering::SeqCst);
    shared.arrived.notify_waiters();
    let chunks = match shared.mode {
        Mode::Silent => {
            std::future::pending::<()>().await;
            unreachable!()
        }
        Mode::Hang => vec![data(
            json!({ "choices": [{ "index": 0, "delta": { "content": "Hi" } }] }),
        )],
        Mode::Text => vec![
            data(json!({ "choices": [{ "index": 0, "delta": { "content": "Hi" } }] })),
            data(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] })),
            "data: [DONE]\n\n".to_owned(),
        ],
    };
    let hang = matches!(shared.mode, Mode::Hang);
    let guard = DropGuard(shared.clone());
    let stream = futures_util::stream::unfold(
        (chunks.into_iter(), guard),
        move |(mut chunks, guard)| async move {
            match chunks.next() {
                Some(chunk) => Some((Ok::<_, Infallible>(Bytes::from(chunk)), (chunks, guard))),
                None if hang => {
                    std::future::pending::<()>().await;
                    None
                }
                None => None,
            }
        },
    );
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn server(mode: Mode) -> (String, Arc<Shared>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let shared = Arc::new(Shared {
        mode,
        requests: AtomicUsize::new(0),
        arrived: Notify::new(),
        body_dropped: AtomicBool::new(false),
    });
    let app = Router::new().fallback(handle).with_state(shared.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (base, shared)
}

fn models(base: &str, api: &str) -> Models {
    serde_json::from_value(
        json!({ "providers": { "fake": { "api": api, "baseUrl": base,
        "apiKey": "test-key", "models": [{ "id": "fake-model", "reasoning": true,
            "contextWindow": 100000, "maxTokens": 1000 }] } } }),
    )
    .unwrap()
}

fn request() -> InferenceRequest {
    serde_json::from_value(json!({ "providerName": "fake", "modelId": "fake-model",
        "systemPrompt": "s", "messages": [{ "role": "user", "content": "hi", "timestamp": 1 }],
        "tools": [], "thinking": "low", "sessionId": "session-1" }))
    .unwrap()
}

fn ignore(_: &AssistantDelta, _: &AssistantMessage) {}

#[tokio::test]
async fn cancel_all_aborts_a_request_waiting_for_headers() {
    let (base, shared) = server(Mode::Silent).await;
    let models = models(&base, "openai-completions");
    let inference = Inference::with_cache_retention(false);
    let arrived = shared.arrived.notified();
    let run = async {
        let mut on_delta = ignore;
        inference
            .run(&models, &request(), "node-1", &mut on_delta)
            .await
    };
    let cancel = async {
        arrived.await;
        inference.cancel_all();
    };
    let (message, ()) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(run, cancel) })
            .await
            .unwrap();
    assert_eq!(message.stop_reason, StopReason::Aborted);
    assert_eq!(
        message.error_message.as_deref(),
        Some("Model request cancelled")
    );
    assert_eq!(message.api, "openai-completions");
    // Pi had not started streaming: the adapter's initial result.
    assert_eq!(message.canonical_provider, None);
    assert!(message.content.is_empty());
}

#[tokio::test]
async fn cancel_all_keeps_the_streamed_text_and_spares_later_runs() {
    for api in ["openai-completions", "openai-chat"] {
        let (base, _shared) = server(Mode::Hang).await;
        let models = models(&base, api);
        let inference = Inference::with_cache_retention(false);
        let first_delta = Notify::new();
        let run = async {
            let mut on_delta = |_: &AssistantDelta, _: &AssistantMessage| {
                first_delta.notify_one();
            };
            inference
                .run(&models, &request(), "node-1", &mut on_delta)
                .await
        };
        let cancel = async {
            first_delta.notified().await;
            inference.cancel_all();
        };
        let (message, ()) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(run, cancel) })
                .await
                .unwrap();
        assert_eq!(message.stop_reason, StopReason::Aborted, "{api}");
        assert_eq!(
            serde_json::to_value(&message.content).unwrap(),
            json!([{ "type": "text", "text": "Hi" }]),
            "{api}"
        );

        let (base, _shared) = server(Mode::Text).await;
        let models = self::models(&base, api);
        let mut on_delta = ignore;
        let message = inference
            .run(&models, &request(), "node-1", &mut on_delta)
            .await;
        assert_eq!(message.stop_reason, StopReason::Stop, "{api}");
        assert_eq!(message.error_message, None, "{api}");
    }
}

#[tokio::test]
async fn dropping_the_run_closes_the_connection() {
    let (base, shared) = server(Mode::Hang).await;
    let models = Arc::new(models(&base, "openai-completions"));
    let inference = Arc::new(Inference::with_cache_retention(false));
    let (delta_tx, delta_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn({
        let (models, inference) = (models.clone(), inference.clone());
        async move {
            let mut delta_tx = Some(delta_tx);
            let mut on_delta = move |_: &AssistantDelta, _: &AssistantMessage| {
                if let Some(tx) = delta_tx.take() {
                    let _ = tx.send(());
                }
            };
            inference
                .run(models.as_ref(), &request(), "node-1", &mut on_delta)
                .await
        }
    });
    delta_rx.await.unwrap();
    assert!(!shared.body_dropped.load(Ordering::SeqCst));
    task.abort();
    let _ = task.await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !shared.body_dropped.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the server sees the client go away");
}

#[tokio::test]
async fn connection_failures_are_classified() {
    // Nothing listens on a port that was just released.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    drop(listener);
    let inference = Inference::with_cache_retention(false);
    let mut on_delta = ignore;
    let pi = inference
        .run(
            &models(&base, "openai-completions"),
            &request(),
            "n",
            &mut on_delta,
        )
        .await;
    assert_eq!(
        pi.error_message.as_deref(),
        Some("Model provider request failed.")
    );
    let chat = inference
        .run(
            &models(&base, "openai-chat"),
            &request(),
            "n",
            &mut on_delta,
        )
        .await;
    assert_eq!(
        chat.error_message.as_deref(),
        Some("Model network request failed")
    );
}

/// A resolver that waits (as an account refresh does) until released.
struct SlowResolver(Arc<Notify>);

impl pirc_providers::Resolve for SlowResolver {
    async fn resolve(&self, _: &str, _: &str) -> Result<pirc_providers::Resolved, String> {
        self.0.notified().await;
        Err("Backend or authorization session not found".to_owned())
    }
}

#[tokio::test]
async fn cancel_all_during_resolution_is_a_cancellation() {
    let inference = Arc::new(Inference::with_cache_retention(false));
    let release = Arc::new(Notify::new());
    let task = tokio::spawn({
        let (inference, release) = (inference.clone(), release.clone());
        async move {
            let mut on_delta = ignore;
            inference
                .run(&SlowResolver(release), &request(), "node-1", &mut on_delta)
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    inference.cancel_all();
    let message = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(message.stop_reason, StopReason::Aborted);
    assert_eq!(
        message.error_message.as_deref(),
        Some("Model request cancelled")
    );
    drop(release);
}
