//! The `openai-responses` wire API as the TS gateway runs it: pi-adapter's
//! mapping around pi-ai 0.73.1's `streamOpenAIResponses` (client headers,
//! request body, `openai-responses-shared`) and the `openai` 6.26.0 SDK's
//! `responses.create` (headers, URL, error texts, SSE decoding).
use crate::outcome::{ErrorKind, LlmError};
use crate::runtime::RunRequest as StreamRequest;

use crate::responses_common::{Failure, tool_choice_name};
use crate::responses_shared as shared;

use indexmap::IndexMap;
use pirc_llm_types::{AssistantMessage, StopReason};
use serde_json::{Map, Value, json};

use crate::http::Headers;
use crate::js::{get, present, truthy};
use crate::pi::{PiModel, reasoning_effort};
use crate::sdk::{SDK_TIMEOUT, SDK_USER_AGENT, api_error_message, cloudflare_base_url};
use crate::sse::SdkDecoder;
use crate::stream::{Cancelled, Emitter};

use shared::{Prepared, Processor, Shell, convert_messages, convert_tools, copilot_headers};

/// Known flags resolve once, preserving nullish defaults and JS truthiness.
struct Compat {
    send_session_id_header: bool,
    long_cache_retention: bool,
}

impl Compat {
    fn new(values: &Map<String, Value>) -> Self {
        let default_true =
            |key: &str| present(values.get(key)).is_none_or(|value| truthy(Some(value)));
        Self {
            send_session_id_header: default_true("sendSessionIdHeader"),
            long_cache_retention: default_true("supportsLongCacheRetention"),
        }
    }
}

struct HttpRequest {
    url: String,
    headers: Headers,
    body: Map<String, Value>,
}

/// `createClient` (headers and base URL) with the SDK's own headers.
fn client_headers(
    model: &PiModel,
    prepared: &Prepared,
    compat: &Compat,
    session_id: &str,
    resolve_variable: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<(Headers, String), String> {
    let mut headers = Headers::default();
    headers.set("Accept", "application/json");
    headers.set("User-Agent", SDK_USER_AGENT);
    headers.set("Authorization", &format!("Bearer {}", prepared.api_key));
    // A plain object: later keys of the same spelling replace earlier ones.
    let mut defaults: IndexMap<String, Option<String>> = model
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), Some(v.clone())))
        .collect();
    if model.provider == "github-copilot" {
        for (name, value) in copilot_headers(&prepared.context) {
            defaults.insert(name.to_owned(), Some(value));
        }
    }
    if compat.send_session_id_header {
        defaults.insert("session_id".to_owned(), Some(session_id.to_owned()));
    }
    defaults.insert(
        "x-client-request-id".to_owned(),
        Some(session_id.to_owned()),
    );
    for (name, value) in &prepared.headers {
        defaults.insert((*name).to_owned(), Some(value.clone()));
    }
    if model.provider == "cloudflare-ai-gateway" {
        let authorization = defaults.get("Authorization").cloned().flatten();
        defaults.insert("Authorization".to_owned(), authorization);
        defaults.insert(
            "cf-aig-authorization".to_owned(),
            Some(format!("Bearer {}", prepared.api_key)),
        );
    }
    for (name, value) in &defaults {
        match value {
            Some(value) => headers.set(name, value),
            None => headers.remove(name),
        }
    }
    headers.set("Content-Type", "application/json");
    let base = if matches!(
        model.provider.as_str(),
        "cloudflare-workers-ai" | "cloudflare-ai-gateway"
    ) {
        cloudflare_base_url(model, resolve_variable)?
    } else {
        model.base_url.clone()
    };
    Ok((headers, base))
}

