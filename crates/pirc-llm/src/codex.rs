//! The `openai-codex-responses` wire API as the TS gateway runs it:
//! pi-adapter's mapping (`transport: 'sse'`, `reasoningEffort: 'none'`, no
//! output cap, Codex `fail()` wording) around pi-ai 0.73.1's
//! `streamOpenAICodexResponses` over SSE (URL, JWT account id, headers,
//! request body, internal retries, error parsing, its SSE parser and event
//! mapping), reusing `openai-responses-shared`. The WebSocket transport is
//! never selected by the adapter and is not ported.

use std::sync::LazyLock;
use std::time::Duration;

use pirc_llm_types::AssistantMessage;
use regex_lite::Regex;
use serde_json::{Map, Value, json};

use crate::http::Headers;
use crate::js::{self, get, truthy};
use crate::pi::{PiModel, reasoning_effort};
use crate::responses_common::{Failure, tool_choice_name};
use crate::responses_shared::{
    Prepared, Processor, Shell, TYPE_ERROR, convert_messages, convert_tools,
};
use crate::stream::{Cancelled, Emitter, StreamRequest, now_ms};

const DEFAULT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";
const MAX_RETRIES: u32 = 3;
const BASE_DELAY_MS: u64 = 1000;
/// Bun's `fetch` text when the server cannot be reached.
const FETCH_FAILED: &str = "Unable to connect. Is the computer able to access the url?";

static RETRYABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused",
    )
    .expect("valid pattern")
});
static USAGE_LIMIT_CODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)usage_limit_reached|usage_not_included|rate_limit_exceeded")
        .expect("valid pattern")
});

/// `isRetryableError`.
fn is_retryable(status: u16, text: &str) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504) || RETRYABLE.is_match(text)
}

/// `resolveCodexUrl`.
fn resolve_url(base_url: &str) -> String {
    let raw = if js::trim(base_url).is_empty() {
        DEFAULT_CODEX_BASE_URL
    } else {
        base_url
    };
    let normalized = raw.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") {
        normalized.to_owned()
    } else if normalized.ends_with("/codex") {
        format!("{normalized}/responses")
    } else {
        format!("{normalized}/codex/responses")
    }
}

/// `atob` (WHATWG forgiving-base64 decode), as a binary string's bytes.
fn atob(text: &str) -> Option<Vec<u8>> {
    let mut input: Vec<u8> = text
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    if input.len().is_multiple_of(4) {
        for _ in 0..2 {
            if input.last() == Some(&b'=') {
                input.pop();
            }
        }
    }
    if input.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in input {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// `extractAccountId`: the ChatGPT account id claim of the access token.
fn extract_account_id(token: &str) -> Result<String, String> {
    let failed = || "Failed to extract accountId from token".to_owned();
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(failed());
    }
    let bytes = atob(parts[1]).ok_or_else(failed)?;
    // `atob` yields one character per byte.
    let text: String = bytes.into_iter().map(char::from).collect();
    let payload: Value = serde_json::from_str(&text).map_err(|_| failed())?;
    let account = get(get(Some(&payload), JWT_CLAIM_PATH), "chatgpt_account_id");
    match account {
        Some(account) if truthy(Some(account)) => Ok(js::to_js_string(account)),
        _ => Err(failed()),
    }
}

/// `buildSSEHeaders` (through `buildBaseCodexHeaders`).
fn sse_headers(
    model: &PiModel,
    prepared: &Prepared,
    account_id: &str,
    session_id: &str,
    user_agent: &str,
) -> Headers {
    let mut headers = Headers::default();
    for (name, value) in &model.headers {
        headers.set(name, value);
    }
    for (name, value) in &prepared.headers {
        headers.set(name, value);
    }
    headers.set("Authorization", &format!("Bearer {}", prepared.api_key));
    headers.set("chatgpt-account-id", account_id);
    headers.set("originator", "pi");
    headers.set("User-Agent", user_agent);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
    if !session_id.is_empty() {
        headers.set("session_id", session_id);
        headers.set("x-client-request-id", session_id);
    }
    headers
}

/// `buildRequestBody` with the adapter's options, then its `onPayload`.
fn build_body(
    model: &PiModel,
    request: &StreamRequest<'_>,
    prepared: &Prepared,
) -> Result<Map<String, Value>, String> {
    let input = convert_messages(model, None, &prepared.context)?;
    let instructions = if request.system_prompt.is_empty() {
        "You are a helpful assistant."
    } else {
        request.system_prompt
    };
    let mut body = Map::new();
    body.insert("model".to_owned(), json!(model.id));
    body.insert("store".to_owned(), json!(false));
    body.insert("stream".to_owned(), json!(true));
    body.insert("instructions".to_owned(), json!(instructions));
    body.insert("input".to_owned(), Value::Array(input));
    body.insert("text".to_owned(), json!({ "verbosity": "low" }));
    body.insert("include".to_owned(), json!(["reasoning.encrypted_content"]));
    body.insert("prompt_cache_key".to_owned(), json!(request.session_id));
    let choice = request.tool_choice.map_or("auto", tool_choice_name);
    body.insert("tool_choice".to_owned(), json!(choice));
    body.insert("parallel_tool_calls".to_owned(), json!(true));
    if !request.tools.is_empty() {
        body.insert(
            "tools".to_owned(),
            Value::Array(convert_tools(request.tools, &Value::Null)),
        );
    }
    // The adapter asks for 'none' when thinking is off but the model can
    // turn reasoning off.
    let effort = reasoning_effort(request, model).or_else(|| {
        (model.reasoning && model.level_map("off") != Some(None)).then(|| "none".to_owned())
    });
    if let Some(effort) = effort {
        let effort = if effort == "none" {
            model
                .level_map("off")
                .flatten()
                .unwrap_or("none")
                .to_owned()
        } else {
            model.mapped_effort(&effort)
        };
        body.insert(
            "reasoning".to_owned(),
            json!({ "effort": effort, "summary": "auto" }),
        );
    }
    Ok(body)
}

/// A number as `String(n)` shows it (`Math.round` results).
fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else if value == 0.0 {
        "0".to_owned()
    } else {
        js::to_js_string(&json!(value))
    }
}

