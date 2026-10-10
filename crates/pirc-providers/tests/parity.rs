//! Replays the scenarios recorded from the TS gateway
//! (`tests/parity/record.ts`) against the Rust port: same HTTP requests,
//! same deltas, same final message.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use pirc_protocol::{AssistantDelta, InferenceRequest, Models};
use pirc_providers::Inference;
use serde_json::{Value, json};
use tokio::net::TcpListener;

const FIXTURES: &str = include_str!("parity/fixtures.json");

#[derive(Default)]
struct Server {
    responses: Vec<Value>,
    next: usize,
    requests: Vec<Value>,
}

type Shared = Arc<Mutex<Server>>;

async fn handle(
    State(server): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let response = {
        let mut server = server.lock().unwrap();
        let headers: serde_json::Map<String, Value> = headers
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    json!(value.to_str().unwrap_or("<binary>")),
                )
            })
            .collect();
        server.requests.push(json!({
            "method": method.as_str(),
            "path": uri.path(),
            "headers": headers,
            "body": serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null),
        }));
        let index = server.next;
        server.next += 1;
        server.responses.get(index).cloned()
    };
    let Some(response) = response else {
        return (StatusCode::from_u16(599).unwrap(), "no scripted response").into_response();
    };
    if let Some(status) = response.get("status").and_then(Value::as_u64) {
        let body = response["body"].as_str().unwrap_or_default().to_owned();
        let mut out = (StatusCode::from_u16(status as u16).unwrap(), body).into_response();
        out.headers_mut().remove(header::CONTENT_TYPE);
        if let Some(content_type) = response.get("contentType").and_then(Value::as_str) {
            out.headers_mut()
                .insert(header::CONTENT_TYPE, content_type.parse().unwrap());
        }
        return out;
    }
    let chunks: Vec<String> = response["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|chunk| chunk.as_str().unwrap().to_owned())
        .collect();
    let hang = response.get("hang").and_then(Value::as_bool) == Some(true);
    let stream = futures_util::stream::unfold(
        (chunks.into_iter(), hang),
        |(mut chunks, hang)| async move {
            tokio::time::sleep(Duration::from_millis(2)).await;
            match chunks.next() {
                Some(chunk) => Some((Ok::<_, Infallible>(Bytes::from(chunk)), (chunks, hang))),
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

/// Headers that depend on the HTTP stack, not on the ported code.
fn comparable_headers(headers: &Value) -> serde_json::Map<String, Value> {
    headers
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, value)| {
            !matches!(
                name.as_str(),
                "host" | "content-length" | "connection" | "accept-encoding"
            ) && !name.starts_with("x-stainless-")
                // Bun's fetch default; reqwest sends none.
                && !(name.as_str() == "user-agent"
                    && value.as_str().is_some_and(|ua| ua.starts_with("Bun/")))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

/// `AssistantContent::ToolCall.arguments` is an object on the wire; pi-ai
/// can produce other JSON values, which the Rust port sends as `{}`.
fn object_arguments(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.get("type") == Some(&json!("toolCall"))
                && map.get("arguments").is_some_and(|args| !args.is_object())
            {
                map.insert("arguments".to_owned(), json!({}));
            }
            map.values_mut().for_each(object_arguments);
        }
        Value::Array(items) => items.iter_mut().for_each(object_arguments),
        _ => {}
    }
}

async fn run_scenario(scenario: &Value) -> Result<(), String> {
    let name = scenario["name"].as_str().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server: Shared = Arc::new(Mutex::new(Server {
        responses: scenario["responses"].as_array().unwrap().clone(),
        ..Server::default()
    }));
    let app = Router::new().fallback(handle).with_state(server.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let models_text = scenario["models"].to_string().replace("{BASE}", &base);
    let models: Models = serde_json::from_str(&models_text).map_err(|e| e.to_string())?;
    let request: InferenceRequest =
        serde_json::from_value(scenario["request"].clone()).map_err(|e| e.to_string())?;
    let node_id = scenario
        .get("nodeId")
        .and_then(Value::as_str)
        .unwrap_or("node-1");
    let cancel_after = scenario
        .get("cancelAfterDeltas")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let long = scenario.get("longCacheRetention") == Some(&json!(true));
    let inference = Inference::with_cache_retention(long);
    let mut deltas: Vec<AssistantDelta> = Vec::new();
    let mut on_delta = |delta: &AssistantDelta, _: &pirc_protocol::AssistantMessage| {
        deltas.push(delta.clone());
        if Some(deltas.len()) == cancel_after {
            inference.cancel_all();
        }
    };
    let message = tokio::time::timeout(
        Duration::from_secs(10),
        inference.run(&models, &request, node_id, &mut on_delta),
    )
    .await
    .map_err(|_| format!("{name}: timed out"))?;
    task.abort();

    let expected = &scenario["expected"];
    let mut problems = Vec::new();
    let mut actual_message = serde_json::to_value(&message).unwrap();
    actual_message["timestamp"] = json!(0);
    let mut expected_message = expected["message"].clone();
    // The wire's `role` tag belongs to `Message`, not `AssistantMessage`.
    expected_message.as_object_mut().unwrap().remove("role");
    object_arguments(&mut expected_message);
    if actual_message != expected_message {
        problems.push(format!(
            "message:\n  actual   {actual_message}\n  expected {expected_message}"
        ));
    }
    let actual_deltas = serde_json::to_value(&deltas).unwrap();
    let mut expected_deltas = expected["deltas"].clone();
    object_arguments(&mut expected_deltas);
    if actual_deltas != expected_deltas {
        problems.push(format!(
            "deltas:\n  actual   {actual_deltas}\n  expected {expected_deltas}"
        ));
    }
    let requests = server.lock().unwrap().requests.clone();
    let expected_requests = expected["requests"].as_array().unwrap();
    if requests.len() != expected_requests.len() {
        problems.push(format!(
            "{} requests, expected {}",
            requests.len(),
            expected_requests.len()
        ));
    }
    for (actual, expected) in requests.iter().zip(expected_requests) {
        for key in ["method", "path"] {
            if actual[key] != expected[key] {
                problems.push(format!("{key}: {} != {}", actual[key], expected[key]));
            }
        }
        // String comparison: key order is part of what models see.
        let body = actual["body"].to_string();
        let expected_body = expected["body"].to_string();
        if body != expected_body {
            problems.push(format!(
                "body:\n  actual   {body}\n  expected {expected_body}"
            ));
        }
        let headers = comparable_headers(&actual["headers"]);
        let expected_headers = comparable_headers(&expected["headers"]);
        if headers != expected_headers {
            problems.push(format!(
                "headers:\n  actual   {headers:?}\n  expected {expected_headers:?}"
            ));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!("{name}:\n{}", problems.join("\n")))
    }
}

#[tokio::test]
async fn matches_the_ts_gateway() {
    let scenarios: Vec<Value> = serde_json::from_str(FIXTURES).unwrap();
    assert!(scenarios.len() > 30);
    let mut failures = Vec::new();
    for scenario in &scenarios {
        if let Err(problem) = run_scenario(scenario).await {
            failures.push(problem);
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} scenarios differ:\n\n{}",
        failures.len(),
        scenarios.len(),
        failures.join("\n\n")
    );
}
