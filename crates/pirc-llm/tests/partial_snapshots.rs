#![cfg(feature = "openai-completions")]
//! Public, synthetic HTTP coverage: batching one SSE chunk must not change
//! callback order, complete partial snapshots, or cancellation checkpoints.
use axum::{Router, response::IntoResponse, routing::post};
use pirc_llm::types::{
    AssistantContent, AssistantDelta, AssistantMessage, Provider, StopReason, ThinkingLevel, Usage,
};
use pirc_llm::{Route, StreamRequest, Transport, assistant};
use serde_json::json;
use tokio::sync::watch;

fn client() -> reqwest::Client {
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    reqwest::Client::builder()
        .no_proxy()
        .tls_backend_preconfigured(tls)
        .build()
        .unwrap()
}

fn tool(arguments: serde_json::Value) -> AssistantContent {
    AssistantContent::ToolCall {
        id: "call-1".to_owned(),
        name: "lookup".to_owned(),
        arguments: arguments.as_object().unwrap().clone(),
        thought_signature: None,
    }
}

fn snapshot(text: &str, thinking: &str, arguments: serde_json::Value) -> AssistantMessage {
    let mut message = assistant("openai-completions", "host-label", "test", StopReason::Stop);
    message.timestamp = 0;
    message.canonical_provider = Some("openai".to_owned());
    message.response_id = Some("synthetic-response".to_owned());
    message.response_model = Some("wire-model".to_owned());
    message.content = vec![
        AssistantContent::Text {
            text: text.to_owned(),
            text_signature: None,
        },
        AssistantContent::Thinking {
            thinking: thinking.to_owned(),
            signature: Some("reasoning_content".to_owned()),
            redacted: None,
        },
        tool(arguments),
    ];
    message
}

fn expected() -> Vec<(AssistantDelta, AssistantMessage)> {
    use AssistantDelta::*;
    let first = snapshot("caf", "think", json!({"query":"ca"}));
    let second = snapshot("café", "thinking", json!({"query":"café"}));
    let mut final_snapshot = second.clone();
    final_snapshot.stop_reason = StopReason::ToolUse;
    final_snapshot.usage = Usage {
        input: 5,
        output: 3,
        cache_read: 2,
        cache_write: 1,
        total_tokens: 11,
    };
    let mut events = Vec::new();
    for delta in [
        TextStart { content_index: 0 },
        TextDelta {
            content_index: 0,
            delta: "caf".to_owned(),
        },
        ThinkingStart { content_index: 1 },
        ThinkingDelta {
            content_index: 1,
            delta: "think".to_owned(),
        },
        ToolcallStart {
            content_index: 2,
            id: "call-1".to_owned(),
            tool_name: "lookup".to_owned(),
        },
        ToolcallDelta {
            content_index: 2,
            delta: "{\"query\":\"ca".to_owned(),
        },
    ] {
        events.push((delta, first.clone()));
    }
    for delta in [
        TextDelta {
            content_index: 0,
            delta: "é".to_owned(),
        },
        ThinkingDelta {
            content_index: 1,
            delta: "ing".to_owned(),
        },
        ToolcallDelta {
            content_index: 2,
            delta: "fé\"}".to_owned(),
        },
    ] {
        events.push((delta, second.clone()));
    }
    for delta in [
        TextEnd {
            content_index: 0,
            content: "café".to_owned(),
        },
        ThinkingEnd {
            content_index: 1,
            content: "thinking".to_owned(),
        },
        ToolcallEnd {
            content_index: 2,
            tool_call: tool(json!({"query":"café"})),
        },
    ] {
        events.push((delta, final_snapshot.clone()));
    }
    events
}

async fn response() -> impl IntoResponse {
    let chunks = [
        json!({"id":"synthetic-response", "model":"wire-model", "choices":[{"delta":{
            "content":"caf", "reasoning_content":"think", "tool_calls":[{
                "index":0, "id":"call-1", "function":{"name":"lookup", "arguments":"{\"query\":\"ca"}
            }]
        }}]}),
        json!({"choices":[{"delta":{
            "content":"é", "reasoning_content":"ing", "tool_calls":[{
                "index":0, "function":{"arguments":"fé\"}"}
            }]
        }}]}),
        json!({"choices":[{"delta":{}, "finish_reason":"tool_calls"}], "usage":{
            "prompt_tokens":8, "completion_tokens":3,
            "prompt_tokens_details":{"cached_tokens":3, "cache_write_tokens":1}
        }}),
    ];
    // All events in one body intentionally exercise cancellation between
    // callbacks even when subsequent events are already buffered locally.
    let mut body = chunks
        .iter()
        .map(|chunk| format!("data: {chunk}\r\n\r\n"))
        .collect::<String>();
    body.push_str("data: [DONE]\r\n\r\n");
    ([("content-type", "text/event-stream")], body)
}

#[tokio::test(flavor = "current_thread")]
async fn every_callback_has_the_complete_partial_and_can_cancel() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/chat/completions", post(response)),
        )
        .await
        .unwrap();
    });
    let provider: Provider = serde_json::from_value(json!({
        "api":"openai-completions", "baseUrl":format!("http://{address}"),
        "piProvider":"openai", "models":[{"id":"test"}]
    }))
    .unwrap();
    let request = StreamRequest {
        provider_name: "host-label",
        provider: &provider,
        model: &provider.models[0],
        api_key: Some("synthetic-key"),
        system_prompt: "",
        messages: &[],
        tools: &[],
        thinking: ThinkingLevel::Off,
        session_id: "opaque".to_owned(),
        codex_user_agent: "synthetic",
        max_tokens: None,
        tool_choice: None,
        resolve_variable: &|_| panic!("no substitution needed"),
    };
    let transport = Transport::new(client(), false);
    let expected = expected();
    // First complete normally, then cancel synchronously at EVERY callback.
    for cancel_at in std::iter::once(None).chain((0..expected.len()).map(Some)) {
        let (cancel, rx) = watch::channel(0);
        let mut observed = Vec::new();
        let mut reply = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            transport.run(Route::Completions, &request, rx, &mut |delta, partial| {
                let mut partial = partial.clone();
                partial.timestamp = 0;
                observed.push((delta.clone(), partial));
                if cancel_at == Some(observed.len() - 1) {
                    cancel.send_modify(|generation| *generation += 1);
                }
            }),
        )
        .await
        .unwrap();
        reply.timestamp = 0;
        let count = cancel_at.map_or(expected.len(), |index| index + 1);
        assert_eq!(observed, expected[..count], "cancel at {cancel_at:?}");
        let mut expected_reply = expected[count - 1].1.clone();
        if cancel_at.is_some() {
            expected_reply.stop_reason = StopReason::Aborted;
            expected_reply.error_message = Some("Model request cancelled".to_owned());
        }
        assert_eq!(reply, expected_reply, "cancel at {cancel_at:?}");
    }
    server.abort();
}
