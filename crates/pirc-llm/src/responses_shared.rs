//! pi-ai 0.73.1's `openai-responses-shared` (`convertResponsesMessages`
//! with its tool call id normalization, `convertResponsesTools`,
//! `processResponsesStream`) and the pi-adapter state both Responses
//! transports keep around it.

use pirc_llm_types::{AssistantContent, AssistantDelta, AssistantMessage, StopReason, UserBlock};
use serde_json::{Map, Value, json};

use crate::errors::pi_failure;
use crate::http::opencode_headers;
use crate::js::{self, get, truthy};
use crate::json_parse::parse_streaming_json;
use crate::pi::{
    NO_KEY, PiMessage, PiModel, Source, api_name, history_message, pi_api, transform_messages,
};
use crate::stream::{StreamRequest, assistant, content_index, empty_usage};
use pirc_llm_types::UserContent;

/// Providers whose tool call ids keep their `call|item` form
/// (`OPENAI_TOOL_CALL_PROVIDERS`, `CODEX_TOOL_CALL_PROVIDERS`).
const TOOL_CALL_PROVIDERS: [&str; 3] = ["openai", "openai-codex", "opencode"];

/// The text of a thrown `TypeError` (only classified, never shown).
pub const TYPE_ERROR: &str = "TypeError: undefined is not an object";

