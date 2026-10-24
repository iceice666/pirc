#![cfg(feature = "_transport")]
//! Exercise the public boundary without pirc-protocol/config/backend policy.
use pirc_llm::types::{Model, Provider, StopReason, ThinkingLevel};
use pirc_llm::{Route, StreamRequest, Transport};
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

fn provider() -> Provider {
    serde_json::from_value(json!({
        "api": "openai-completions", "baseUrl": "invalid", "piProvider": "cloudflare-workers-ai",
        "models": [{"id": "test"}]
    }))
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn stale_and_closed_generations_do_not_resolve_urls_or_emit() {
    let provider = provider();
    let model: &Model = &provider.models[0];
    let request = StreamRequest {
        provider_name: "host-label",
        provider: &provider,
        model,
        api_key: Some("key"),
        system_prompt: "",
        messages: &[],
        tools: &[],
        thinking: ThinkingLevel::Off,
        session_id: "opaque-not-derived-by-library".to_owned(),
        codex_user_agent: "pi (synthetic-host synthetic-release; synthetic-arch)",
        max_tokens: None,
        tool_choice: None,
        resolve_variable: &|_| panic!("a stale run must never prepare a request"),
    };
    // no_proxy is deliberate: reqwest's default builder consults system/env
    // proxy settings; only the caller chooses to do that, not Transport::new.
    let transport = Transport::new(client(), false);
    let (cancel, rx) = watch::channel(0_u64);
    cancel.send_modify(|generation| *generation += 1);
    let reply = transport
        .run(Route::Completions, &request, rx, &mut |_, _| {
            panic!("delta after cancellation")
        })
        .await;
    assert_eq!(reply.stop_reason, StopReason::Aborted);
    assert_eq!(reply.api, "openai-completions");
    assert_eq!(reply.provider, "host-label");
    assert_eq!(
        reply.error_message.as_deref(),
        Some("Model request cancelled")
    );
    let rx = cancel.subscribe();
    drop(cancel);
    let reply = transport
        .run(Route::Chat, &request, rx, &mut |_, _| {
            panic!("delta after close")
        })
        .await;
    assert_eq!(reply.stop_reason, StopReason::Aborted);
}

#[cfg(not(feature = "openai-chat"))]
#[tokio::test(flavor = "current_thread")]
async fn disabled_api_does_not_fall_back_to_an_enabled_wire() {
    let provider = provider();
    let request = StreamRequest {
        provider_name: "label",
        provider: &provider,
        model: &provider.models[0],
        api_key: None,
        system_prompt: "",
        messages: &[],
        tools: &[],
        thinking: ThinkingLevel::Off,
        session_id: "cache".to_owned(),
        codex_user_agent: "pi (synthetic-host synthetic-release; synthetic-arch)",
        max_tokens: None,
        tool_choice: None,
        resolve_variable: &|_| panic!("disabled wire should not resolve variables"),
    };
    let transport = Transport::new(client(), false);
    let (_cancel, rx) = watch::channel(0);
    let reply = transport
        .run(Route::Chat, &request, rx, &mut |_, _| {
            panic!("unexpected delta")
        })
        .await;
    assert_eq!(reply.stop_reason, StopReason::Error);
    assert_eq!(
        reply.error_message.as_deref(),
        Some("Requested wire API feature is disabled")
    );
}

#[cfg(feature = "openai-codex-responses")]
#[tokio::test(flavor = "current_thread")]
async fn codex_uses_the_exact_injected_host_fingerprint() {
    use axum::{Router, extract::State, http::HeaderMap, response::IntoResponse, routing::post};
    const FINGERPRINT: &str = "pi (synthetic-host synthetic-release; synthetic-arch)";
    async fn capture(
        State(sent): State<tokio::sync::mpsc::Sender<String>>,
        headers: HeaderMap,
    ) -> impl IntoResponse {
        sent.send(headers["user-agent"].to_str().unwrap().to_owned())
            .await
            .unwrap();
        // An empty completed response is sufficient; this test asserts request identity,
        // not model output. No real endpoint, credential lookup or host OS probe.
        (
            [("content-type", "text/event-stream")],
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n",
        )
    }
    let (sent, mut observed) = tokio::sync::mpsc::channel(1);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/codex/responses", post(capture))
                .with_state(sent),
        )
        .await
        .unwrap();
    });
    let provider: Provider = serde_json::from_value(json!({
        "api": "openai-codex-responses", "baseUrl": format!("http://{address}"),
        "piProvider": "openai-codex", "headers": {"User-Agent":"must-be-overridden"},
        "models": [{"id":"synthetic"}]
    }))
    .unwrap();
    // {"https://api.openai.com/auth":{"chatgpt_account_id":"acct_1"}}
    let token =
        "h.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xIn19.s";
    let request = StreamRequest {
        provider_name: "host",
        provider: &provider,
        model: &provider.models[0],
        api_key: Some(token),
        system_prompt: "",
        messages: &[],
        tools: &[],
        thinking: ThinkingLevel::Off,
        session_id: "opaque".to_owned(),
        codex_user_agent: FINGERPRINT,
        max_tokens: None,
        tool_choice: None,
        resolve_variable: &|_| panic!("no variable needed"),
    };
    let transport = Transport::new(client(), false);
    let (_cancel, rx) = watch::channel(0);
    let _reply = transport
        .run(Route::Codex, &request, rx, &mut |_, _| {})
        .await;
    let actual = tokio::time::timeout(std::time::Duration::from_secs(2), observed.recv())
        .await
        .unwrap();
    assert_eq!(actual.as_deref(), Some(FINGERPRINT));
    server.abort();
}