/// `buildParams`, then the adapter's `onPayload` (`tool_choice`).
fn build_params(
    model: &PiModel,
    request: &StreamRequest<'_>,
    prepared: &Prepared,
    compat: &Compat,
    long_cache_retention: bool,
) -> Result<Map<String, Value>, String> {
    let input = convert_messages(
        model,
        Some(request.context.system_prompt),
        &prepared.context,
    )?;
    let mut params = Map::new();
    params.insert("model".to_owned(), json!(model.id));
    params.insert("input".to_owned(), Value::Array(input));
    params.insert("stream".to_owned(), json!(true));
    params.insert(
        "prompt_cache_key".to_owned(),
        json!(request.options.session_id),
    );
    if long_cache_retention && compat.long_cache_retention {
        params.insert("prompt_cache_retention".to_owned(), json!("24h"));
    }
    params.insert("store".to_owned(), json!(false));
    let max_tokens = request
        .options
        .max_tokens
        .unwrap_or(request.model.max_tokens);
    if max_tokens > 0 {
        params.insert("max_output_tokens".to_owned(), json!(max_tokens));
    }
    if !request.context.tools.is_empty() {
        params.insert(
            "tools".to_owned(),
            Value::Array(convert_tools(request.context.tools, &json!(false))),
        );
    }
    if model.reasoning {
        if let Some(effort) = reasoning_effort(request, model) {
            params.insert(
                "reasoning".to_owned(),
                json!({ "effort": model.mapped_effort(&effort), "summary": "auto" }),
            );
            params.insert("include".to_owned(), json!(["reasoning.encrypted_content"]));
        } else if model.provider != "github-copilot" && model.level_map("off") != Some(None) {
            let off = model.level_map("off").flatten().unwrap_or("none");
            params.insert("reasoning".to_owned(), json!({ "effort": off }));
        }
    }
    if let Some(choice) = request.options.tool_choice {
        params.insert("tool_choice".to_owned(), json!(tool_choice_name(choice)));
    }
    Ok(params)
}

fn prepare(
    model: &PiModel,
    request: &StreamRequest<'_>,
    prepared: &Prepared,
    long_cache_retention: bool,
) -> Result<HttpRequest, String> {
    let compat = Compat::new(&model.compat);
    let (headers, base) = client_headers(
        model,
        prepared,
        &compat,
        request.options.session_id,
        request.options.resolve_variable,
    )?;
    let body = build_params(model, request, prepared, &compat, long_cache_retention)?;
    let path = if base.ends_with('/') {
        "responses"
    } else {
        "/responses"
    };
    Ok(HttpRequest {
        url: format!("{base}{path}"),
        headers,
        body,
    })
}

/// The SDK's error text of a non-2xx response (`APIError.generate`).
fn http_error(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let parsed = parsed.filter(|value| truthy(Some(value)));
    let error = get(parsed.as_ref(), "error");
    let message = if parsed.is_some() { None } else { Some(body) };
    api_error_message(Some(status), error, message)
}

pub struct ResponsesRun {
    shell: Shell,
    processor: Processor,
}

impl ResponsesRun {
    pub fn new(request: &StreamRequest<'_>) -> Self {
        Self {
            shell: Shell::new(request),
            processor: Processor::default(),
        }
    }

    /// The result when the run is cancelled.
    pub fn aborted(&self) -> AssistantMessage {
        self.shell.aborted()
    }

