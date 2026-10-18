//! The gateway's native Anthropic Messages transport for plain
//! `anthropic-messages` providers (`agent/providers/anthropic.ts`): no
//! `piProvider` and no model-level `api`.

use pirc_protocol::{
    AssistantContent, AssistantDelta, AssistantMessage, Message, StopReason, ThinkingLevel,
    ToolChoice, UserBlock, UserContent,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value, json};

use crate::chat::parse_tool_arguments;
use crate::http::opencode_headers;
use crate::js::{self, get, present, truthy};
use crate::sse::NativeDecoder;
use crate::stream::{Cancelled, Emitter, StreamRequest, assistant, content_index};

/// `{ ...provider.compat, ...model.compat }`.
fn flags(request: &StreamRequest<'_>) -> Map<String, Value> {
    let mut flags = request.provider.compat.clone();
    flags.extend(
        request
            .model
            .compat
            .iter()
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    flags
}

fn ephemeral() -> Value {
    json!({ "type": "ephemeral" })
}

/// `image()`.
fn image(mime_type: &str, data: &str) -> Value {
    json!({ "type": "image", "source": { "type": "base64", "media_type": mime_type, "data": data } })
}

fn user_blocks(blocks: &[UserBlock]) -> Vec<Value> {
    blocks
        .iter()
        .map(|block| match block {
            UserBlock::Text { text, .. } => json!({ "type": "text", "text": text }),
            UserBlock::Image { data, mime_type } => image(mime_type, data),
        })
        .collect()
}

/// `toAnthropicMessages`: roles must alternate, so consecutive same-role
/// messages are merged; the last user turn gets a cache breakpoint.
fn to_anthropic_messages(messages: &[Message]) -> Vec<Value> {
    let mut out: Vec<(&'static str, Vec<Value>)> = Vec::new();
    let mut push = |role: &'static str, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        match out.last_mut() {
            Some((last, content)) if *last == role => content.extend(blocks),
            _ => out.push((role, blocks)),
        }
    };
    for message in messages {
        match message {
            Message::User { content, .. } => push(
                "user",
                match content {
                    UserContent::Text(text) => vec![json!({ "type": "text", "text": text })],
                    UserContent::Blocks(blocks) => user_blocks(blocks),
                },
            ),
            Message::Custom { content, .. } => {
                push("user", vec![json!({ "type": "text", "text": content })]);
            }
            Message::CompactionSummary { summary, .. } => push(
                "user",
                vec![json!({ "type": "text", "text": format!(
                    "<summary>\nThe conversation so far was compacted into this summary:\n\n{summary}\n</summary>"
                ) })],
            ),
            Message::Assistant(message) => {
                let failed = matches!(message.stop_reason, StopReason::Error | StopReason::Aborted);
                let mut blocks = Vec::new();
                for part in &message.content {
                    match part {
                        AssistantContent::Text { text, .. } if !text.is_empty() => {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        AssistantContent::Thinking {
                            thinking,
                            signature: Some(signature),
                            redacted,
                        } if !failed && !signature.is_empty() => {
                            blocks.push(if *redacted == Some(true) {
                                json!({ "type": "redacted_thinking", "data": signature })
                            } else {
                                json!({ "type": "thinking", "thinking": thinking, "signature": signature })
                            });
                        }
                        AssistantContent::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } if !failed => blocks.push(
                            json!({ "type": "tool_use", "id": id, "name": name, "input": arguments }),
                        ),
                        _ => {}
                    }
                }
                push("assistant", blocks);
            }
            Message::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
                let content = if content.is_empty() {
                    vec![json!({ "type": "text", "text": "(no output)" })]
                } else {
                    user_blocks(content)
                };
                push(
                    "user",
                    vec![json!({ "type": "tool_result", "tool_use_id": tool_call_id,
                        "is_error": is_error, "content": content })],
                );
            }
        }
    }
    // Cache breakpoint on the last user turn so the growing prefix is reused.
    if let Some((_, content)) = out.iter_mut().rev().find(|(role, _)| *role == "user")
        && let Some(Value::Object(block)) = content.last_mut()
    {
        block.insert("cache_control".to_owned(), ephemeral());
    }
    out.into_iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect()
}

/// `budgets` (`?? 10_000` never applies: every level is listed).
fn budget(level: ThinkingLevel) -> i128 {
    match level {
        ThinkingLevel::Minimal => 1024,
        ThinkingLevel::Low => 4096,
        ThinkingLevel::Off | ThinkingLevel::Medium => 10_000,
        ThinkingLevel::High => 24_000,
        ThinkingLevel::Xhigh => 48_000,
    }
}