/// `parseErrorResponse`: `friendlyMessage || message`.
fn parse_error_response(status: u16, status_text: &str, raw: &str) -> String {
    let mut message = if !raw.is_empty() {
        raw.to_owned()
    } else if !status_text.is_empty() {
        status_text.to_owned()
    } else {
        "Request failed".to_owned()
    };
    let mut friendly = None;
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return message;
    };
    let error = get(Some(&parsed), "error");
    if !truthy(error) {
        return message;
    }
    let code = [get(error, "code"), get(error, "type")]
        .into_iter()
        .find(|value| truthy(*value))
        .flatten()
        .map(js::to_js_string)
        .unwrap_or_default();
    if USAGE_LIMIT_CODE.is_match(&code) || status == 429 {
        let plan = match get(error, "plan_type") {
            Some(Value::String(plan)) if !plan.is_empty() => {
                format!(" ({} plan)", plan.to_lowercase())
            }
            // `.toLowerCase()` of a non-string throws; the catch keeps `message`.
            Some(plan) if truthy(Some(plan)) => return message,
            _ => String::new(),
        };
        let resets_at = get(error, "resets_at").filter(|value| truthy(Some(value)));
        let when = resets_at.map(|resets_at| {
            let at = js::number(Some(resets_at)).unwrap_or(f64::NAN);
            let mins = ((at * 1000.0 - now_ms() as f64) / 60000.0 + 0.5).floor();
            let mins = if mins.is_nan() { mins } else { mins.max(0.0) };
            format!(" Try again in ~{} min.", js_number_text(mins))
        });
        friendly = Some(
            js::trim(&format!(
                "You have hit your ChatGPT usage limit{plan}.{}",
                when.unwrap_or_default()
            ))
            .to_owned(),
        );
    }
    if let Some(text) = get(error, "message").filter(|value| truthy(Some(value))) {
        message = js::to_js_string(text);
    } else if let Some(friendly) = &friendly {
        message = friendly.clone();
    }
    friendly.unwrap_or(message)
}

/// `parseSSE`: events split on a blank `\n\n` only, `data:` lines joined.
#[derive(Default)]
struct CodexSse {
    /// Bytes of an incomplete UTF-8 sequence (`TextDecoder` streaming).
    pending: Vec<u8>,
    buffer: String,
}