/// `shortHash` (`utils/hash.js`), over UTF-16 code units.
pub fn short_hash(text: &str) -> String {
    let mut h1: u32 = 0xdead_beef;
    let mut h2: u32 = 0x41c6_ce57;
    for unit in text.encode_utf16() {
        let unit = u32::from(unit);
        h1 = (h1 ^ unit).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ unit).wrapping_mul(1_597_334_677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
    format!("{}{}", base36(h2), base36(h1))
}

fn base36(mut value: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The UTF-16 length of a string (`String.prototype.length`).
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `normalizeIdPart`: `[^a-zA-Z0-9_-]` (per UTF-16 unit) to `_`, at most
/// 64 units, no trailing `_`.
fn normalize_id_part(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for c in part.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out.truncate(64);
    out.trim_end_matches('_').to_owned()
}

/// `convertResponsesMessages`' `normalizeToolCallId`.
fn normalize_tool_call_id(id: &str, model: &PiModel, source: &Source<'_>) -> String {
    if !TOOL_CALL_PROVIDERS.contains(&model.provider.as_str()) || !id.contains('|') {
        return normalize_id_part(id);
    }
    let mut parts = id.split('|');
    let call_id = normalize_id_part(parts.next().unwrap_or_default());
    let item_id = parts.next().unwrap_or_default();
    let foreign = source.provider != model.provider || source.api != model.api;
    let mut item_id = if foreign {
        format!("fc_{}", short_hash(item_id))
    } else {
        normalize_id_part(item_id)
    };
    if !item_id.starts_with("fc_") {
        item_id = normalize_id_part(&format!("fc_{item_id}"));
    }
    format!("{call_id}|{item_id}")
}

/// `parseTextSignature`: the message item id (and phase) of a text block.
fn parse_text_signature(signature: Option<&str>) -> Option<(String, Option<&'static str>)> {
    let signature = signature.filter(|s| !s.is_empty())?;
    if signature.starts_with('{')
        && let Ok(parsed) = serde_json::from_str::<Value>(signature)
        && get(Some(&parsed), "v").and_then(Value::as_f64) == Some(1.0)
        && let Some(id) = get(Some(&parsed), "id").and_then(Value::as_str)
    {
        let phase = match get(Some(&parsed), "phase").and_then(Value::as_str) {
            Some("commentary") => Some("commentary"),
            Some("final_answer") => Some("final_answer"),
            _ => None,
        };
        return Some((id.to_owned(), phase));
    }
    Some((signature.to_owned(), None))
}

fn input_image(mime_type: &str, data: &str) -> Value {
    json!({ "type": "input_image", "detail": "auto", "image_url": format!("data:{mime_type};base64,{data}") })
}

/// `convertResponsesMessages`. `system_prompt` is `None` when the caller
/// excludes it (`includeSystemPrompt: false`). Fails as `JSON.parse` of a
/// replayed reasoning item does.
pub fn convert_messages(
    model: &PiModel,
    system_prompt: Option<&str>,
    messages: &[PiMessage],
) -> Result<Vec<Value>, String> {
    let transformed = transform_messages(messages.to_vec(), model, &normalize_tool_call_id);
    let mut out = Vec::new();
    if let Some(system) = system_prompt.filter(|s| !s.is_empty()) {
        let role = if model.reasoning {
            "developer"
        } else {
            "system"
        };
        out.push(json!({ "role": role, "content": system }));
    }
    let mut msg_index = 0usize;
    for message in &transformed {
        match message {
            PiMessage::User(UserContent::Text(text)) => {
                out.push(
                    json!({ "role": "user", "content": [{ "type": "input_text", "text": text }] }),
                );
            }
            PiMessage::User(UserContent::Blocks(blocks)) => {
                let content: Vec<Value> = blocks
                    .iter()
                    .map(|block| match block {
                        UserBlock::Text { text, .. } => {
                            json!({ "type": "input_text", "text": text })
                        }
                        UserBlock::Image { data, mime_type } => input_image(mime_type, data),
                    })
                    .collect();
                if content.is_empty() {
                    continue;
                }
                out.push(json!({ "role": "user", "content": content }));
            }
            PiMessage::Assistant {
                api,
                provider,
                model: message_model,
                content,
                ..
            } => {
                let different_model =
                    *message_model != model.id && *provider == model.provider && *api == model.api;
                let mut output = Vec::new();
                for block in content {
                    match block {
                        AssistantContent::Thinking { signature, .. } => {
                            if let Some(signature) = signature.as_deref().filter(|s| !s.is_empty())
                            {
                                let item =
                                    serde_json::from_str::<Value>(signature).map_err(|_| {
                                        "JSON Parse error: Unable to parse JSON string".to_owned()
                                    })?;
                                output.push(item);
                            }
                        }
                        AssistantContent::Text {
                            text,
                            text_signature,
                        } => {
                            let parsed = parse_text_signature(text_signature.as_deref());
                            let id = match parsed.as_ref().map(|(id, _)| id.as_str()) {
                                None | Some("") => format!("msg_{msg_index}"),
                                Some(id) if js_len(id) > 64 => format!("msg_{}", short_hash(id)),
                                Some(id) => id.to_owned(),
                            };
                            let mut item = Map::new();
                            item.insert("type".to_owned(), json!("message"));
                            item.insert("role".to_owned(), json!("assistant"));
                            item.insert(
                                "content".to_owned(),
                                json!([{ "type": "output_text", "text": text, "annotations": [] }]),
                            );
                            item.insert("status".to_owned(), json!("completed"));
                            item.insert("id".to_owned(), json!(id));
                            if let Some(phase) = parsed.and_then(|(_, phase)| phase) {
                                item.insert("phase".to_owned(), json!(phase));
                            }
                            output.push(Value::Object(item));
                        }
                        AssistantContent::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => {
                            let mut parts = id.split('|');
                            let call_id = parts.next().unwrap_or_default();
                            let item_id = parts
                                .next()
                                .filter(|item| !(different_model && item.starts_with("fc_")));
                            let mut item = Map::new();
                            item.insert("type".to_owned(), json!("function_call"));
                            if let Some(item_id) = item_id {
                                item.insert("id".to_owned(), json!(item_id));
                            }
                            item.insert("call_id".to_owned(), json!(call_id));
                            item.insert("name".to_owned(), json!(name));
                            item.insert(
                                "arguments".to_owned(),
                                json!(serde_json::to_string(arguments).unwrap_or_default()),
                            );
                            output.push(Value::Object(item));
                        }
                    }
                }
                if output.is_empty() {
                    continue;
                }
                out.extend(output);
            }
            PiMessage::ToolResult {
                tool_call_id,
                content,
                ..
            } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        UserBlock::Text { text, .. } => Some(text.as_str()),
                        UserBlock::Image { .. } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let has_images = content
                    .iter()
                    .any(|block| matches!(block, UserBlock::Image { .. }));
                let call_id = tool_call_id.split('|').next().unwrap_or_default();
                let output = if has_images && model.has_image_input() {
                    let mut parts = Vec::new();
                    if !text.is_empty() {
                        parts.push(json!({ "type": "input_text", "text": text }));
                    }
                    for block in content {
                        if let UserBlock::Image { data, mime_type } = block {
                            parts.push(input_image(mime_type, data));
                        }
                    }
                    Value::Array(parts)
                } else if text.is_empty() {
                    json!("(see attached image)")
                } else {
                    json!(text)
                };
                out.push(
                    json!({ "type": "function_call_output", "call_id": call_id, "output": output }),
                );
            }
        }
        msg_index += 1;
    }
    Ok(out)
}

/// `convertResponsesTools` with the given `strict` value.
pub fn convert_tools(tools: &[pirc_llm_types::ToolSpec], strict: &Value) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": Value::Object(tool.parameters.clone()),
                "strict": strict,
            })
        })
        .collect()
}