/// `efforts`.
fn effort(level: ThinkingLevel) -> Value {
    match level {
        ThinkingLevel::Minimal | ThinkingLevel::Low => json!("low"),
        ThinkingLevel::Medium => json!("medium"),
        ThinkingLevel::High => json!("high"),
        ThinkingLevel::Xhigh => json!("max"),
        // `efforts.off` is undefined, and `thinking: off` never gets here.
        ThinkingLevel::Off => Value::Null,
    }
}

/// `anthropicBody`.
fn anthropic_body(request: &StreamRequest<'_>) -> Map<String, Value> {
    let flags = flags(request);
    let max_tokens = request.max_tokens.unwrap_or(request.model.max_tokens);
    let mut body = Map::new();
    body.insert("model".to_owned(), json!(request.model.id));
    body.insert("max_tokens".to_owned(), json!(max_tokens));
    body.insert("stream".to_owned(), json!(true));
    body.insert(
        "messages".to_owned(),
        Value::Array(to_anthropic_messages(request.messages)),
    );
    if !request.system_prompt.is_empty() {
        body.insert(
            "system".to_owned(),
            json!([{ "type": "text", "text": request.system_prompt, "cache_control": ephemeral() }]),
        );
    }
    if !request.tools.is_empty() {
        let mut tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({ "name": tool.name, "description": tool.description,
                    "input_schema": tool.parameters })
            })
            .collect();
        if let Some(Value::Object(last)) = tools.last_mut() {
            last.insert("cache_control".to_owned(), ephemeral());
        }
        body.insert("tools".to_owned(), Value::Array(tools));
        if request.tool_choice == Some(ToolChoice::None) {
            body.insert("tool_choice".to_owned(), json!({ "type": "none" }));
        }
    }
    if request.model.reasoning && request.thinking != ThinkingLevel::Off {
        if truthy(flags.get("forceAdaptiveThinking")) {
            body.insert("thinking".to_owned(), json!({ "type": "adaptive" }));
            body.insert(
                "output_config".to_owned(),
                json!({ "effort": effort(request.thinking) }),
            );
        } else {
            let budget = budget(request.thinking).min((i128::from(max_tokens) - 1).max(1024));
            body.insert(
                "thinking".to_owned(),
                json!({ "type": "enabled", "budget_tokens": budget }),
            );
        }
    }
    body
}

/// The headers object of the TS code (exact keys, a later key replaces an
/// earlier one) as `fetch` sends it: names are case-insensitive, so
/// differently cased duplicates are joined with ", ", and values lose
/// leading and trailing HTTP white space.
#[derive(Default)]
struct HeaderObject(Vec<(String, String)>);

impl HeaderObject {
    fn set(&mut self, name: &str, value: &str) {
        match self.0.iter_mut().find(|(existing, _)| existing == name) {
            Some(entry) => entry.1 = value.to_owned(),
            None => self.0.push((name.to_owned(), value.to_owned())),
        }
    }

    /// `None` when a name or value is not valid HTTP (fetch throws then).
    fn to_map(&self) -> Option<HeaderMap> {
        let mut combined: Vec<(String, String)> = Vec::new();
        for (name, value) in &self.0 {
            let name = name.to_ascii_lowercase();
            let value = value.trim_matches([' ', '\t', '\n', '\r']);
            match combined.iter_mut().find(|(existing, _)| *existing == name) {
                Some(entry) => {
                    entry.1.push_str(", ");
                    entry.1.push_str(value);
                }
                None => combined.push((name, value.to_owned())),
            }
        }
        let mut map = HeaderMap::with_capacity(combined.len());
        for (name, value) in combined {
            let name = HeaderName::from_bytes(name.as_bytes()).ok()?;
            map.insert(name, HeaderValue::from_str(&value).ok()?);
        }
        Some(map)
    }
}

/// `httpError`: the status and the first 2000 UTF-16 units of the body.
fn http_error(status: reqwest::StatusCode, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let mut units = 0;
    let text: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 2000
        })
        .collect();
    let text = if text.is_empty() {
        status.canonical_reason().unwrap_or("").to_owned()
    } else {
        text
    };
    format!("HTTP {}: {text}", status.as_u16())
}

/// A JavaScript string concatenation operand (`undefined` included).
fn concat(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::to_js_string)
}

/// Map keys compare by SameValueZero; a freshly parsed object never
/// matches. `None` is `undefined` (no `index` field).
fn same_key(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Thinking,
    Tool,
    ToolDone,
}

/// An Anthropic content block: our content index and raw tool JSON.
struct Block {
    key: Option<Value>,
    content_index: usize,
    raw: String,
    kind: Kind,
}

