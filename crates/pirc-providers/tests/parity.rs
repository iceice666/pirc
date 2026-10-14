//! Replays the scenarios recorded from the TS gateway
//! (`tests/parity/record.ts`, one `fixtures/<group>.json` per group) against
//! the Rust port: same HTTP requests, same deltas, same final message.
//!
//! `PARITY_GROUP=<group>` and `PARITY_SCENARIO=<name>` narrow a run.

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
        let text = String::from_utf8_lossy(&body).into_owned();
        server.requests.push(json!({
            "method": method.as_str(),
            "path": uri.path_and_query().map_or(uri.path(), |p| p.as_str()),
            "headers": headers,
            "body": serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)),
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
        if let Some(headers) = response.get("headers").and_then(Value::as_object) {
            for (name, value) in headers {
                out.headers_mut().insert(
                    axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    value.as_str().unwrap().parse().unwrap(),
                );
            }
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
        .map(|(name, value)| {
            // pi-ai's Codex agent names the host: `pi (linux 6.1.0; x64)`.
            let value = match value.as_str() {
                Some(ua) if name == "user-agent" && ua.starts_with("pi (") => json!("pi (<host>)"),
                _ => value.clone(),
            };
            (name.clone(), value)
        })
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
    let root = format!("http://{}", listener.local_addr().unwrap());
    let base = format!("{root}/v1");
    let substitute = |value: &Value| {
        let text = value
            .to_string()
            .replace("{BASE}", &base)
            .replace("{ROOT}", &root);
        serde_json::from_str::<Value>(&text).unwrap()
    };
    let unsubstitute = |value: &Value| {
        let text = value
            .to_string()
            .replace(&base, "{BASE}")
            .replace(&root, "{ROOT}");
        serde_json::from_str::<Value>(&text).unwrap()
    };
    let server: Shared = Arc::new(Mutex::new(Server {
        responses: scenario["responses"].as_array().unwrap().clone(),
        ..Server::default()
    }));
    let app = Router::new().fallback(handle).with_state(server.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let models: Models =
        serde_json::from_value(substitute(&scenario["models"])).map_err(|e| e.to_string())?;
    let request: InferenceRequest =
        serde_json::from_value(substitute(&scenario["request"])).map_err(|e| e.to_string())?;
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
    let mut actual_message = unsubstitute(&serde_json::to_value(&message).unwrap());
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
    let actual_deltas = unsubstitute(&serde_json::to_value(&deltas).unwrap());
    let mut expected_deltas = expected["deltas"].clone();
    object_arguments(&mut expected_deltas);
    if actual_deltas != expected_deltas {
        problems.push(format!(
            "deltas:\n  actual   {actual_deltas}\n  expected {expected_deltas}"
        ));
    }
    let requests = unsubstitute(&json!(server.lock().unwrap().requests))
        .as_array()
        .unwrap()
        .clone();
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
        let mut expected_headers = comparable_headers(&expected["headers"]);
        // Recordings pin TS 0.3.0. The product version intentionally changes
        // at release; still require the actual header to name this build.
        if expected_headers.get("user-agent") == Some(&json!("pirc/0.3.0")) {
            expected_headers.insert(
                "user-agent".into(),
                json!(format!("pirc/{}", env!("CARGO_PKG_VERSION"))),
            );
        }
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

/// Every recorded group, by name, narrowed by `PARITY_GROUP`.
fn groups() -> Vec<(String, Vec<Value>)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/fixtures");
    let wanted = std::env::var("PARITY_GROUP").ok();
    let mut groups: Vec<(String, Vec<Value>)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).unwrap();
            (name, serde_json::from_str(&text).unwrap())
        })
        .filter(|(name, _)| wanted.as_ref().is_none_or(|wanted| wanted == name))
        .collect();
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    groups
}

#[tokio::test]
async fn matches_the_ts_gateway() {
    let groups = groups();
    assert!(!groups.is_empty(), "no parity fixtures");
    let only = std::env::var("PARITY_SCENARIO").ok();
    let mut failures = Vec::new();
    let mut count = 0;
    for (group, scenarios) in &groups {
        assert!(!scenarios.is_empty(), "{group}: no scenarios");
        for scenario in scenarios {
            if only.as_deref().is_some_and(|only| scenario["name"] != only) {
                continue;
            }
            count += 1;
            if let Err(problem) = run_scenario(scenario).await {
                failures.push(format!("[{group}] {problem}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {count} scenarios differ:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
