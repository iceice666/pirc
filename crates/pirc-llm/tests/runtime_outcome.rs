#![cfg(feature = "_transport")]
//! Public runtime boundary: no provider catalog is needed by the typed execution path.
use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::post};
#[cfg(feature = "openai-chat")]
use pirc_llm::StreamRequest;
use pirc_llm::types::ModelApi;
#[cfg(feature = "openai-chat")]
use pirc_llm::types::{AssistantDelta, AssistantMessage, Provider, StopReason, ThinkingLevel};
use pirc_llm::{
    Auth, ErrorKind, ResolvedEndpoint, ResolvedModel, Route, RunOutcome, RunRequest, Termination,
    Transport,
};
#[cfg(feature = "openai-chat")]
use serde_json::{Value, json};
use tokio::sync::watch;

fn client() -> reqwest::Client {
    client_with_timeout(None)
}

fn client_with_timeout(timeout: Option<std::time::Duration>) -> reqwest::Client {
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    let builder = reqwest::Client::builder()
        .no_proxy()
        .tls_backend_preconfigured(tls);
    match timeout {
        Some(timeout) => builder.timeout(timeout),
        None => builder,
    }
    .build()
    .unwrap()
}

struct Server {
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(status: StatusCode, body: &str) -> Server {
    async fn respond(State((status, body)): State<(StatusCode, String)>) -> impl IntoResponse {
        (status, [("content-type", "text/event-stream")], body)
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .fallback(post(respond))
        .with_state((status, body.to_owned()));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Server { base, task }
}
fn enabled_routes() -> Vec<(Route, ModelApi)> {
    vec![
        #[cfg(feature = "openai-chat")]
        (Route::Chat, ModelApi::OpenaiChat),
        #[cfg(feature = "anthropic-messages")]
        (Route::NativeAnthropic, ModelApi::AnthropicMessages),
        #[cfg(feature = "anthropic-messages")]
        (Route::Anthropic, ModelApi::AnthropicMessages),
        #[cfg(feature = "openai-completions")]
        (Route::Completions, ModelApi::OpenaiCompletions),
        #[cfg(feature = "openai-responses")]
        (Route::Responses, ModelApi::OpenaiResponses),
        #[cfg(feature = "openai-codex-responses")]
        (Route::Codex, ModelApi::OpenaiCodexResponses),
    ]
}
fn failed(outcome: &RunOutcome) -> &pirc_llm::LlmError {
    match &outcome.termination {
        Termination::Failed(error) => error,
        other => panic!("expected failure: {other:?}"),
    }
}
fn key(route: Route) -> &'static str {
    if route == Route::Codex {
        // Synthetic, unsigned account claim for the isolated local transport test.
        "h.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xIn19.s"
    } else {
        "synthetic-key"
    }
}
async fn execute(route: Route, request: &RunRequest<'_>) -> RunOutcome {
    let (_cancel, receiver) = watch::channel(0);
    Transport::new(client(), false)
        .run_request(route, request, receiver, &mut |_, _| {})
        .await
}

#[tokio::test(flavor = "current_thread")]
async fn http_status_and_diagnostics_are_structured_on_every_enabled_route() {
    let server = server(
        StatusCode::UNAUTHORIZED,
        r#"{"error":{"message":"synthetic-secret-body"}}"#,
    )
    .await;
    for (route, api) in enabled_routes() {
        let endpoint = ResolvedEndpoint::new(api, "synthetic", &server.base);
        let model = ResolvedModel::new("synthetic", 64);
        let mut request = RunRequest::new("host", &endpoint, &model);
        request.auth = Auth::Key(key(route));
        let outcome = execute(route, &request).await;
        let error = failed(&outcome);
        assert_eq!(error.status(), Some(401), "{route:?}");
        assert_eq!(error.kind(), ErrorKind::Http, "{route:?}");
        assert!(
            error
                .diagnostics()
                .unwrap()
                .contains("synthetic-secret-body"),
            "{route:?}"
        );
        assert!(
            !format!("{error} {error:?} {outcome:?}").contains("synthetic-secret-body"),
            "{route:?}"
        );
        assert!(
            !outcome
                .message
                .error_message
                .as_deref()
                .unwrap()
                .contains("synthetic-secret-body"),
            "{route:?}"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_endpoint_and_headers_have_typed_early_failures() {
    for (route, api) in enabled_routes() {
        let mut endpoint = ResolvedEndpoint::new(api, "synthetic", "not a URL");
        let model = ResolvedModel::new("synthetic", 64);
        let mut request = RunRequest::new("host", &endpoint, &model);
        request.auth = Auth::Key(key(route));
        let outcome = execute(route, &request).await;
        assert_eq!(
            failed(&outcome).kind(),
            ErrorKind::InvalidRequest,
            "invalid URL {route:?}"
        );
        endpoint.base_url = "http://127.0.0.1:1".to_owned();
        endpoint.opencode_base_url = endpoint.base_url.clone();
        endpoint
            .headers
            .insert("bad\nname".to_owned(), "value".to_owned());
        let mut request = RunRequest::new("host", &endpoint, &model);
        request.auth = Auth::Key(key(route));
        let outcome = execute(route, &request).await;
        assert_eq!(
            failed(&outcome).kind(),
            ErrorKind::InvalidRequest,
            "invalid header {route:?}"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn managed_credentials_fail_before_url_lookup_or_dispatch() {
    for (route, api) in enabled_routes()
        .into_iter()
        .filter(|(route, _)| !matches!(route, Route::Chat | Route::NativeAnthropic))
    {
        let mut endpoint = ResolvedEndpoint::new(api, "managed", "not a URL/{MISSING}");
        endpoint.managed_credentials = true;
        let model = ResolvedModel::new("synthetic", 64);
        let mut request = RunRequest::new("host", &endpoint, &model);
        request.options.resolve_variable =
            &|_| panic!("missing credentials must win before host lookup");
        let outcome = execute(route, &request).await;
        assert_eq!(
            failed(&outcome).kind(),
            ErrorKind::CredentialsUnavailable,
            "{route:?}"
        );
    }
}

#[cfg(not(feature = "openai-chat"))]
#[tokio::test(flavor = "current_thread")]
async fn disabled_feature_has_typed_failure_and_does_not_prepare_request() {
    let endpoint = ResolvedEndpoint::new(ModelApi::OpenaiChat, "host", "invalid");
    let model = ResolvedModel::new("synthetic", 64);
    let mut request = RunRequest::new("host", &endpoint, &model);
    request.options.resolve_variable = &|_| panic!("disabled API must not resolve variables");
    let outcome = execute(Route::Chat, &request).await;
    assert_eq!(failed(&outcome).kind(), ErrorKind::FeatureDisabled);
    assert_eq!(
        outcome.into_legacy_message().error_message.as_deref(),
        Some("Requested wire API feature is disabled")
    );
}

#[cfg(feature = "openai-chat")]
const PARTIAL_THEN_INVALID: &str = "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2,\"total_tokens\":11},\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: invalid-json\n\n";

#[cfg(feature = "openai-chat")]
#[tokio::test(flavor = "current_thread")]
async fn protocol_failure_preserves_partial_content_and_usage() {
    let server = server(StatusCode::OK, PARTIAL_THEN_INVALID).await;
    let endpoint = ResolvedEndpoint::new(ModelApi::OpenaiChat, "synthetic", &server.base);
    let model = ResolvedModel::new("synthetic", 64);
    let outcome = execute(Route::Chat, &RunRequest::new("host", &endpoint, &model)).await;
    assert_eq!(failed(&outcome).kind(), ErrorKind::Protocol);
    assert!(
        failed(&outcome)
            .diagnostics()
            .unwrap()
            .contains("JSON Parse error")
    );
    assert_eq!(
        serde_json::to_value(&outcome.message.content).unwrap(),
        json!([{"type":"text","text":"partial"}])
    );
    assert_eq!(outcome.message.usage.input, 9);
    assert_eq!(outcome.message.usage.output, 2);
    assert_eq!(outcome.message.usage.total_tokens, 11);
    assert_eq!(outcome.message.stop_reason, StopReason::Error);
}

#[cfg(feature = "openai-chat")]
#[tokio::test(flavor = "current_thread")]
async fn callback_cancellation_wins_an_error_already_recorded_during_cleanup() {
    let server = server(StatusCode::OK, PARTIAL_THEN_INVALID).await;
    let endpoint = ResolvedEndpoint::new(ModelApi::OpenaiChat, "synthetic", &server.base);
    let model = ResolvedModel::new("synthetic", 64);
    let request = RunRequest::new("host", &endpoint, &model);
    let (cancel, receiver) = watch::channel(0);
    let mut ended = false;
    let outcome = Transport::new(client(), false)
        .run_request(Route::Chat, &request, receiver, &mut |delta, _| {
            if matches!(delta, AssistantDelta::TextEnd { .. }) {
                ended = true;
                cancel.send_modify(|generation| *generation += 1);
            } else {
                assert!(!ended, "delta after cancellation");
            }
        })
        .await;
    assert!(ended);
    assert!(matches!(outcome.termination, Termination::Cancelled));
    assert_eq!(outcome.message.stop_reason, StopReason::Aborted);
    assert_eq!(
        outcome.message.error_message.as_deref(),
        Some("Model request cancelled")
    );
    assert_eq!(outcome.message.usage.total_tokens, 11);
    assert_eq!(
        serde_json::to_value(outcome.message.content).unwrap(),
        json!([{"type":"text","text":"partial"}])
    );
}

#[cfg(feature = "openai-chat")]
fn normalized(message: &AssistantMessage) -> Value {
    let mut value = serde_json::to_value(message).unwrap();
    value.as_object_mut().unwrap().remove("timestamp");
    value.as_object_mut().unwrap().remove("completedAt");
    value
}

#[cfg(feature = "openai-chat")]
#[tokio::test(flavor = "current_thread")]
async fn legacy_run_and_runtime_conversion_preserve_errors_and_every_snapshot() {
    let server = server(StatusCode::OK, PARTIAL_THEN_INVALID).await;
    let provider: Provider = serde_json::from_value(
        json!({"api":"openai-chat","baseUrl":server.base,"models":[{"id":"synthetic"}]}),
    )
    .unwrap();
    let legacy = StreamRequest {
        provider_name: "host",
        provider: &provider,
        model: &provider.models[0],
        api_key: None,
        system_prompt: "",
        messages: &[],
        tools: &[],
        thinking: ThinkingLevel::Off,
        session_id: "borrowed".to_owned(),
        codex_user_agent: "",
        max_tokens: None,
        tool_choice: None,
        resolve_variable: &|_| None,
    };
    let transport = Transport::new(client(), false);
    let (_cancel, receiver) = watch::channel(0);
    let mut legacy_deltas = Vec::new();
    let old = transport
        .run(Route::Chat, &legacy, receiver, &mut |delta, partial| {
            legacy_deltas.push((delta.clone(), normalized(partial)))
        })
        .await;
    let (endpoint, model) = legacy.resolve(Route::Chat);
    let request = legacy.runtime(&endpoint, &model);
    let (_cancel, receiver) = watch::channel(0);
    let mut runtime_deltas = Vec::new();
    let new = transport
        .run_request(Route::Chat, &request, receiver, &mut |delta, partial| {
            runtime_deltas.push((delta.clone(), normalized(partial)))
        })
        .await
        .into_legacy_message();
    assert_eq!(normalized(&old), normalized(&new));
    assert_eq!(legacy_deltas, runtime_deltas);
    assert!(old.error_message.unwrap().contains("JSON Parse error"));
}

#[tokio::test(flavor = "current_thread")]
async fn transport_connection_failures_are_not_http_failures() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    for (route, api) in enabled_routes()
        .into_iter()
        .filter(|(route, _)| *route != Route::Codex)
    {
        let endpoint = ResolvedEndpoint::new(api, "synthetic", &base);
        let model = ResolvedModel::new("synthetic", 64);
        let mut request = RunRequest::new("host", &endpoint, &model);
        request.auth = Auth::Key(key(route));
        let outcome = execute(route, &request).await;
        assert_eq!(failed(&outcome).kind(), ErrorKind::Network, "{route:?}");
        assert_eq!(failed(&outcome).status(), None, "{route:?}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn status_classification_preserves_actual_status_and_uses_body_fallback() {
    for (status, body, expected) in [
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            "synthetic opaque body HTTP 502",
            ErrorKind::ContextWindow,
        ),
        (
            StatusCode::TOO_MANY_REQUESTS,
            "synthetic opaque body HTTP 502",
            ErrorKind::RateLimited,
        ),
        (
            StatusCode::BAD_REQUEST,
            "context window exceeded synthetic-detail HTTP 502",
            ErrorKind::ContextWindow,
        ),
        (
            StatusCode::BAD_REQUEST,
            "usage limit synthetic-detail HTTP 502",
            ErrorKind::RateLimited,
        ),
    ] {
        // Text never fabricates HTTP status; body classification supplements non-specific status.
        let server = server(status, body).await;
        for (route, api) in enabled_routes()
            .into_iter()
            .filter(|(route, _)| *route != Route::Codex)
        {
            let endpoint = ResolvedEndpoint::new(api, "synthetic", &server.base);
            let model = ResolvedModel::new("synthetic", 64);
            let mut request = RunRequest::new("host", &endpoint, &model);
            request.auth = Auth::Key(key(route));
            let outcome = execute(route, &request).await;
            assert_eq!(failed(&outcome).kind(), expected, "{route:?}");
            assert_eq!(
                failed(&outcome).status(),
                Some(status.as_u16()),
                "{route:?}"
            );
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn provider_error_events_are_classified_before_legacy_rendering() {
    for (message, expected) in [
        ("rate limit synthetic-event-detail", ErrorKind::RateLimited),
        (
            "context window exceeded synthetic-event-detail",
            ErrorKind::ContextWindow,
        ),
    ] {
        for (route, api) in enabled_routes()
            .into_iter()
            .filter(|(route, _)| *route != Route::Codex)
        {
            let data = if matches!(route, Route::Responses) {
                format!(
                    "data: {{\"type\":\"error\",\"code\":\"provider_error\",\"message\":{}}}\n\n",
                    serde_json::to_string(message).unwrap()
                )
            } else if matches!(route, Route::Anthropic | Route::NativeAnthropic) {
                format!(
                    "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"message\":{}}}}}\n\n",
                    serde_json::to_string(message).unwrap()
                )
            } else {
                format!(
                    "data: {{\"error\":{{\"message\":{}}}}}\n\n",
                    serde_json::to_string(message).unwrap()
                )
            };
            let server = server(StatusCode::OK, &data).await;
            let endpoint = ResolvedEndpoint::new(api, "synthetic", &server.base);
            let model = ResolvedModel::new("synthetic", 64);
            let mut request = RunRequest::new("host", &endpoint, &model);
            request.auth = Auth::Key(key(route));
            let outcome = execute(route, &request).await;
            assert_eq!(failed(&outcome).kind(), expected, "{route:?}");
            assert_eq!(failed(&outcome).status(), None, "{route:?}");
            assert!(
                failed(&outcome)
                    .diagnostics()
                    .unwrap()
                    .contains("synthetic-event-detail"),
                "{route:?}"
            );
            assert!(
                !outcome
                    .message
                    .error_message
                    .as_deref()
                    .unwrap()
                    .contains("synthetic-event-detail")
            );
        }
    }
}

#[cfg(feature = "openai-codex-responses")]
#[tokio::test(flavor = "current_thread")]
async fn codex_retry_failure_does_not_poison_a_later_success() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    async fn respond(State(attempts): State<Arc<AtomicUsize>>) -> axum::response::Response {
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "temporary synthetic retry detail",
            )
                .into_response()
        } else {
            (StatusCode::OK, [("content-type", "text/event-stream")], "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n").into_response()
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let attempts = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .fallback(post(respond))
        .with_state(attempts.clone());
    let server = Server {
        base,
        task: tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    };
    let endpoint = ResolvedEndpoint::new(ModelApi::OpenaiCodexResponses, "synthetic", &server.base);
    let model = ResolvedModel::new("synthetic", 64);
    let mut request = RunRequest::new("host", &endpoint, &model);
    request.auth = Auth::Key(key(Route::Codex));
    let outcome = execute(Route::Codex, &request).await;
    assert!(
        matches!(outcome.termination, Termination::Finished),
        "{outcome:?}"
    );
    assert_eq!(outcome.message.error_message, None);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn stale_runtime_generation_precedes_invalid_input_and_feature_selection() {
    let endpoint = ResolvedEndpoint::new(ModelApi::OpenaiChat, "host", "invalid URL");
    let model = ResolvedModel::new("synthetic", 64);
    let mut request = RunRequest::new("host", &endpoint, &model);
    request.options.resolve_variable = &|_| panic!("cancelled run must not consult host lookup");
    let (cancel, receiver) = watch::channel(0);
    cancel.send_modify(|generation| *generation += 1);
    let outcome = Transport::new(client(), false)
        .run_request(Route::Chat, &request, receiver, &mut |_, _| {
            panic!("delta after cancellation")
        })
        .await;
    assert!(matches!(outcome.termination, Termination::Cancelled));
    assert_eq!(
        outcome.message.error_message.as_deref(),
        Some("Model request cancelled")
    );
}

#[cfg(feature = "openai-codex-responses")]
#[tokio::test(flavor = "current_thread")]
async fn codex_reports_terminal_status_not_an_earlier_retry_status() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    async fn respond(State(attempts): State<Arc<AtomicUsize>>) -> impl IntoResponse {
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            (StatusCode::SERVICE_UNAVAILABLE, "first synthetic status")
        } else {
            (StatusCode::UNAUTHORIZED, "terminal synthetic status")
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let attempts = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .fallback(post(respond))
        .with_state(attempts.clone());
    let server = Server {
        base,
        task: tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    };
    let endpoint = ResolvedEndpoint::new(ModelApi::OpenaiCodexResponses, "synthetic", &server.base);
    let model = ResolvedModel::new("synthetic", 64);
    let mut request = RunRequest::new("host", &endpoint, &model);
    request.auth = Auth::Key(key(Route::Codex));
    let outcome = execute(Route::Codex, &request).await;
    assert_eq!(failed(&outcome).status(), Some(401));
    assert!(
        failed(&outcome)
            .diagnostics()
            .unwrap()
            .contains("terminal synthetic status")
    );
    assert!(attempts.load(Ordering::SeqCst) > 1);
}

#[tokio::test(flavor = "current_thread")]
async fn caller_timeout_is_distinct_from_network_and_http_failures() {
    async fn respond() -> impl IntoResponse {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        (StatusCode::OK, "too late")
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().fallback(post(respond));
    let _server = Server {
        base: base.clone(),
        task: tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    };
    for (route, api) in enabled_routes()
        .into_iter()
        .filter(|(route, _)| *route != Route::Codex)
    {
        let endpoint = ResolvedEndpoint::new(api, "synthetic", &base);
        let model = ResolvedModel::new("synthetic", 64);
        let mut request = RunRequest::new("host", &endpoint, &model);
        request.auth = Auth::Key(key(route));
        let (_cancel, receiver) = watch::channel(0);
        let transport = Transport::new(
            client_with_timeout(Some(std::time::Duration::from_millis(20))),
            false,
        );
        let outcome = transport
            .run_request(route, &request, receiver, &mut |_, _| {})
            .await;
        assert_eq!(failed(&outcome).kind(), ErrorKind::Timeout, "{route:?}");
        assert_eq!(failed(&outcome).status(), None, "{route:?}");
    }
}
