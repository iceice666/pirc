//! The node half of `inference-transport.test.ts`, with the Rust agent's
//! own client (`pirc_agent::remote`) as the TS test used the TS agent's.

use std::os::unix::fs::PermissionsExt;

use pirc_agent::remote::{RemoteStream, fetch_remote_models, inference_request as project};
use pirc_agent::signal::AbortController;
use pirc_agent::stream::{StreamFn, StreamRequest};
use pirc_protocol::{AssistantDelta, AssistantMessage, Message, StopReason, ThinkingLevel};

use super::*;

fn models() -> Models {
    pirc_agent::remote::parse_models(&json!({ "providers": { "test": {
        "api": "openai-chat",
        "baseUrl": "https://secret.invalid",
        "apiKey": "provider-secret",
        "headers": { "authorization": "header-secret" },
        "models": [{ "id": "model" }],
    } } }))
    .unwrap()
}

fn request(signal: pirc_agent::signal::AbortSignal) -> StreamRequest {
    let models = models();
    let provider = models.providers["test"].clone();
    StreamRequest {
        provider_name: "test".into(),
        model: provider.models[0].clone(),
        provider,
        system_prompt: "system".into(),
        messages: vec![
            serde_json::from_value(json!({ "role": "user", "content": "hello", "timestamp": 1 }))
                .unwrap(),
        ],
        tools: Vec::new(),
        thinking: ThinkingLevel::Off,
        session_id: "session".into(),
        signal,
        max_tokens: None,
        tool_choice: None,
    }
}

fn final_message() -> AssistantMessage {
    serde_json::from_value(json!({
        "role": "assistant", "api": "openai-chat", "provider": "test", "model": "model",
        "content": [{ "type": "text", "text": "hello", "textSignature": "sig" }],
        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 },
        "stopReason": "stop", "timestamp": 1, "responseId": "response",
        "canonicalProvider": "openai",
    }))
    .unwrap()
}

type Sent = Arc<Mutex<Vec<NodeMessage>>>;

/// A relay whose link records every frame (and accepts it), with a hook
/// run on each.
async fn relay(
    timeout: Duration,
    hook: impl Fn(&Arc<Relay>, &NodeMessage) + Send + Sync + 'static,
) -> (Arc<Relay>, Sent, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let sent: Sent = Arc::default();
    let cell: Arc<OnceLock<std::sync::Weak<Relay>>> = Arc::default();
    let (sink, me) = (sent.clone(), cell.clone());
    let config: Arc<OnceLock<InferenceConfig>> = Arc::default();
    let catalog = config.clone();
    let relay = Relay::start(
        dir.path(),
        Arc::new(move |message: &NodeMessage| {
            sink.lock().unwrap().push(message.clone());
            if let Some(relay) = me.get().and_then(std::sync::Weak::upgrade) {
                hook(&relay, message);
            }
            true
        }),
        Arc::new(move || {
            let mut models = models();
            models.inference = catalog.get().cloned();
            models
        }),
        timeout,
    )
    .await
    .unwrap();
    cell.set(Arc::downgrade(&relay)).unwrap();
    config.set(relay.config.clone()).unwrap();
    (relay, sent, dir)
}

fn request_id(message: &NodeMessage) -> String {
    match message {
        NodeMessage::ModelStart { request_id, .. } | NodeMessage::ModelCancel { request_id } => {
            request_id.clone()
        }
        other => panic!("unexpected {other:?}"),
    }
}

async fn until(check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(check());
}