pub struct NativeAnthropicRun {
    message: AssistantMessage,
    /// The `blocks` map, in insertion order.
    blocks: Vec<Block>,
}

impl NativeAnthropicRun {
    pub fn new(request: &StreamRequest<'_>) -> Self {
        Self {
            message: assistant(
                "anthropic-messages",
                request.provider_name,
                &request.model.id,
                StopReason::Stop,
            ),
            blocks: Vec::new(),
        }
    }

    fn fix_total(mut message: AssistantMessage) -> AssistantMessage {
        let usage = &mut message.usage;
        usage.total_tokens = usage
            .input
            .saturating_add(usage.output)
            .saturating_add(usage.cache_read)
            .saturating_add(usage.cache_write);
        message
    }

    /// The `catch` path: tool calls whose block never stopped are dropped.
    fn drop_unfinished(&self, message: &mut AssistantMessage) {
        let unfinished: Vec<usize> = self
            .blocks
            .iter()
            .filter(|block| block.kind == Kind::Tool)
            .map(|block| block.content_index)
            .collect();
        let mut index = 0;
        message.content.retain(|part| {
            let keep =
                !(matches!(part, AssistantContent::ToolCall { .. }) && unfinished.contains(&index));
            index += 1;
            keep
        });
    }

    /// The `catch` path for an aborted request.
    pub fn aborted(&self) -> AssistantMessage {
        let mut message = self.message.clone();
        self.drop_unfinished(&mut message);
        message.stop_reason = StopReason::Aborted;
        Self::fix_total(message)
    }

    pub async fn run(
        &mut self,
        client: &reqwest::Client,
        request: &StreamRequest<'_>,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Cancelled> {
        match self.stream(client, request, emit).await {
            Ok(()) => Ok(Self::fix_total(self.message.clone())),
            Err(Failure::Cancelled) => Err(Cancelled),
            Err(Failure::Upstream(error)) => {
                if emit.cancelled() {
                    return Err(Cancelled);
                }
                let mut message = self.message.clone();
                self.drop_unfinished(&mut message);
                message.stop_reason = StopReason::Error;
                message.error_message = Some(error);
                self.message = message;
                Ok(Self::fix_total(self.message.clone()))
            }
        }
    }