impl CodexSse {
    fn decode(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        let mut rest: &[u8] = &std::mem::take(&mut self.pending);
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    self.buffer.push_str(text);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    self.buffer
                        .push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                    match error.error_len() {
                        Some(len) => {
                            self.buffer.push('\u{fffd}');
                            rest = &rest[valid + len..];
                        }
                        None => {
                            self.pending = rest[valid..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
    }

    /// The parsed events completed by `bytes`, in order; parsing stops at
    /// the first invalid one.
    fn push(&mut self, bytes: &[u8]) -> Vec<Result<Value, String>> {
        self.decode(bytes);
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let chunk: String = self.buffer[..index].to_owned();
            self.buffer.drain(..index + 2);
            let lines: Vec<&str> = chunk
                .split('\n')
                .filter(|line| line.starts_with("data:"))
                .map(|line| js::trim(&line[5..]))
                .collect();
            if lines.is_empty() {
                continue;
            }
            let data = lines.join("\n");
            let data = js::trim(&data);
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            match crate::json_parse::parse_event(data) {
                Ok(value) => events.push(Ok(value)),
                Err(error) => {
                    events.push(Err(format!("Invalid Codex SSE JSON: SyntaxError: {error}")));
                    break;
                }
            }
        }
        events
    }
}

/// What `mapCodexEvents` makes of an event.
enum Mapped {
    Skip,
    Event(Value),
    /// The terminal `response.completed`; nothing after it is read.
    Last(Value),
}

/// `normalizeCodexStatus`.
fn normalize_status(status: Option<&Value>) -> Option<Value> {
    let status = status?.as_str()?;
    matches!(
        status,
        "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress"
    )
    .then(|| json!(status))
}

/// `mapCodexEvents`.
fn map_event(event: Value) -> Result<Mapped, String> {
    if event.is_null() {
        return Err(TYPE_ERROR.to_owned());
    }
    let Some(kind) = get(Some(&event), "type").and_then(Value::as_str) else {
        return Ok(Mapped::Skip);
    };
    match kind {
        "error" => {
            let first = [get(Some(&event), "message"), get(Some(&event), "code")]
                .into_iter()
                .flatten()
                .find(|value| truthy(Some(value)));
            let text = first.map_or_else(|| event.to_string(), js::to_js_string);
            Err(format!("Codex error: {text}"))
        }
        "response.failed" => {
            let message = get(get(get(Some(&event), "response"), "error"), "message");
            Err(match message {
                Some(message) if truthy(Some(message)) => js::to_js_string(message),
                _ => "Codex response failed".to_owned(),
            })
        }
        "response.done" | "response.completed" | "response.incomplete" => {
            let mut event = event;
            let response = get(Some(&event), "response");
            let normalized = match response {
                Some(Value::Object(response)) => {
                    let mut response = response.clone();
                    match normalize_status(response.get("status")) {
                        Some(status) => response.insert("status".to_owned(), status),
                        None => response.insert("status".to_owned(), Value::Null),
                    };
                    Some(Value::Object(response))
                }
                // Spreading another truthy value gives no `status`.
                Some(other) if truthy(Some(other)) => Some(json!({})),
                other => other.cloned(),
            };
            if let Some(object) = event.as_object_mut() {
                object.insert("type".to_owned(), json!("response.completed"));
                if let Some(normalized) = normalized {
                    object.insert("response".to_owned(), normalized);
                }
            }
            Ok(Mapped::Last(event))
        }
        _ => Ok(Mapped::Event(event)),
    }
}

pub struct CodexRun {
    shell: Shell,
    processor: Processor,
}

impl CodexRun {
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
        _long_cache_retention: bool,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Cancelled> {
        let prepared = match self.shell.prepare(request) {
            Ok(prepared) => prepared,
            Err(result) => return Ok(*result),
        };
        match self.stream(client, request, &prepared, emit).await {
            Ok(result) => Ok(result),
            Err(Failure::Cancelled) => Err(Cancelled),
            Err(Failure::Upstream(upstream)) => Ok(self.shell.failed(&upstream)),
        }
    }

    async fn stream(
        &mut self,
        client: &reqwest::Client,
        request: &StreamRequest<'_>,
        prepared: &Prepared,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Failure> {
        let model = &self.shell.model;
        let account_id = extract_account_id(&prepared.api_key).map_err(Failure::Upstream)?;
        let body = build_body(model, request, prepared).map_err(Failure::Upstream)?;
        let headers = sse_headers(
            model,
            prepared,
            &account_id,
            &request.session_id,
            request.codex_user_agent,
        )
        .to_map()
        .ok_or_else(|| Failure::upstream(TYPE_ERROR))?;
        let body = serde_json::to_vec(&body).unwrap_or_default();
        let url = resolve_url(&model.base_url);

        let mut attempt = 0;
        let mut response = loop {
            let sent = client
                .post(&url)
                .headers(headers.clone())
                .body(body.clone())
                .send()
                .await;
            let error = match sent {
                Err(_) => FETCH_FAILED.to_owned(),
                Ok(response) => {
                    let status = response.status();
                    self.shell.saw_status(status.as_u16());
                    if status.is_success() {
                        break response;
                    }
                    match response.bytes().await {
                        Err(_) => "terminated".to_owned(),
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            if attempt < MAX_RETRIES && is_retryable(status.as_u16(), &text) {
                                tokio::time::sleep(delay(attempt)).await;
                                attempt += 1;
                                continue;
                            }
                            parse_error_response(
                                status.as_u16(),
                                status.canonical_reason().unwrap_or_default(),
                                &text,
                            )
                        }
                    }
                }
            };
            // Every other failure, network errors included, is retried
            // unless it is a usage limit.
            if attempt < MAX_RETRIES && !error.contains("usage limit") {
                tokio::time::sleep(delay(attempt)).await;
                attempt += 1;
                continue;
            }
            return Err(Failure::Upstream(error));
        };
        if emit.cancelled() {
            return Err(Failure::Cancelled);
        }
        self.shell.started = true;

        let mut parser = CodexSse::default();
        loop {
            let bytes = match response.chunk().await {
                Ok(Some(bytes)) => bytes,
                Ok(None) => break,
                Err(_) => return Err(Failure::upstream("terminated")),
            };
            for event in parser.push(&bytes) {
                let event = event.map_err(Failure::Upstream)?;
                let (event, last) = match map_event(event).map_err(Failure::Upstream)? {
                    Mapped::Skip => continue,
                    Mapped::Event(event) => (event, false),
                    Mapped::Last(event) => (event, true),
                };
                let delta = self
                    .processor
                    .event(&mut self.shell.out, &event)
                    .map_err(Failure::Upstream)?;
                if let Some(delta) = delta {
                    emit.emit(delta, &self.shell.out)
                        .map_err(|Cancelled| Failure::Cancelled)?;
                }
                if last {
                    return Ok(self.shell.out.clone());
                }
            }
        }
        Ok(self.shell.out.clone())
    }
}

fn delay(attempt: u32) -> Duration {
    Duration::from_millis(BASE_DELAY_MS << attempt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_codex_urls() {
        assert_eq!(
            resolve_url(""),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_url("https://x/v1//"),
            "https://x/v1/codex/responses"
        );
        assert_eq!(resolve_url("https://x/codex/"), "https://x/codex/responses");
        assert_eq!(
            resolve_url("https://x/codex/responses"),
            "https://x/codex/responses"
        );
    }

    #[test]
    fn extracts_the_account_id() {
        // {"https://api.openai.com/auth":{"chatgpt_account_id":"acct_1"}}, unpadded.
        let payload =
            "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xIn19";
        assert_eq!(
            extract_account_id(&format!("h.{payload}.s")),
            Ok("acct_1".to_owned())
        );
        assert!(extract_account_id("a.b").is_err());
        assert!(extract_account_id("a.-_.c").is_err());
        assert!(extract_account_id("a.e30.c").is_err());
        assert_eq!(atob("YQ=="), Some(b"a".to_vec()));
        assert_eq!(atob("Y"), None);
    }

    #[test]
    fn parses_error_responses() {
        assert_eq!(
            parse_error_response(500, "Internal Server Error", ""),
            "Internal Server Error"
        );
        assert_eq!(parse_error_response(400, "", "boom"), "boom");
        assert_eq!(
            parse_error_response(
                400,
                "",
                r#"{"error":{"code":"usage_limit_reached","plan_type":"PLUS","resets_at":1}}"#
            ),
            "You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min."
        );
        assert_eq!(
            parse_error_response(400, "", r#"{"error":{"message":"bad"}}"#),
            "bad"
        );
        assert_eq!(
            parse_error_response(429, "", r#"{"error":{"plan_type":5,"message":"m"}}"#),
            r#"{"error":{"plan_type":5,"message":"m"}}"#
        );
    }

    #[test]
    fn codex_sse_needs_lf_blank_lines() {
        let mut parser = CodexSse::default();
        let mut events = parser.push(b"event: x\ndata: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\"");
        events.extend(parser.push(b":2}\r\n\r\ndata: 3\n\n"));
        // CRLF blank lines do not end an event: two data lines, joined.
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], Ok(json!({ "a": 1 })));
        assert!(events[1].is_err());
        let mut parser = CodexSse::default();
        let events = parser.push("data: \"\u{e9}\"\n\n".as_bytes().split_at(8).0);
        assert!(events.is_empty());
    }
}