/// A template literal's `${value}` (`undefined` when absent).
fn template(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::to_js_string)
}

/// `a || b` on a property value.
fn or<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    value.filter(|v| truthy(Some(v))).unwrap_or(fallback)
}

fn type_of(value: Option<&Value>) -> Option<&str> {
    get(value, "type").and_then(Value::as_str)
}

/// `value.key` where `value` may be `null`/`undefined` (a `TypeError`).
fn member<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match value {
        None | Some(Value::Null) => Err(TYPE_ERROR.to_owned()),
        Some(value) => Ok(get(Some(value), key)),
    }
}

/// `list?.map((x) => x.text).join(separator) || ""`.
fn joined_texts(list: Option<&Value>, separator: &str) -> Result<String, String> {
    let Some(list) = list.filter(|v| !v.is_null()) else {
        return Ok(String::new());
    };
    let Some(items) = list.as_array() else {
        return Err(TYPE_ERROR.to_owned());
    };
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        parts.push(match member(Some(item), "text")? {
            None | Some(Value::Null) => String::new(),
            Some(text) => js::to_js_string(text),
        });
    }
    Ok(parts.join(separator))
}

/// `list = list || []` on a property, then the array (a `TypeError` when
/// it is something else that cannot be pushed to or indexed).
fn ensure_list<'a>(item: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>, String> {
    let Some(object) = item.as_object_mut() else {
        return Err(TYPE_ERROR.to_owned());
    };
    if !truthy(object.get(key)) {
        object.insert(key.to_owned(), Value::Array(Vec::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| TYPE_ERROR.to_owned())
}

/// `part.key += delta` on the last part (only its truthiness matters later).
fn append_to_part(part: &mut Value, key: &str, delta: &str) -> Result<(), String> {
    let Some(object) = part.as_object_mut() else {
        return Err(TYPE_ERROR.to_owned());
    };
    let text = format!("{}{delta}", template(object.get(key)));
    object.insert(key.to_owned(), Value::String(text));
    Ok(())
}

/// `mapStopReason`.
fn map_stop_reason(status: Option<&Value>) -> Result<StopReason, String> {
    if !truthy(status) {
        return Ok(StopReason::Stop);
    }
    match status.and_then(Value::as_str) {
        Some("completed" | "in_progress" | "queued") => Ok(StopReason::Stop),
        Some("incomplete") => Ok(StopReason::Length),
        Some("failed" | "cancelled") => Ok(StopReason::Error),
        _ => Err(format!("Unhandled stop reason: {}", template(status))),
    }
}

fn number_or_zero(value: Option<&Value>) -> f64 {
    if truthy(value) {
        js::number(value).unwrap_or(0.0)
    } else {
        0.0
    }
}

/// `encodeTextSignatureV1(item.id, item.phase ?? undefined)`.
fn text_signature(item: Option<&Value>) -> String {
    let mut payload = Map::new();
    payload.insert("v".to_owned(), json!(1));
    if let Some(id) = get(item, "id") {
        payload.insert("id".to_owned(), id.clone());
    }
    if let Some(phase) = get(item, "phase").filter(|p| truthy(Some(p))) {
        payload.insert("phase".to_owned(), phase.clone());
    }
    Value::Object(payload).to_string()
}

/// `${item.call_id}|${item.id}`.
fn call_id(item: Option<&Value>) -> String {
    format!(
        "{}|{}",
        template(get(item, "call_id")),
        template(get(item, "id"))
    )
}

/// `parseStreamingJson` of a property value that should be a string.
fn parse_arguments(value: &Value) -> Result<Value, String> {
    match value {
        Value::String(text) => Ok(parse_streaming_json(text)),
        _ if !truthy(Some(value)) => Ok(json!({})),
        _ => Err(TYPE_ERROR.to_owned()),
    }
}

/// Arguments as the wire carries them (an object).
fn wire_arguments(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// `processResponsesStream`: one event at a time, into the Pi output.
#[derive(Default)]
pub struct Processor {
    /// `currentItem`: the item of the last `output_item.added` we track.
    item: Option<Value>,
    /// `currentBlock`: always the last block of the output when set.
    block: Option<usize>,
    /// The current tool call block's `partialJson`.
    partial_json: String,
}

impl Processor {
    fn item_type(&self) -> Option<&str> {
        type_of(self.item.as_ref())
    }

    fn block<'a>(&self, out: &'a mut AssistantMessage) -> Option<&'a mut AssistantContent> {
        self.block.and_then(|index| out.content.get_mut(index))
    }

    fn last_index(out: &AssistantMessage) -> u32 {
        content_index(out.content.len().saturating_sub(1))
    }

    /// Handle one event; `Err` is the text of what `processResponsesStream`
    /// throws.
    pub fn event(
        &mut self,
        out: &mut AssistantMessage,
        event: &Value,
    ) -> Result<Option<AssistantDelta>, String> {
        let event_ref = Some(event);
        let kind = member(event_ref, "type")?.and_then(Value::as_str);
        let Some(kind) = kind else {
            return Ok(None);
        };
        let delta_text = || template(get(event_ref, "delta"));
        match kind {
            "response.created" => {
                let response = get(event_ref, "response");
                let id = member(response, "id")?;
                out.response_id = id.filter(|id| !id.is_null()).map(js::to_js_string);
            }
            "response.output_item.added" => {
                let item = get(event_ref, "item");
                let item_type = member(item, "type")?.and_then(Value::as_str);
                let item = item.cloned().unwrap_or_default();
                let delta = match item_type {
                    Some("reasoning") => {
                        out.content.push(AssistantContent::Thinking {
                            thinking: String::new(),
                            signature: None,
                            redacted: None,
                        });
                        AssistantDelta::ThinkingStart {
                            content_index: Self::last_index(out),
                        }
                    }
                    Some("message") => {
                        out.content.push(AssistantContent::Text {
                            text: String::new(),
                            text_signature: None,
                        });
                        AssistantDelta::TextStart {
                            content_index: Self::last_index(out),
                        }
                    }
                    Some("function_call") => {
                        let id = call_id(Some(&item));
                        let name = get(Some(&item), "name")
                            .filter(|n| !n.is_null())
                            .map(js::to_js_string)
                            .unwrap_or_default();
                        self.partial_json = match get(Some(&item), "arguments") {
                            Some(args) if truthy(Some(args)) => js::to_js_string(args),
                            _ => String::new(),
                        };
                        out.content.push(AssistantContent::ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            arguments: Map::new(),
                            thought_signature: None,
                        });
                        AssistantDelta::ToolcallStart {
                            content_index: Self::last_index(out),
                            id,
                            tool_name: name,
                        }
                    }
                    _ => return Ok(None),
                };
                self.item = Some(item);
                self.block = Some(out.content.len() - 1);
                return Ok(Some(delta));
            }
            "response.reasoning_summary_part.added" => {
                if self.item_type() == Some("reasoning")
                    && let Some(item) = self.item.as_mut()
                {
                    let part = get(event_ref, "part").cloned().unwrap_or_default();
                    ensure_list(item, "summary")?.push(part);
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_summary_part.done" => {
                if self.item_type() != Some("reasoning")
                    || !matches!(self.block(out), Some(AssistantContent::Thinking { .. }))
                {
                    return Ok(None);
                }
                let delta = if kind == "response.reasoning_summary_part.done" {
                    "\n\n".to_owned()
                } else {
                    delta_text()
                };
                let Some(item) = self.item.as_mut() else {
                    return Ok(None);
                };
                let summary = ensure_list(item, "summary")?;
                let Some(last) = summary.last_mut().filter(|part| truthy(Some(part))) else {
                    return Ok(None);
                };
                if let Some(AssistantContent::Thinking { thinking, .. }) =
                    self.block.and_then(|index| out.content.get_mut(index))
                {
                    thinking.push_str(&delta);
                }
                append_to_part(last, "text", &delta)?;
                return Ok(Some(AssistantDelta::ThinkingDelta {
                    content_index: Self::last_index(out),
                    delta,
                }));
            }
            "response.reasoning_text.delta" => {
                if self.item_type() == Some("reasoning")
                    && let Some(AssistantContent::Thinking { thinking, .. }) = self.block(out)
                {
                    let delta = delta_text();
                    thinking.push_str(&delta);
                    return Ok(Some(AssistantDelta::ThinkingDelta {
                        content_index: Self::last_index(out),
                        delta,
                    }));
                }
            }
            "response.content_part.added" => {
                if self.item_type() == Some("message")
                    && let Some(item) = self.item.as_mut()
                {
                    let part = get(event_ref, "part");
                    let content = ensure_list(item, "content")?;
                    let part_type = member(part, "type")?.and_then(Value::as_str);
                    if matches!(part_type, Some("output_text" | "refusal")) {
                        content.push(part.cloned().unwrap_or_default());
                    }
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let (part_type, key) = if kind == "response.output_text.delta" {
                    ("output_text", "text")
                } else {
                    ("refusal", "refusal")
                };
                if self.item_type() != Some("message")
                    || !matches!(self.block(out), Some(AssistantContent::Text { .. }))
                {
                    return Ok(None);
                }
                let Some(last) = self
                    .item
                    .as_mut()
                    .and_then(|item| item.get_mut("content"))
                    .and_then(Value::as_array_mut)
                    .and_then(|content| content.last_mut())
                else {
                    return Ok(None);
                };
                if type_of(Some(last)) != Some(part_type) {
                    return Ok(None);
                }
                let delta = delta_text();
                if let Some(AssistantContent::Text { text, .. }) =
                    self.block.and_then(|index| out.content.get_mut(index))
                {
                    text.push_str(&delta);
                }
                append_to_part(last, key, &delta)?;
                return Ok(Some(AssistantDelta::TextDelta {
                    content_index: Self::last_index(out),
                    delta,
                }));
            }
            "response.function_call_arguments.delta" => {
                if self.item_type() == Some("function_call")
                    && matches!(self.block(out), Some(AssistantContent::ToolCall { .. }))
                {
                    let delta = delta_text();
                    self.partial_json.push_str(&delta);
                    let parsed = wire_arguments(&parse_streaming_json(&self.partial_json));
                    if let Some(AssistantContent::ToolCall { arguments, .. }) = self.block(out) {
                        *arguments = parsed;
                    }
                    return Ok(Some(AssistantDelta::ToolcallDelta {
                        content_index: Self::last_index(out),
                        delta,
                    }));
                }
            }
            "response.function_call_arguments.done" => {
                if self.item_type() == Some("function_call")
                    && matches!(self.block(out), Some(AssistantContent::ToolCall { .. }))
                {
                    let done = get(event_ref, "arguments").cloned().unwrap_or_default();
                    let parsed = parse_arguments(&done);
                    let Value::String(done) = done else {
                        if let (Ok(parsed), Some(AssistantContent::ToolCall { arguments, .. })) =
                            (parsed, self.block(out))
                        {
                            *arguments = wire_arguments(&parsed);
                        }
                        return Err(TYPE_ERROR.to_owned());
                    };
                    let previous = std::mem::replace(&mut self.partial_json, done.clone());
                    if let (Ok(parsed), Some(AssistantContent::ToolCall { arguments, .. })) =
                        (parsed, self.block(out))
                    {
                        *arguments = wire_arguments(&parsed);
                    }
                    if let Some(delta) = done.strip_prefix(previous.as_str())
                        && !delta.is_empty()
                    {
                        return Ok(Some(AssistantDelta::ToolcallDelta {
                            content_index: Self::last_index(out),
                            delta: delta.to_owned(),
                        }));
                    }
                }
            }
            "response.output_item.done" => return self.item_done(out, get(event_ref, "item")),
            "response.completed" => {
                let response = get(event_ref, "response");
                if let Some(id) = get(response, "id").filter(|id| truthy(Some(id))) {
                    out.response_id = Some(js::to_js_string(id));
                }
                let usage = get(response, "usage");
                if truthy(usage) {
                    let cached =
                        number_or_zero(get(get(usage, "input_tokens_details"), "cached_tokens"));
                    let input = number_or_zero(get(usage, "input_tokens")) - cached;
                    let output = number_or_zero(get(usage, "output_tokens"));
                    let mut parsed = empty_usage();
                    parsed.input = js::to_u64(input);
                    parsed.output = js::to_u64(output);
                    parsed.cache_read = js::to_u64(cached);
                    parsed.total_tokens = parsed.input + parsed.output + parsed.cache_read;
                    out.usage = parsed;
                }
                out.stop_reason = map_stop_reason(get(response, "status"))?;
                if out.stop_reason == StopReason::Stop
                    && out
                        .content
                        .iter()
                        .any(|block| matches!(block, AssistantContent::ToolCall { .. }))
                {
                    out.stop_reason = StopReason::ToolUse;
                }
            }
            "error" => {
                return Err(format!(
                    "Error Code {}: {}",
                    template(get(event_ref, "code")),
                    template(get(event_ref, "message"))
                ));
            }
            "response.failed" => {
                let response = get(event_ref, "response");
                let error = get(response, "error");
                let reason = get(get(response, "incomplete_details"), "reason");
                let unknown = json!("unknown");
                let no_message = json!("no message");
                return Err(if truthy(error) {
                    format!(
                        "{}: {}",
                        js::to_js_string(or(get(error, "code"), &unknown)),
                        js::to_js_string(or(get(error, "message"), &no_message))
                    )
                } else if truthy(reason) {
                    format!("incomplete: {}", template(reason))
                } else {
                    "Unknown error (no error details in response)".to_owned()
                });
            }
            _ => {}
        }
        Ok(None)
    }

    fn item_done(
        &mut self,
        out: &mut AssistantMessage,
        item: Option<&Value>,
    ) -> Result<Option<AssistantDelta>, String> {
        let item_type = member(item, "type")?.and_then(Value::as_str);
        let index = Self::last_index(out);
        match (item_type, self.block(out)) {
            (Some("reasoning"), Some(AssistantContent::Thinking { .. })) => {
                let summary = joined_texts(get(item, "summary"), "\n\n")?;
                let content = joined_texts(get(item, "content"), "\n\n")?;
                let signature = item.map(Value::to_string).unwrap_or_default();
                let Some(AssistantContent::Thinking {
                    thinking,
                    signature: block_signature,
                    ..
                }) = self.block(out)
                else {
                    return Ok(None);
                };
                if !summary.is_empty() {
                    *thinking = summary;
                } else if !content.is_empty() {
                    *thinking = content;
                }
                *block_signature = Some(signature);
                let content = thinking.clone();
                self.block = None;
                Ok(Some(AssistantDelta::ThinkingEnd {
                    content_index: index,
                    content,
                }))
            }
            (Some("message"), Some(AssistantContent::Text { .. })) => {
                let Some(parts) = get(item, "content").and_then(Value::as_array) else {
                    return Err(TYPE_ERROR.to_owned());
                };
                let mut joined = String::new();
                for part in parts {
                    let key = if member(Some(part), "type")?.and_then(Value::as_str)
                        == Some("output_text")
                    {
                        "text"
                    } else {
                        "refusal"
                    };
                    if let Some(text) = get(Some(part), key).filter(|t| !t.is_null()) {
                        joined.push_str(&js::to_js_string(text));
                    }
                }
                let signature = text_signature(item);
                if let Some(AssistantContent::Text {
                    text,
                    text_signature,
                }) = self.block(out)
                {
                    *text = joined.clone();
                    *text_signature = Some(signature);
                }
                self.block = None;
                Ok(Some(AssistantDelta::TextEnd {
                    content_index: index,
                    content: joined,
                }))
            }
            (Some("function_call"), current) => {
                let is_call = matches!(current, Some(AssistantContent::ToolCall { .. }));
                let args = if is_call && !self.partial_json.is_empty() {
                    parse_streaming_json(&self.partial_json)
                } else {
                    let fallback = json!("{}");
                    parse_arguments(or(get(item, "arguments"), &fallback))?
                };
                let tool_call = if is_call {
                    let Some(block) = self.block(out) else {
                        return Ok(None);
                    };
                    if let AssistantContent::ToolCall { arguments, .. } = block {
                        *arguments = wire_arguments(&args);
                    }
                    block.clone()
                } else {
                    AssistantContent::ToolCall {
                        id: call_id(item),
                        name: get(item, "name")
                            .filter(|n| !n.is_null())
                            .map(js::to_js_string)
                            .unwrap_or_default(),
                        arguments: wire_arguments(&args),
                        thought_signature: None,
                    }
                };
                self.block = None;
                Ok(Some(AssistantDelta::ToolcallEnd {
                    content_index: index,
                    tool_call,
                }))
            }
            _ => Ok(None),
        }
    }
}

/// pi-adapter's state around a pi-ai Responses stream: the adapter's
/// result before Pi's `start` event, Pi's output (`fromPi` form), and the
/// response status `onResponse` saw.
pub struct Shell {
    pub model: PiModel,
    initial: AssistantMessage,
    pub out: AssistantMessage,
    pub started: bool,
    pub status: Option<u16>,
    codex: bool,
}

/// What the adapter passes to the transport.
pub struct Prepared {
    pub api_key: String,
    pub headers: Vec<(&'static str, String)>,
    pub context: Vec<PiMessage>,
}

impl Shell {
    pub fn new(request: &StreamRequest<'_>) -> Self {
        let model = PiModel::new(request);
        let api = pi_api(api_name(request.model.api.unwrap_or(request.provider.api)));
        let initial = assistant(
            api,
            request.provider_name,
            &request.model.id,
            StopReason::Stop,
        );
        let mut out = initial.clone();
        out.api = model.api.clone();
        out.model = model.id.clone();
        out.canonical_provider = Some(model.provider.clone());
        Self {
            codex: initial.api == "openai-codex-responses",
            model,
            initial,
            out,
            started: false,
            status: None,
        }
    }

    /// `{ ...result, stopReason: 'aborted' }` of the adapter's `fail(true)`.
    pub fn aborted(&self) -> AssistantMessage {
        let mut result = if self.started {
            self.out.clone()
        } else {
            self.initial.clone()
        };
        result.stop_reason = StopReason::Aborted;
        result
    }

    fn early_error(&self, message: String) -> AssistantMessage {
        let mut result = self.initial.clone();
        result.stop_reason = StopReason::Error;
        result.error_message = Some(message);
        result
    }

    /// The adapter's `fail(false, upstream)` texts, with Codex's wording.
    fn failure(&self, upstream: Option<&str>) -> String {
        let text = pi_failure(self.status, upstream);
        if !self.codex {
            return text;
        }
        if let Some(rest) = text.strip_prefix("Model provider request failed (HTTP ") {
            format!("Model provider request failed (status {rest}")
        } else if text == "Model provider rate limit reached." {
            "Model usage limit reached.".to_owned()
        } else {
            text
        }
    }

    /// Pi's error event, classified by the adapter's `fail(false, …)`.
    pub fn failed(&self, upstream: &str) -> AssistantMessage {
        let mut result = self.out.clone();
        result.stop_reason = StopReason::Error;
        result.error_message = Some(self.failure(Some(upstream)));
        result
    }

    /// The adapter's checks and options before dispatch.
    pub fn prepare(&self, request: &StreamRequest<'_>) -> Result<Prepared, Box<AssistantMessage>> {
        // A managed subscription account never falls back to another credential.
        let key = request.api_key.map(js::trim).filter(|key| !key.is_empty());
        if request
            .provider
            .pi_provider
            .as_deref()
            .is_some_and(|p| !p.is_empty())
            && key.is_none()
        {
            return Err(Box::new(
                self.early_error("Model credentials are unavailable.".to_owned()),
            ));
        }
        let Ok(headers) = opencode_headers(
            request.provider.opencode_go,
            &self.model.base_url,
            &request.session_id,
        ) else {
            return Err(Box::new(self.early_error(self.failure(None))));
        };
        let context = request
            .messages
            .iter()
            .map(|message| history_message(message, request.provider_name, &self.model))
            .collect();
        Ok(Prepared {
            api_key: key.unwrap_or(NO_KEY).to_owned(),
            headers,
            context,
        })
    }

    /// Record a response status as `onResponse` does.
    pub fn saw_status(&mut self, status: u16) {
        if (100..=599).contains(&status) {
            self.status = Some(status);
        }
    }
}

/// `inferCopilotInitiator` and `hasCopilotVisionInput`
/// (`github-copilot-headers.js`).
#[cfg(feature = "openai-responses")]
pub fn copilot_headers(context: &[PiMessage]) -> Vec<(&'static str, String)> {
    let initiator = match context.last() {
        Some(PiMessage::User(_)) | None => "user",
        Some(_) => "agent",
    };
    let mut headers = vec![
        ("X-Initiator", initiator.to_owned()),
        ("Openai-Intent", "conversation-edits".to_owned()),
    ];
    let vision = context.iter().any(|message| match message {
        PiMessage::User(UserContent::Blocks(blocks)) => crate::pi::has_images(blocks),
        PiMessage::ToolResult { content, .. } => crate::pi::has_images(content),
        _ => false,
    });
    if vision {
        headers.push(("Copilot-Vision-Request", "true".to_owned()));
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_hash_matches_pi() {
        // Values from pi-ai's shortHash under Bun.
        assert_eq!(short_hash(""), "k4n83c7h0j2b");
        assert_eq!(short_hash("item_1"), "1k4htsumzev3m");
        assert_eq!(short_hash("é😀"), "102l7zrk951la");
        assert_eq!(short_hash(&"z".repeat(60)), "nql1l1ssizu2");
    }

    #[test]
    fn normalizes_id_parts() {
        assert_eq!(normalize_id_part("call_x+y__"), "call_x_y");
        assert_eq!(normalize_id_part("a😀"), "a");
        assert_eq!(normalize_id_part(&"z".repeat(70)).len(), 64);
    }

    #[test]
    fn parses_text_signatures() {
        assert_eq!(parse_text_signature(None), None);
        assert_eq!(
            parse_text_signature(Some(r#"{"v":1,"id":"msg_a","phase":"commentary"}"#)),
            Some(("msg_a".to_owned(), Some("commentary")))
        );
        assert_eq!(
            parse_text_signature(Some(r#"{"v":2,"id":"x"}"#)),
            Some((r#"{"v":2,"id":"x"}"#.to_owned(), None))
        );
        assert_eq!(
            parse_text_signature(Some("legacy")),
            Some(("legacy".to_owned(), None))
        );
    }

    #[test]
    fn maps_stop_reasons() {
        assert_eq!(map_stop_reason(None), Ok(StopReason::Stop));
        assert_eq!(
            map_stop_reason(Some(&json!("incomplete"))),
            Ok(StopReason::Length)
        );
        assert_eq!(
            map_stop_reason(Some(&json!("weird"))),
            Err("Unhandled stop reason: weird".to_owned())
        );
    }
}