    pub async fn run(
        &mut self,
        client: &reqwest::Client,
        request: &StreamRequest<'_>,
        long_cache_retention: bool,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Cancelled> {
        let prepared = match self.shell.prepare(request, emit) {
            Ok(prepared) => prepared,
            Err(result) => return Ok(*result),
        };
        let http = match prepare(&self.shell.model, request, &prepared, long_cache_retention) {
            Ok(http) => http,
            Err(upstream) => {
                emit.record_error(LlmError::diagnostic(ErrorKind::InvalidRequest, &upstream));
                return Ok(self.shell.failed(&upstream));
            }
        };
        match self.stream(client, http, emit).await {
            Ok(result) => Ok(result),
            Err(Failure::Cancelled) => Err(Cancelled),
            Err(Failure::Upstream(upstream)) => Ok(self.shell.failed(&upstream)),
        }
    }

    async fn stream(
        &mut self,
        client: &reqwest::Client,
        http: HttpRequest,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Failure> {
        let headers = http.headers.to_map().ok_or_else(|| {
            emit.record_error(LlmError::new(ErrorKind::InvalidRequest));
            Failure::upstream("Connection error.")
        })?;
        let body = serde_json::to_vec(&http.body).unwrap_or_default();
        let send = client.post(&http.url).headers(headers).body(body).send();
        let mut response = match tokio::time::timeout(SDK_TIMEOUT, send).await {
            Err(_) => {
                emit.record_error(LlmError::new(ErrorKind::Timeout));
                return Err(Failure::upstream("Request timed out."));
            }
            Ok(Err(error)) if error.is_timeout() => {
                emit.record_error(LlmError::from_reqwest(&error));
                return Err(Failure::upstream("Request timed out."));
            }
            Ok(Err(error)) => {
                emit.record_error(LlmError::from_reqwest(&error));
                return Err(Failure::upstream("Connection error."));
            }
            Ok(Ok(response)) => response,
        };
        let status = response.status().as_u16();
        if !response.status().is_success() {
            let body = response.bytes().await.unwrap_or_default();
            emit.record_error(LlmError::http(
                status,
                String::from_utf8_lossy(&body).into_owned(),
            ));
            return Err(Failure::Upstream(http_error(
                status,
                &String::from_utf8_lossy(&body),
            )));
        }
        self.shell.saw_status(status);
        if emit.cancelled() {
            return Err(Failure::Cancelled);
        }
        self.shell.started = true;

        let mut decoder = SdkDecoder::default();
        let mut done = false;
        loop {
            let (events, ended) = match response.chunk().await {
                Ok(Some(bytes)) => (decoder.push(&bytes), false),
                Ok(None) => (decoder.finish(), true),
                Err(error) => {
                    emit.record_error(LlmError::from_reqwest(&error));
                    return Err(Failure::upstream("terminated"));
                }
            };
            for event in events {
                if done {
                    continue;
                }
                if event.data.starts_with("[DONE]") {
                    done = true;
                    continue;
                }
                let parsed: Value = crate::json_parse::parse_event(&event.data).map_err(|_| {
                    emit.record_error(LlmError::diagnostic(ErrorKind::Protocol, &event.data));
                    Failure::upstream("JSON Parse error: Unable to parse JSON string")
                })?;
                let thread = event
                    .event
                    .as_deref()
                    .is_some_and(|name| name.starts_with("thread."));
                if thread {
                    // Yielded as `{ event, data }`, which has no `type`.
                    continue;
                }
                let error = get(Some(&parsed), "error");
                if truthy(error) {
                    emit.record_error(LlmError::upstream(parsed.to_string()));
                    return Err(Failure::Upstream(api_error_message(None, error, None)));
                }
                let delta =
                    self.processor
                        .event(&mut self.shell.out, &parsed)
                        .map_err(|error| {
                            emit.record_error(
                                if matches!(
                                    get(Some(&parsed), "type").and_then(Value::as_str),
                                    Some("error" | "response.failed")
                                ) {
                                    LlmError::upstream(parsed.to_string())
                                } else {
                                    LlmError::diagnostic(ErrorKind::Protocol, &error)
                                },
                            );
                            Failure::Upstream(error)
                        })?;
                if get(Some(&parsed), "type").and_then(Value::as_str) == Some("response.completed")
                    && self.shell.out.stop_reason == StopReason::Error
                {
                    emit.record_error(LlmError::upstream(parsed.to_string()));
                }
                if let Some(delta) = delta {
                    emit.emit(delta, &self.shell.out)
                        .map_err(|Cancelled| Failure::Cancelled)?;
                }
            }
            if ended {
                break;
            }
        }
        if matches!(
            self.shell.out.stop_reason,
            StopReason::Error | StopReason::Aborted
        ) {
            emit.record_error(LlmError::upstream("An unknown error occurred"));
            return Err(Failure::upstream("An unknown error occurred"));
        }
        Ok(self.shell.out.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_compat_defaults_are_nullish_not_boolean_only() {
        for value in [Value::Null, json!([]), json!({}), json!("yes"), json!(1)] {
            let values = json!({"sendSessionIdHeader":value,"supportsLongCacheRetention":value})
                .as_object()
                .unwrap()
                .clone();
            let compat = Compat::new(&values);
            assert!(compat.send_session_id_header);
            assert!(compat.long_cache_retention);
        }
        for value in [json!(false), json!(0), json!("")] {
            let values = json!({"sendSessionIdHeader":value,"supportsLongCacheRetention":value})
                .as_object()
                .unwrap()
                .clone();
            let compat = Compat::new(&values);
            assert!(!compat.send_session_id_header);
            assert!(!compat.long_cache_retention);
        }
        let compat = Compat::new(&Map::new());
        assert!(compat.send_session_id_header && compat.long_cache_retention);
    }
}