    async fn stream(
        &mut self,
        client: &reqwest::Client,
        request: &StreamRequest<'_>,
        emit: &mut Emitter<'_>,
    ) -> Result<(), Failure> {
        let base = request.provider.base_url.as_str();
        let url = format!("{}/v1/messages", base.strip_suffix('/').unwrap_or(base));
        let mut headers = HeaderObject::default();
        headers.set("content-type", "application/json");
        headers.set("accept", "text/event-stream");
        headers.set("anthropic-version", "2023-06-01");
        for (name, value) in &request.provider.headers {
            headers.set(name, value);
        }
        let model_url = request
            .model
            .base_url
            .as_deref()
            .unwrap_or(&request.provider.base_url);
        let opencode =
            opencode_headers(request.provider.opencode_go, model_url, &request.session_id)
                .map_err(|()| Failure::upstream("Invalid URL"))?;
        for (name, value) in opencode {
            headers.set(name, &value);
        }
        if let Some(key) = request.api_key.filter(|key| !key.is_empty()) {
            headers.set("x-api-key", key);
        }
        let header_map = headers
            .to_map()
            .ok_or_else(|| Failure::upstream("Invalid header"))?;
        let body = serde_json::to_vec(&anthropic_body(request)).unwrap_or_default();
        let mut response = client
            .post(&url)
            .headers(header_map)
            .body(body)
            .send()
            .await
            .map_err(|error| {
                Failure::upstream(if error.is_connect() {
                    "Unable to connect. Is the computer able to access the url?"
                } else {
                    "The socket connection was closed unexpectedly."
                })
            })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.bytes().await.unwrap_or_default();
            return Err(Failure::Upstream(http_error(status, &body)));
        }
        let mut decoder = NativeDecoder::default();
        let mut stop: Option<Value> = None;
        loop {
            let (events, ended) = match response.chunk().await {
                Ok(Some(bytes)) => (decoder.push(&bytes), false),
                Ok(None) => (decoder.finish().into_iter().collect(), true),
                Err(_) => {
                    return Err(Failure::upstream(
                        "The socket connection was closed unexpectedly.",
                    ));
                }
            };
            for event in events {
                self.event(&event.data, &mut stop, emit)?;
            }
            if ended {
                break;
            }
        }
        self.message.stop_reason = match stop.as_ref().and_then(Value::as_str) {
            Some("tool_use") => StopReason::ToolUse,
            Some("max_tokens") => StopReason::Length,
            _ => StopReason::Stop,
        };
        Ok(())
    }

    fn block(&self, key: Option<&Value>) -> Option<usize> {
        self.blocks
            .iter()
            .position(|block| same_key(block.key.as_ref(), key))
    }

    /// `blocks.set`: an existing key keeps its place.
    fn set_block(&mut self, key: Option<&Value>, content_index: usize, kind: Kind) {
        let block = Block {
            key: key.cloned(),
            content_index,
            raw: String::new(),
            kind,
        };
        match self.block(key) {
            Some(position) => self.blocks[position] = block,
            None => self.blocks.push(block),
        }
    }

    fn event(
        &mut self,
        data: &str,
        stop: &mut Option<Value>,
        emit: &mut Emitter<'_>,
    ) -> Result<(), Failure> {
        let event: Value = crate::json_parse::parse_event(data)
            .map_err(|_| Failure::upstream("JSON Parse error: Unable to parse JSON string"))?;
        if event.is_null() {
            return Err(Failure::upstream(
                "null is not an object (evaluating 'event.type')",
            ));
        }
        let event = Some(&event);
        match get(event, "type").and_then(Value::as_str) {
            Some("message_start") => {
                let usage = present(get(get(event, "message"), "usage"));
                let number = |key: &str| {
                    present(get(usage, key))
                        .and_then(Value::as_f64)
                        .map_or(0, js::to_u64)
                };
                let usage_out = &mut self.message.usage;
                usage_out.input = number("input_tokens");
                usage_out.cache_read = number("cache_read_input_tokens");
                usage_out.cache_write = number("cache_creation_input_tokens");
                usage_out.output = number("output_tokens");
            }
            Some("content_block_start") => self.block_start(event, emit)?,
            Some("content_block_delta") => self.block_delta(event, emit)?,
            Some("content_block_stop") => self.block_stop(event, emit)?,
            Some("message_delta") => {
                if let Some(reason) = get(get(event, "delta"), "stop_reason")
                    && truthy(Some(reason))
                {
                    *stop = Some(reason.clone());
                }
                let output = get(get(event, "usage"), "output_tokens");
                if truthy(output)
                    && let Some(output) = output.and_then(Value::as_f64)
                {
                    self.message.usage.output = js::to_u64(output);
                }
            }
            Some("error") => {
                let error = get(event, "error");
                let message = match present(get(error, "message")) {
                    Some(message) => js::to_js_string(message),
                    // `JSON.stringify(undefined)` makes `new Error(undefined)`.
                    None => error.map(Value::to_string).unwrap_or_default(),
                };
                return Err(Failure::Upstream(message));
            }
            _ => {}
        }
        Ok(())
    }

    fn block_start(
        &mut self,
        event: Option<&Value>,
        emit: &mut Emitter<'_>,
    ) -> Result<(), Failure> {
        let block = present(get(event, "content_block"));
        let key = get(event, "index");
        let (part, kind) = match get(block, "type").and_then(Value::as_str) {
            Some("text") => (
                AssistantContent::Text {
                    text: String::new(),
                    text_signature: None,
                },
                Kind::Text,
            ),
            Some(kind @ ("thinking" | "redacted_thinking")) => {
                let redacted = kind == "redacted_thinking";
                (
                    AssistantContent::Thinking {
                        thinking: String::new(),
                        signature: if redacted {
                            present(get(block, "data")).map(js::to_js_string)
                        } else {
                            None
                        },
                        redacted: redacted.then_some(true),
                    },
                    Kind::Thinking,
                )
            }
            Some("tool_use") => {
                let text = |key| {
                    present(get(block, key))
                        .map(js::to_js_string)
                        .unwrap_or_default()
                };
                (
                    AssistantContent::ToolCall {
                        id: text("id"),
                        name: text("name"),
                        arguments: Map::new(),
                        thought_signature: None,
                    },
                    Kind::Tool,
                )
            }
            _ => return Ok(()),
        };
        let delta = match &part {
            AssistantContent::Text { .. } => AssistantDelta::TextStart {
                content_index: content_index(self.message.content.len()),
            },
            AssistantContent::Thinking { .. } => AssistantDelta::ThinkingStart {
                content_index: content_index(self.message.content.len()),
            },
            AssistantContent::ToolCall { id, name, .. } => AssistantDelta::ToolcallStart {
                content_index: content_index(self.message.content.len()),
                id: id.clone(),
                tool_name: name.clone(),
            },
        };
        self.message.content.push(part);
        self.set_block(key, self.message.content.len() - 1, kind);
        emit.emit(delta, &self.message)?;
        Ok(())
    }

    fn block_delta(
        &mut self,
        event: Option<&Value>,
        emit: &mut Emitter<'_>,
    ) -> Result<(), Failure> {
        let Some(position) = self.block(get(event, "index")) else {
            return Ok(());
        };
        let delta = present(get(event, "delta"));
        let index = self.blocks[position].content_index;
        let part = &mut self.message.content[index];
        let delta = match get(delta, "type").and_then(Value::as_str) {
            Some("text_delta") => {
                let piece = concat(get(delta, "text"));
                if let AssistantContent::Text { text, .. } = part {
                    text.push_str(&piece);
                }
                AssistantDelta::TextDelta {
                    content_index: content_index(index),
                    delta: piece,
                }
            }
            Some("thinking_delta") => {
                let piece = concat(get(delta, "thinking"));
                if let AssistantContent::Thinking { thinking, .. } = part {
                    thinking.push_str(&piece);
                }
                AssistantDelta::ThinkingDelta {
                    content_index: content_index(index),
                    delta: piece,
                }
            }
            Some("signature_delta") => {
                if let AssistantContent::Thinking { signature, .. } = part {
                    let mut joined = signature.take().unwrap_or_default();
                    joined.push_str(&concat(get(delta, "signature")));
                    *signature = Some(joined);
                }
                return Ok(());
            }
            Some("input_json_delta") => {
                let piece = concat(get(delta, "partial_json"));
                self.blocks[position].raw.push_str(&piece);
                AssistantDelta::ToolcallDelta {
                    content_index: content_index(index),
                    delta: piece,
                }
            }
            _ => return Ok(()),
        };
        emit.emit(delta, &self.message)?;
        Ok(())
    }

    fn block_stop(&mut self, event: Option<&Value>, emit: &mut Emitter<'_>) -> Result<(), Failure> {
        let Some(position) = self.block(get(event, "index")) else {
            return Ok(());
        };
        let block = &mut self.blocks[position];
        let index = block.content_index;
        let delta = match block.kind {
            Kind::Text => AssistantDelta::TextEnd {
                content_index: content_index(index),
                content: match &self.message.content[index] {
                    AssistantContent::Text { text, .. } => text.clone(),
                    _ => String::new(),
                },
            },
            Kind::Thinking => AssistantDelta::ThinkingEnd {
                content_index: content_index(index),
                content: match &self.message.content[index] {
                    AssistantContent::Thinking { thinking, .. } => thinking.clone(),
                    _ => String::new(),
                },
            },
            Kind::Tool | Kind::ToolDone => {
                let parsed = parse_tool_arguments(&block.raw);
                block.kind = Kind::ToolDone;
                let part = &mut self.message.content[index];
                if let AssistantContent::ToolCall { arguments, .. } = part {
                    *arguments = parsed;
                }
                AssistantDelta::ToolcallEnd {
                    content_index: content_index(index),
                    tool_call: part.clone(),
                }
            }
        };
        emit.emit(delta, &self.message)?;
        Ok(())
    }
}