#[tokio::test]
async fn authenticates_projects_requests_preserves_replay_metadata_and_cleans_the_socket() {
    let (relay, sent, _dir) = relay(Duration::from_secs(600), |relay, message| {
        if let NodeMessage::ModelStart { request_id, .. } = message {
            let relay = relay.clone();
            let request_id = request_id.clone();
            // After `send` returned, as the gateway's frames arrive later.
            tokio::spawn(async move {
                relay.receive(GatewayMessage::ModelDelta {
                    request_id: request_id.clone(),
                    delta: AssistantDelta::TextDelta {
                        content_index: 0,
                        delta: "hello".into(),
                    },
                });
                relay.receive(GatewayMessage::ModelEnd {
                    request_id,
                    message: Message::Assistant(final_message()),
                });
            });
        }
    })
    .await;
    let socket = Path::new(&relay.config.socket_path);
    assert_eq!(
        std::fs::metadata(socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let forbidden = InferenceConfig {
        socket_path: relay.config.socket_path.clone(),
        token: "wrong".into(),
    };
    assert!(fetch_remote_models(&forbidden).await.is_err());
    assert_eq!(
        fetch_remote_models(&relay.config).await.unwrap().inference,
        Some(relay.config.clone())
    );
    let mut deltas = Vec::new();
    let message = RemoteStream {
        config: relay.config.clone(),
    }
    .stream(
        request(AbortController::new().signal()),
        &mut |delta: &AssistantDelta| {
            deltas.push(serde_json::to_value(delta).unwrap()["type"].clone());
        },
    )
    .await;
    assert_eq!(message, final_message());
    assert_eq!(deltas, [json!("text_delta")]);
    let start = serde_json::to_string(&sent.lock().unwrap()[0]).unwrap();
    for secret in [
        "provider-secret",
        "header-secret",
        "secret.invalid",
        "apiKey",
        "baseUrl",
    ] {
        assert!(!start.contains(secret), "{secret} in {start}");
    }
    let start: Value = serde_json::from_str(&start).unwrap();
    assert_eq!(start["request"]["modelId"], "model");
    let id = start["requestId"].as_str().unwrap();
    assert!(id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    assert_eq!(sent.lock().unwrap().len(), 1);
    relay.close().await;
    assert!(!socket.exists());
    assert!(!socket.parent().unwrap().exists());
}

#[tokio::test]
async fn abort_cancels_exactly_once_with_a_node_generated_id() {
    let (relay, sent, _dir) = relay(Duration::from_secs(600), |_, _| {}).await;
    let abort = AbortController::new();
    let client = RemoteStream {
        config: relay.config.clone(),
    };
    let mut ignore = |_: &AssistantDelta| {};
    let (message, ()) = tokio::join!(client.stream(request(abort.signal()), &mut ignore), async {
        until(|| sent.lock().unwrap().len() == 1).await;
        abort.abort();
    });
    assert_eq!(message.stop_reason, StopReason::Aborted);
    until(|| sent.lock().unwrap().len() == 2).await;
    let sent = sent.lock().unwrap().clone();
    assert!(matches!(sent[1], NodeMessage::ModelCancel { .. }));
    assert_eq!(request_id(&sent[1]), request_id(&sent[0]));
    relay.close().await;
}

#[tokio::test]
async fn disconnect_ends_streams_without_retry_and_timeouts_cancel() {
    let (relay, sent, _dir) = relay(Duration::from_secs(600), |_, _| {}).await;
    let client = RemoteStream {
        config: relay.config.clone(),
    };
    let mut ignore = |_: &AssistantDelta| {};
    let (message, ()) = tokio::join!(
        client.stream(request(AbortController::new().signal()), &mut ignore),
        async {
            until(|| sent.lock().unwrap().len() == 1).await;
            relay.disconnect();
        }
    );
    assert_eq!(
        message.error_message.as_deref(),
        Some("Gateway inference is unavailable")
    );
    assert_eq!(sent.lock().unwrap().len(), 1);
    relay.close().await;

    let (relay, sent, _dir) = relay_with_timeout().await;
    let message = RemoteStream {
        config: relay.config.clone(),
    }
    .stream(request(AbortController::new().signal()), &mut ignore)
    .await;
    assert_eq!(
        message.error_message.as_deref(),
        Some("Inference request timed out")
    );
    let kinds: Vec<_> = sent
        .lock()
        .unwrap()
        .iter()
        .map(|message| serde_json::to_value(message).unwrap()["type"].clone())
        .collect();
    assert_eq!(kinds, [json!("model_start"), json!("model_cancel")]);
    relay.close().await;
}

async fn relay_with_timeout() -> (Arc<Relay>, Sent, tempfile::TempDir) {
    relay(Duration::from_millis(20), |_, _| {}).await
}

/// One raw request; the status and body.
async fn raw(config: &InferenceConfig, request: &[u8]) -> (u16, String) {
    let mut stream = UnixStream::connect(&config.socket_path).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text[9..12].parse().unwrap();
    let body = text.split_once("\r\n\r\n").unwrap().1.to_owned();
    (status, body)
}

fn post(config: &InferenceConfig, path: &str, body: &str) -> Vec<u8> {
    format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\n\
         Content-Length: {}\r\n\r\n{body}",
        config.token,
        body.len()
    )
    .into_bytes()
}

#[tokio::test]
async fn rejects_oversize_requests_locally_and_malformed_or_secret_bearing_input() {
    let (relay, sent, _dir) = relay(Duration::from_secs(600), |_, _| {}).await;
    let mut large = request(AbortController::new().signal());
    large.system_prompt = "x".repeat(INFERENCE_REQUEST_MAX_BYTES);
    let message = RemoteStream {
        config: relay.config.clone(),
    }
    .stream(large, &mut |_| {})
    .await;
    assert!(message.error_message.unwrap().contains("limit"));
    assert!(sent.lock().unwrap().is_empty());

    let mut payload =
        serde_json::to_value(project(&request(AbortController::new().signal()))).unwrap();
    assert!(inference_request(payload.clone()).is_some());
    payload["apiKey"] = json!("forbidden");
    assert!(inference_request(payload.clone()).is_none());
    let (status, body) = raw(
        &relay.config,
        &post(&relay.config, "/inference", &payload.to_string()),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(
        body,
        "{\"type\":\"model_error\",\"code\":\"invalid_request\"}\n"
    );
    assert!(!body.contains("forbidden"));
    assert!(sent.lock().unwrap().is_empty());

    // Lengths serde does not check.
    let mut empty =
        serde_json::to_value(project(&request(AbortController::new().signal()))).unwrap();
    empty["providerName"] = json!("");
    assert!(inference_request(empty).is_none());
    // Other paths, a body too large for its Content-Length, chunked bodies.
    assert_eq!(
        raw(&relay.config, &post(&relay.config, "/other", ""))
            .await
            .0,
        404
    );
    let huge = format!(
        "POST /inference HTTP/1.1\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n",
        relay.config.token,
        INFERENCE_REQUEST_MAX_BYTES + 1
    );
    assert_eq!(
        raw(&relay.config, huge.as_bytes()).await,
        (
            413,
            "{\"type\":\"model_error\",\"code\":\"limit_exceeded\"}\n".to_owned()
        )
    );
    let chunked = format!(
        "POST /inference HTTP/1.1\r\nAuthorization: Bearer {}\r\nTransfer-Encoding: chunked\r\n\r\n\
         2\r\n{{}}\r\n0\r\n\r\n",
        relay.config.token
    );
    assert_eq!(raw(&relay.config, chunked.as_bytes()).await.0, 400);
    let models = format!(
        "GET /models HTTP/1.1\r\nAuthorization: Bearer {}\r\n\r\n",
        relay.config.token
    );
    let (status, body) = raw(&relay.config, models.as_bytes()).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["inference"]["token"],
        json!(relay.config.token)
    );
    let unauthorized = raw(&relay.config, b"GET /models HTTP/1.1\r\n\r\n").await;
    assert_eq!(unauthorized.0, 401);
    relay.close().await;
}

#[tokio::test]
async fn limits_the_requests_in_flight_and_refused_starts_do_not_cancel() {
    let (relay, sent, _dir) = relay(Duration::from_secs(600), |_, _| {}).await;
    let body = serde_json::to_value(project(&request(AbortController::new().signal())))
        .unwrap()
        .to_string();
    let mut streams = Vec::new();
    for _ in 0..INFERENCE_MAX_REQUESTS {
        let mut stream = UnixStream::connect(&relay.config.socket_path)
            .await
            .unwrap();
        stream
            .write_all(&post(&relay.config, "/inference", &body))
            .await
            .unwrap();
        streams.push(stream);
    }
    until(|| sent.lock().unwrap().len() == INFERENCE_MAX_REQUESTS).await;
    let (status, _) = raw(&relay.config, &post(&relay.config, "/inference", &body)).await;
    assert_eq!(status, 429);
    drop(streams);
    until(|| sent.lock().unwrap().len() == 2 * INFERENCE_MAX_REQUESTS).await;
    relay.close().await;

    // A start the link refuses ends the stream unavailable, without a cancel.
    let dir = tempfile::tempdir().unwrap();
    let relay = Relay::start(
        dir.path(),
        Arc::new(|_: &NodeMessage| false),
        Arc::new(models),
        Duration::from_secs(600),
    )
    .await
    .unwrap();
    let (status, body) = raw(&relay.config, &post(&relay.config, "/inference", &body)).await;
    assert_eq!(status, 200);
    assert!(body.contains("{\"type\":\"model_error\",\"code\":\"unavailable\"}"));
    relay.close().await;
    assert!(
        UnixStream::connect(&relay.config.socket_path)
            .await
            .is_err()
    );
}