enum Failure {
    Cancelled,
    Upstream(String),
}

impl Failure {
    fn upstream(text: &str) -> Self {
        Self::Upstream(text.to_owned())
    }
}

impl From<Cancelled> for Failure {
    fn from(Cancelled: Cancelled) -> Self {
        Self::Cancelled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_keys_follow_same_value_zero() {
        assert!(same_key(None, None));
        assert!(same_key(Some(&json!(1)), Some(&json!(1.0))));
        assert!(!same_key(Some(&json!(1)), Some(&json!("1"))));
        assert!(!same_key(Some(&json!(null)), None));
        assert!(!same_key(Some(&json!([])), Some(&json!([]))));
    }

    #[test]
    fn headers_join_like_fetch() {
        let mut headers = HeaderObject::default();
        headers.set("accept", "a");
        headers.set("Accept", " b ");
        headers.set("accept", "c");
        let map = headers.to_map().unwrap();
        assert_eq!(map.get("accept").unwrap(), "c, b");
    }

    #[test]
    fn http_errors_cut_utf16_units() {
        let body = "é".repeat(2001);
        let text = http_error(reqwest::StatusCode::BAD_REQUEST, body.as_bytes());
        assert_eq!(text.chars().count(), "HTTP 400: ".len() + 2000);
        let text = http_error(reqwest::StatusCode::TOO_MANY_REQUESTS, b"");
        assert_eq!(text, "HTTP 429: Too Many Requests");
    }
}
