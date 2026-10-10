//! The `openai-completions` wire API as the TS gateway runs it: pi-adapter's
//! mapping (`createPiStream`, `modelFor`, `historyMessage`, `streamOptions`,
//! `fail`) around pi-ai 0.73.1's `streamOpenAICompletions` (request body,
//! compat detection, message conversion, streaming) and the `openai` 6.26.0
//! SDK it calls (headers, URL, error texts, SSE decoding).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use indexmap::IndexMap;
use pirc_protocol::{
    AssistantContent, AssistantDelta, AssistantMessage, Message, ModelApi, StopReason,
    ThinkingLevel, ToolChoice, UserBlock, UserContent,
};
use serde_json::{Map, Value, json};

use crate::errors::pi_failure;
use crate::http::{Headers, opencode_go_headers};
use crate::js::{self, get, non_empty_str, present, truthy};
use crate::json_parse::parse_streaming_json;
use crate::sse::{Event, SdkDecoder};
use crate::stream::{Cancelled, Emitter, StreamRequest, assistant, content_index, empty_usage};

/// Placeholder bearer for user-configured keyless endpoints.
const NO_KEY: &str = "pirc-no-api-key";
const SDK_USER_AGENT: &str = "OpenAI/JS 6.26.0";
/// The SDK's default request timeout, which ends once headers arrive.
const SDK_TIMEOUT: Duration = Duration::from_secs(600);

pub fn api_name(api: ModelApi) -> &'static str {
    match api {
        ModelApi::OpenaiChat => "openai-chat",
        ModelApi::AnthropicMessages => "anthropic-messages",
        ModelApi::OpenaiCompletions => "openai-completions",
        ModelApi::OpenaiResponses => "openai-responses",
        ModelApi::OpenaiCodexResponses => "openai-codex-responses",
    }
}

/// `piApi`: the legacy name maps to `openai-completions`.
pub fn pi_api(api: &str) -> &str {
    if api == "openai-chat" {
        "openai-completions"
    } else {
        api
    }
}

fn level_name(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
    }
}

/// The Pi model the adapter builds (`modelFor`).
pub struct PiModel {
    pub id: String,
    pub api: String,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    pub thinking_level_map: Option<IndexMap<String, Option<String>>>,
    pub input: Vec<String>,
    pub headers: IndexMap<String, String>,
    pub compat: Map<String, Value>,
}

impl PiModel {
    pub fn new(request: &StreamRequest<'_>) -> Self {
        let (model, provider) = (request.model, request.provider);
        let mut headers = provider.headers.clone();
        if let Some(extra) = &model.headers {
            headers.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        let mut compat = provider.compat.clone();
        compat.extend(model.compat.iter().map(|(k, v)| (k.clone(), v.clone())));
        Self {
            id: model.id.clone(),
            api: pi_api(api_name(model.api.unwrap_or(provider.api))).to_owned(),
            provider: model
                .canonical_provider
                .clone()
                .or_else(|| provider.pi_provider.clone())
                .unwrap_or_else(|| request.provider_name.to_owned()),
            base_url: model
                .base_url
                .clone()
                .unwrap_or_else(|| provider.base_url.clone()),
            reasoning: model.reasoning,
            thinking_level_map: model.thinking_level_map.clone(),
            input: model.input.clone(),
            headers,
            compat,
        }
    }

    /// `model.thinkingLevelMap?.[level]`: `None` is undefined, `Some(None)` null.
    fn level_map(&self, level: &str) -> Option<Option<&str>> {
        self.thinking_level_map
            .as_ref()?
            .get(level)
            .map(Option::as_deref)
    }

    /// `model.thinkingLevelMap?.[effort] ?? effort`.
    fn mapped_effort(&self, effort: &str) -> String {
        self.level_map(effort)
            .flatten()
            .unwrap_or(effort)
            .to_owned()
    }

    fn has_image_input(&self) -> bool {
        self.input.iter().any(|input| input == "image")
    }
}

/// The effective reasoning level (`streamOptions`): the requested level or
/// the next one the model supports.
pub fn reasoning_effort(request: &StreamRequest<'_>, model: &PiModel) -> Option<String> {
    let enabled = model.reasoning && request.thinking != ThinkingLevel::Off;
    if !enabled {
        return None;
    }
    let levels = ["minimal", "low", "medium", "high", "xhigh"];
    let available: Vec<(usize, &str)> = levels
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, level)| {
            model.level_map(level) != Some(None)
                && (*level != "xhigh" || model.level_map("xhigh").is_some())
        })
        .collect();
    let requested = levels
        .iter()
        .position(|level| *level == level_name(request.thinking));
    let requested = requested.unwrap_or(0);
    available
        .iter()
        .find(|(index, _)| *index >= requested)
        .or(available.last())
        .map(|(_, level)| (*level).to_owned())
}

/// pi-ai's context message (after the adapter's `historyMessage`).
#[derive(Clone, Debug)]
enum PiMessage {
    User(UserContent),
    Assistant {
        api: String,
        provider: String,
        model: String,
        content: Vec<AssistantContent>,
        stop_reason: StopReason,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: Vec<UserBlock>,
    },
}

fn history_message(message: &Message, provider_name: &str, model: &PiModel) -> PiMessage {
    match message {
        Message::User { content, .. } => PiMessage::User(content.clone()),
        Message::Custom { content, .. } => PiMessage::User(UserContent::Text(content.clone())),
        Message::CompactionSummary { summary, .. } => PiMessage::User(UserContent::Text(format!(
            "<summary>\nThe conversation so far was compacted into this summary:\n\n{summary}\n</summary>"
        ))),
        Message::Assistant(message) => PiMessage::Assistant {
            api: pi_api(&message.api).to_owned(),
            provider: message.canonical_provider.clone().unwrap_or_else(|| {
                if message.provider == provider_name {
                    model.provider.clone()
                } else {
                    message.provider.clone()
                }
            }),
            model: message.model.clone(),
            content: message.content.clone(),
            stop_reason: message.stop_reason,
        },
        Message::ToolResult {
            tool_call_id,
            tool_name,
            content,
            ..
        } => PiMessage::ToolResult {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            content: content.clone(),
        },
    }
}

fn has_tool_history(messages: &[PiMessage]) -> bool {
    messages.iter().any(|message| match message {
        PiMessage::ToolResult { .. } => true,
        PiMessage::Assistant { content, .. } => content
            .iter()
            .any(|part| matches!(part, AssistantContent::ToolCall { .. })),
        PiMessage::User(_) => false,
    })
}

fn has_images(blocks: &[UserBlock]) -> bool {
    blocks
        .iter()
        .any(|block| matches!(block, UserBlock::Image { .. }))
}

const USER_IMAGE_PLACEHOLDER: &str = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER: &str = "(tool image omitted: model does not support images)";

fn replace_images(content: &[UserBlock], placeholder: &str) -> Vec<UserBlock> {
    let mut result = Vec::with_capacity(content.len());
    let mut previous_was_placeholder = false;
    for block in content {
        match block {
            UserBlock::Image { .. } => {
                if !previous_was_placeholder {
                    result.push(UserBlock::Text {
                        text: placeholder.to_owned(),
                        text_signature: None,
                    });
                }
                previous_was_placeholder = true;
            }
            UserBlock::Text { text, .. } => {
                previous_was_placeholder = text == placeholder;
                result.push(block.clone());
            }
        }
    }
    result
}

/// `normalizeToolCallId` of `convertMessages`.
fn normalize_tool_call_id(id: &str, model: &PiModel) -> String {
    if let Some((call_id, _)) = id.split_once('|') {
        return call_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(40)
            .collect();
    }
    if model.provider == "openai" {
        return id.chars().take(40).collect();
    }
    id.to_owned()
}

/// `transformMessages`: image downgrade, cross-model thinking and tool call
/// ids, dropped failed turns, synthetic results for orphaned calls.
fn transform_messages(messages: Vec<PiMessage>, model: &PiModel) -> Vec<PiMessage> {
    let vision = model.has_image_input();
    let mut id_map: HashMap<String, String> = HashMap::new();
    let transformed: Vec<PiMessage> = messages
        .into_iter()
        .map(|message| match message {
            PiMessage::User(UserContent::Blocks(blocks)) if !vision => PiMessage::User(
                UserContent::Blocks(replace_images(&blocks, USER_IMAGE_PLACEHOLDER)),
            ),
            PiMessage::User(content) => PiMessage::User(content),
            PiMessage::ToolResult {
                tool_call_id,
                tool_name,
                content,
            } => {
                let content = if vision {
                    content
                } else {
                    replace_images(&content, TOOL_IMAGE_PLACEHOLDER)
                };
                let tool_call_id = id_map.get(&tool_call_id).cloned().unwrap_or(tool_call_id);
                PiMessage::ToolResult {
                    tool_call_id,
                    tool_name,
                    content,
                }
            }
            PiMessage::Assistant {
                api,
                provider,
                model: model_id,
                content,
                stop_reason,
            } => {
                let same = provider == model.provider && api == model.api && model_id == model.id;
                let content = content
                    .into_iter()
                    .filter_map(|block| match block {
                        AssistantContent::Thinking {
                            ref thinking,
                            ref signature,
                            redacted,
                        } => {
                            if redacted == Some(true) {
                                return same.then_some(block);
                            }
                            if same && signature.as_deref().is_some_and(|s| !s.is_empty()) {
                                return Some(block);
                            }
                            if js::trim(thinking).is_empty() {
                                return None;
                            }
                            if same {
                                return Some(block);
                            }
                            Some(AssistantContent::Text {
                                text: thinking.clone(),
                                text_signature: None,
                            })
                        }
                        AssistantContent::Text {
                            text,
                            text_signature,
                        } => Some(AssistantContent::Text {
                            text,
                            text_signature: if same { text_signature } else { None },
                        }),
                        AssistantContent::ToolCall {
                            id,
                            name,
                            arguments,
                            thought_signature,
                        } => {
                            let thought_signature = if same { thought_signature } else { None };
                            let id = if same {
                                id
                            } else {
                                let normalized = normalize_tool_call_id(&id, model);
                                if normalized != id {
                                    id_map.insert(id, normalized.clone());
                                }
                                normalized
                            };
                            Some(AssistantContent::ToolCall {
                                id,
                                name,
                                arguments,
                                thought_signature,
                            })
                        }
                    })
                    .collect();
                PiMessage::Assistant {
                    api,
                    provider,
                    model: model_id,
                    content,
                    stop_reason,
                }
            }
        })
        .collect();

    let mut result = Vec::with_capacity(transformed.len());
    let mut pending: Vec<(String, String)> = Vec::new();
    let mut existing: HashSet<String> = HashSet::new();
    let flush = |result: &mut Vec<PiMessage>,
                 pending: &mut Vec<(String, String)>,
                 existing: &mut HashSet<String>| {
        for (id, name) in pending.drain(..) {
            if !existing.contains(&id) {
                result.push(PiMessage::ToolResult {
                    tool_call_id: id,
                    tool_name: name,
                    content: vec![UserBlock::Text {
                        text: "No result provided".to_owned(),
                        text_signature: None,
                    }],
                });
            }
        }
        existing.clear();
    };
    for message in transformed {
        match &message {
            PiMessage::Assistant {
                content,
                stop_reason,
                ..
            } => {
                flush(&mut result, &mut pending, &mut existing);
                if matches!(stop_reason, StopReason::Error | StopReason::Aborted) {
                    continue;
                }
                let calls: Vec<(String, String)> = content
                    .iter()
                    .filter_map(|part| match part {
                        AssistantContent::ToolCall { id, name, .. } => {
                            Some((id.clone(), name.clone()))
                        }
                        _ => None,
                    })
                    .collect();
                if !calls.is_empty() {
                    pending = calls;
                    existing.clear();
                }
            }
            PiMessage::ToolResult { tool_call_id, .. } => {
                existing.insert(tool_call_id.clone());
            }
            PiMessage::User(_) => flush(&mut result, &mut pending, &mut existing),
        }
        result.push(message);
    }
    flush(&mut result, &mut pending, &mut existing);
    result
}

/// pi-ai's resolved `OpenAICompletionsCompat` (`getCompat`): explicit
/// values win over detection; `null` counts as unset.
pub struct Compat(Map<String, Value>);

impl Compat {
    pub fn new(model: &PiModel) -> Self {
        let provider = model.provider.as_str();
        let url = model.base_url.as_str();
        let is_zai = provider == "zai" || url.contains("api.z.ai");
        let is_moonshot = provider == "moonshotai"
            || provider == "moonshotai-cn"
            || url.contains("api.moonshot.");
        let is_cf_workers =
            provider == "cloudflare-workers-ai" || url.contains("api.cloudflare.com");
        let is_cf_gateway =
            provider == "cloudflare-ai-gateway" || url.contains("gateway.ai.cloudflare.com");
        let non_standard = provider == "cerebras"
            || url.contains("cerebras.ai")
            || provider == "xai"
            || url.contains("api.x.ai")
            || url.contains("chutes.ai")
            || url.contains("deepseek.com")
            || is_zai
            || is_moonshot
            || provider == "opencode"
            || url.contains("opencode.ai")
            || is_cf_workers
            || is_cf_gateway;
        let use_max_tokens = url.contains("chutes.ai") || is_moonshot || is_cf_gateway;
        let is_grok = provider == "xai" || url.contains("api.x.ai");
        let is_deepseek = provider == "deepseek" || url.contains("deepseek.com");
        let thinking_format = if is_deepseek {
            "deepseek"
        } else if is_zai {
            "zai"
        } else if provider == "openrouter" || url.contains("openrouter.ai") {
            "openrouter"
        } else {
            "openai"
        };
        let mut detected = json!({
            "supportsStore": !non_standard,
            "supportsDeveloperRole": !non_standard,
            "supportsReasoningEffort": !is_grok && !is_zai && !is_moonshot && !is_cf_gateway,
            "supportsUsageInStreaming": true,
            "maxTokensField": if use_max_tokens { "max_tokens" } else { "max_completion_tokens" },
            "requiresToolResultName": false,
            "requiresAssistantAfterToolResult": false,
            "requiresThinkingAsText": false,
            "requiresReasoningContentOnAssistantMessages": is_deepseek,
            "thinkingFormat": thinking_format,
            "openRouterRouting": {},
            "vercelGatewayRouting": {},
            "zaiToolStream": false,
            "supportsStrictMode": !is_moonshot && !is_cf_gateway,
            "sendSessionAffinityHeaders": false,
            "supportsLongCacheRetention": !(is_cf_workers || is_cf_gateway),
        });
        let detected = detected.as_object_mut().expect("object");
        if provider == "openrouter" && model.id.starts_with("anthropic/") {
            detected.insert("cacheControlFormat".to_owned(), json!("anthropic"));
        }
        for key in [
            "supportsStore",
            "supportsDeveloperRole",
            "supportsReasoningEffort",
            "supportsUsageInStreaming",
            "maxTokensField",
            "requiresToolResultName",
            "requiresAssistantAfterToolResult",
            "requiresThinkingAsText",
            "requiresReasoningContentOnAssistantMessages",
            "thinkingFormat",
            "openRouterRouting",
            "vercelGatewayRouting",
            "zaiToolStream",
            "supportsStrictMode",
            "cacheControlFormat",
            "sendSessionAffinityHeaders",
            "supportsLongCacheRetention",
        ] {
            if let Some(value) = present(model.compat.get(key)) {
                detected.insert(key.to_owned(), value.clone());
            }
        }
        Self(std::mem::take(detected))
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    fn truthy(&self, key: &str) -> bool {
        truthy(self.get(key))
    }

    fn is(&self, key: &str, value: &str) -> bool {
        self.get(key).and_then(Value::as_str) == Some(value)
    }

    fn not_false(&self, key: &str) -> bool {
        self.get(key) != Some(&Value::Bool(false))
    }
}

fn image_url(mime_type: &str, data: &str) -> Value {
    json!({ "type": "image_url", "image_url": { "url": format!("data:{mime_type};base64,{data}") } })
}

/// `convertMessages`: Pi messages to Chat Completions messages.
fn convert_messages(
    model: &PiModel,
    system_prompt: &str,
    messages: &[PiMessage],
    compat: &Compat,
) -> Vec<Value> {
    let bridge = || json!({ "role": "assistant", "content": "I have processed the tool results." });
    let mut params = Vec::new();
    if !system_prompt.is_empty() {
        let role = if model.reasoning && compat.truthy("supportsDeveloperRole") {
            "developer"
        } else {
            "system"
        };
        params.push(json!({ "role": role, "content": system_prompt }));
    }
    let mut last_role: Option<&str> = None;
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        if compat.truthy("requiresAssistantAfterToolResult")
            && last_role == Some("toolResult")
            && matches!(message, PiMessage::User(_))
        {
            params.push(bridge());
        }
        match message {
            PiMessage::User(UserContent::Text(text)) => {
                params.push(json!({ "role": "user", "content": text }));
                last_role = Some("user");
            }
            PiMessage::User(UserContent::Blocks(blocks)) => {
                let content: Vec<Value> = blocks
                    .iter()
                    .map(|block| match block {
                        UserBlock::Text { text, .. } => json!({ "type": "text", "text": text }),
                        UserBlock::Image { data, mime_type } => image_url(mime_type, data),
                    })
                    .collect();
                if !content.is_empty() {
                    params.push(json!({ "role": "user", "content": content }));
                    last_role = Some("user");
                }
            }
            PiMessage::Assistant { content, .. } => {
                if let Some(converted) = convert_assistant(model, content, compat) {
                    params.push(converted);
                    last_role = Some("assistant");
                }
            }
            PiMessage::ToolResult { .. } => {
                let mut images = Vec::new();
                let mut end = index;
                while let Some(PiMessage::ToolResult {
                    tool_call_id,
                    tool_name,
                    content,
                }) = messages.get(end)
                {
                    let text = content
                        .iter()
                        .filter_map(|block| match block {
                            UserBlock::Text { text, .. } => Some(text.as_str()),
                            UserBlock::Image { .. } => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let mut result = Map::new();
                    result.insert("role".to_owned(), json!("tool"));
                    let text = if text.is_empty() {
                        "(see attached image)".to_owned()
                    } else {
                        text
                    };
                    result.insert("content".to_owned(), json!(text));
                    result.insert("tool_call_id".to_owned(), json!(tool_call_id));
                    if compat.truthy("requiresToolResultName") && !tool_name.is_empty() {
                        result.insert("name".to_owned(), json!(tool_name));
                    }
                    params.push(Value::Object(result));
                    if has_images(content) && model.has_image_input() {
                        for block in content {
                            if let UserBlock::Image { data, mime_type } = block {
                                images.push(image_url(mime_type, data));
                            }
                        }
                    }
                    end += 1;
                }
                index = end - 1;
                if images.is_empty() {
                    last_role = Some("toolResult");
                } else {
                    if compat.truthy("requiresAssistantAfterToolResult") {
                        params.push(bridge());
                    }
                    let mut content = vec![
                        json!({ "type": "text", "text": "Attached image(s) from tool result:" }),
                    ];
                    content.extend(images);
                    params.push(json!({ "role": "user", "content": content }));
                    last_role = Some("user");
                }
            }
        }
        index += 1;
    }
    params
}

fn convert_assistant(
    model: &PiModel,
    content: &[AssistantContent],
    compat: &Compat,
) -> Option<Value> {
    let mut message = Map::new();
    message.insert("role".to_owned(), json!("assistant"));
    let empty = if compat.truthy("requiresAssistantAfterToolResult") {
        json!("")
    } else {
        Value::Null
    };
    message.insert("content".to_owned(), empty);
    let text_parts: Vec<&str> = content
        .iter()
        .filter_map(|part| match part {
            AssistantContent::Text { text, .. } if !js::trim(text).is_empty() => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect();
    let text = text_parts.concat();
    let thinking: Vec<(&str, Option<&str>)> = content
        .iter()
        .filter_map(|part| match part {
            AssistantContent::Thinking {
                thinking,
                signature,
                ..
            } if !js::trim(thinking).is_empty() => Some((thinking.as_str(), signature.as_deref())),
            _ => None,
        })
        .collect();
    if !thinking.is_empty() {
        if compat.truthy("requiresThinkingAsText") {
            let joined = thinking
                .iter()
                .map(|(text, _)| *text)
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut parts = vec![json!({ "type": "text", "text": joined })];
            parts.extend(
                text_parts
                    .iter()
                    .map(|text| json!({ "type": "text", "text": text })),
            );
            message.insert("content".to_owned(), Value::Array(parts));
        } else {
            if !text.is_empty() {
                message.insert("content".to_owned(), json!(text));
            }
            if let Some(signature) = thinking[0].1.filter(|s| !s.is_empty()) {
                let joined = thinking
                    .iter()
                    .map(|(text, _)| *text)
                    .collect::<Vec<_>>()
                    .join("\n");
                message.insert(signature.to_owned(), json!(joined));
            }
        }
    } else if !text.is_empty() {
        message.insert("content".to_owned(), json!(text));
    }
    let calls: Vec<&AssistantContent> = content
        .iter()
        .filter(|part| matches!(part, AssistantContent::ToolCall { .. }))
        .collect();
    if !calls.is_empty() {
        let mut tool_calls = Vec::with_capacity(calls.len());
        let mut details = Vec::new();
        for call in &calls {
            let AssistantContent::ToolCall {
                id,
                name,
                arguments,
                thought_signature,
            } = call
            else {
                continue;
            };
            tool_calls.push(json!({ "id": id, "type": "function", "function": {
                "name": name,
                "arguments": serde_json::to_string(arguments).unwrap_or_default(),
            } }));
            let detail = thought_signature
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(|signature| serde_json::from_str::<Value>(signature).ok())
                .filter(|value| truthy(Some(value)));
            details.extend(detail);
        }
        message.insert("tool_calls".to_owned(), Value::Array(tool_calls));
        if !details.is_empty() {
            message.insert("reasoning_details".to_owned(), Value::Array(details));
        }
    }
    if compat.truthy("requiresReasoningContentOnAssistantMessages")
        && model.reasoning
        && !message.contains_key("reasoning_content")
    {
        message.insert("reasoning_content".to_owned(), json!(""));
    }
    let has_content = match message.get("content") {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(parts)) => !parts.is_empty(),
        _ => false,
    };
    if !has_content && !message.contains_key("tool_calls") {
        return None;
    }
    Some(Value::Object(message))
}

fn add_cache_control(message: &mut Value, cache_control: &Value) -> bool {
    let Some(content) = message.get_mut("content") else {
        return false;
    };
    match content {
        Value::String(text) => {
            if text.is_empty() {
                return false;
            }
            *content = json!([{ "type": "text", "text": text, "cache_control": cache_control }]);
            true
        }
        Value::Array(parts) => {
            for part in parts.iter_mut().rev() {
                if part.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(part) = part.as_object_mut()
                {
                    part.insert("cache_control".to_owned(), cache_control.clone());
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn apply_anthropic_cache_control(
    messages: &mut [Value],
    tools: Option<&mut Vec<Value>>,
    cache_control: &Value,
) {
    if let Some(system) = messages
        .iter_mut()
        .find(|m| matches!(role(m), Some("system" | "developer")))
    {
        add_cache_control(system, cache_control);
    }
    if let Some(last) = tools.and_then(|tools| tools.last_mut())
        && let Some(last) = last.as_object_mut()
    {
        last.insert("cache_control".to_owned(), cache_control.clone());
    }
    for message in messages.iter_mut().rev() {
        if matches!(role(message), Some("user" | "assistant"))
            && add_cache_control(message, cache_control)
        {
            return;
        }
    }
}

/// What the adapter passes as `ProviderStreamOptions`.
pub struct Options {
    pub api_key: String,
    pub session_id: String,
    pub max_tokens: u64,
    pub reasoning_effort: Option<String>,
    pub tool_choice: Option<ToolChoice>,
    pub headers: Vec<(&'static str, String)>,
    /// `PI_CACHE_RETENTION=long`.
    pub long_cache_retention: bool,
}

fn tool_choice_name(choice: ToolChoice) -> &'static str {
    match choice {
        ToolChoice::Auto => "auto",
        ToolChoice::None => "none",
    }
}

/// `buildParams` (plus the adapter's `onPayload`, which re-sets the same
/// `tool_choice`).
fn build_params(
    model: &PiModel,
    system_prompt: &str,
    context: &[PiMessage],
    tools: &[pirc_protocol::ToolSpec],
    options: &Options,
    compat: &Compat,
) -> Map<String, Value> {
    let transformed = transform_messages(context.to_vec(), model);
    let mut messages = convert_messages(model, system_prompt, &transformed, compat);
    let long = options.long_cache_retention;
    let long_supported = compat.truthy("supportsLongCacheRetention");
    let cache_control = compat.is("cacheControlFormat", "anthropic").then(|| {
        if long && long_supported {
            json!({ "type": "ephemeral", "ttl": "1h" })
        } else {
            json!({ "type": "ephemeral" })
        }
    });
    let mut tool_params = if !tools.is_empty() {
        Some(
            tools
                .iter()
                .map(|tool| {
                    let mut function = Map::new();
                    function.insert("name".to_owned(), json!(tool.name));
                    function.insert("description".to_owned(), json!(tool.description));
                    function.insert(
                        "parameters".to_owned(),
                        Value::Object(tool.parameters.clone()),
                    );
                    if compat.not_false("supportsStrictMode") {
                        function.insert("strict".to_owned(), json!(false));
                    }
                    json!({ "type": "function", "function": function })
                })
                .collect::<Vec<_>>(),
        )
    } else if has_tool_history(context) {
        Some(Vec::new())
    } else {
        None
    };
    if let Some(cache_control) = &cache_control {
        apply_anthropic_cache_control(&mut messages, tool_params.as_mut(), cache_control);
    }

    let mut params = Map::new();
    params.insert("model".to_owned(), json!(model.id));
    params.insert("messages".to_owned(), Value::Array(messages));
    params.insert("stream".to_owned(), json!(true));
    if model.base_url.contains("api.openai.com") || (long && long_supported) {
        params.insert("prompt_cache_key".to_owned(), json!(options.session_id));
    }
    if long && long_supported {
        params.insert("prompt_cache_retention".to_owned(), json!("24h"));
    }
    if compat.not_false("supportsUsageInStreaming") {
        params.insert(
            "stream_options".to_owned(),
            json!({ "include_usage": true }),
        );
    }
    if compat.truthy("supportsStore") {
        params.insert("store".to_owned(), json!(false));
    }
    if options.max_tokens > 0 {
        let field = if compat.is("maxTokensField", "max_tokens") {
            "max_tokens"
        } else {
            "max_completion_tokens"
        };
        params.insert(field.to_owned(), json!(options.max_tokens));
    }
    let has_tools = !tools.is_empty();
    if let Some(tool_params) = tool_params {
        params.insert("tools".to_owned(), Value::Array(tool_params));
        if has_tools && compat.truthy("zaiToolStream") {
            params.insert("tool_stream".to_owned(), json!(true));
        }
    }
    if let Some(choice) = options.tool_choice {
        params.insert("tool_choice".to_owned(), json!(tool_choice_name(choice)));
    }
    let effort = options.reasoning_effort.as_deref();
    let format = |name: &str| compat.is("thinkingFormat", name) && model.reasoning;
    if format("zai") || format("qwen") {
        params.insert("enable_thinking".to_owned(), json!(effort.is_some()));
    } else if format("qwen-chat-template") {
        params.insert(
            "chat_template_kwargs".to_owned(),
            json!({ "enable_thinking": effort.is_some(), "preserve_thinking": true }),
        );
    } else if format("deepseek") {
        let kind = if effort.is_some() {
            "enabled"
        } else {
            "disabled"
        };
        params.insert("thinking".to_owned(), json!({ "type": kind }));
        if let Some(effort) = effort {
            params.insert(
                "reasoning_effort".to_owned(),
                json!(model.mapped_effort(effort)),
            );
        }
    } else if format("openrouter") {
        if let Some(effort) = effort {
            params.insert(
                "reasoning".to_owned(),
                json!({ "effort": model.mapped_effort(effort) }),
            );
        } else if model.level_map("off") != Some(None) {
            let off = model.level_map("off").flatten().unwrap_or("none");
            params.insert("reasoning".to_owned(), json!({ "effort": off }));
        }
    } else if model.reasoning && compat.truthy("supportsReasoningEffort") {
        if let Some(effort) = effort {
            params.insert(
                "reasoning_effort".to_owned(),
                json!(model.mapped_effort(effort)),
            );
        } else if let Some(Some(off)) = model.level_map("off") {
            params.insert("reasoning_effort".to_owned(), json!(off));
        }
    }
    if model.base_url.contains("openrouter.ai") && truthy(model.compat.get("openRouterRouting")) {
        params.insert(
            "provider".to_owned(),
            model.compat["openRouterRouting"].clone(),
        );
    }
    if model.base_url.contains("ai-gateway.vercel.sh")
        && truthy(model.compat.get("vercelGatewayRouting"))
    {
        let routing = model.compat.get("vercelGatewayRouting");
        let only = get(routing, "only");
        let order = get(routing, "order");
        if truthy(only) || truthy(order) {
            let mut gateway = Map::new();
            if let Some(only) = only.filter(|v| truthy(Some(v))) {
                gateway.insert("only".to_owned(), only.clone());
            }
            if let Some(order) = order.filter(|v| truthy(Some(v))) {
                gateway.insert("order".to_owned(), order.clone());
            }
            params.insert("providerOptions".to_owned(), json!({ "gateway": gateway }));
        }
    }
    params
}

/// `resolveCloudflareBaseUrl`: `{VAR}` placeholders from the environment.
fn cloudflare_base_url(model: &PiModel) -> Result<String, String> {
    let url = &model.base_url;
    let mut out = String::with_capacity(url.len());
    let mut rest = url.as_str();
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}');
        let name = close.map(|close| &after[..close]).filter(|name| {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
                && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        });
        match (name, close) {
            (Some(name), Some(close)) => {
                let value = std::env::var(name).ok().filter(|v| !v.is_empty());
                let Some(value) = value else {
                    return Err(format!(
                        "{name} is required for provider {} but is not set.",
                        model.provider
                    ));
                };
                out.push_str(&value);
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// The prepared HTTP request.
struct HttpRequest {
    url: String,
    headers: Headers,
    body: Map<String, Value>,
}

fn prepare(
    model: &PiModel,
    request: &StreamRequest<'_>,
    context: &[PiMessage],
    options: &Options,
) -> Result<HttpRequest, String> {
    let compat = Compat::new(model);
    let mut headers = Headers::default();
    headers.set("Accept", "application/json");
    headers.set("User-Agent", SDK_USER_AGENT);
    headers.set("Authorization", &format!("Bearer {}", options.api_key));
    // The client's defaultHeaders: a plain object, so later keys of the
    // same spelling replace earlier ones.
    let mut defaults: IndexMap<String, Option<String>> = model
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), Some(v.clone())))
        .collect();
    if model.provider == "github-copilot" {
        let initiator = match context.last() {
            Some(PiMessage::User(_)) | None => "user",
            Some(_) => "agent",
        };
        defaults.insert("X-Initiator".to_owned(), Some(initiator.to_owned()));
        defaults.insert(
            "Openai-Intent".to_owned(),
            Some("conversation-edits".to_owned()),
        );
        let vision = context.iter().any(|message| match message {
            PiMessage::User(UserContent::Blocks(blocks)) => has_images(blocks),
            PiMessage::ToolResult { content, .. } => has_images(content),
            _ => false,
        });
        if vision {
            defaults.insert("Copilot-Vision-Request".to_owned(), Some("true".to_owned()));
        }
    }
    if compat.truthy("sendSessionAffinityHeaders") {
        for name in ["session_id", "x-client-request-id", "x-session-affinity"] {
            defaults.insert(name.to_owned(), Some(options.session_id.clone()));
        }
    }
    for (name, value) in &options.headers {
        defaults.insert((*name).to_owned(), Some(value.clone()));
    }
    if model.provider == "cloudflare-ai-gateway" {
        let authorization = defaults.get("Authorization").cloned().flatten();
        defaults.insert("Authorization".to_owned(), authorization);
        defaults.insert(
            "cf-aig-authorization".to_owned(),
            Some(format!("Bearer {}", options.api_key)),
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
        cloudflare_base_url(model)?
    } else {
        model.base_url.clone()
    };
    let path = if base.ends_with('/') {
        "chat/completions"
    } else {
        "/chat/completions"
    };
    let body = build_params(
        model,
        request.system_prompt,
        context,
        request.tools,
        options,
        &compat,
    );
    Ok(HttpRequest {
        url: format!("{base}{path}"),
        headers,
        body,
    })
}

/// `APIError.makeMessage`.
fn api_error_message(status: Option<u16>, error: Option<&Value>, message: Option<&str>) -> String {
    let error = error.filter(|e| !e.is_null());
    let msg = match error {
        Some(error) if truthy(get(Some(error), "message")) => match &error["message"] {
            Value::String(text) => Some(text.clone()),
            other => Some(other.to_string()),
        },
        Some(error) if truthy(Some(error)) => Some(error.to_string()),
        _ => message.map(str::to_owned),
    }
    .filter(|msg| !msg.is_empty());
    match (status, msg) {
        (Some(status), Some(msg)) => format!("{status} {msg}"),
        (Some(status), None) => format!("{status} status code (no body)"),
        (None, Some(msg)) => msg,
        (None, None) => "(no status code or body)".to_owned(),
    }
}

/// pi-ai appends OpenRouter's `error.metadata.raw`.
fn with_raw_metadata(message: String, error: Option<&Value>) -> String {
    match get(get(error, "metadata"), "raw") {
        Some(raw) if truthy(Some(raw)) => format!("{message}\n{}", js::to_js_string(raw)),
        _ => message,
    }
}

/// The error text of a non-2xx response.
fn http_error(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let parsed = parsed.filter(|value| truthy(Some(value)));
    let error = get(parsed.as_ref(), "error");
    let message = if parsed.is_some() { None } else { Some(body) };
    with_raw_metadata(api_error_message(Some(status), error, message), error)
}

#[derive(Default)]
struct ToolScratch {
    partial_args: String,
    stream_index: Option<f64>,
    /// The parsed arguments, which need not be an object.
    arguments: Value,
}

enum Pending {
    TextStart(usize),
    TextDelta(usize, String),
    ThinkingStart(usize),
    ThinkingDelta(usize, String),
    ToolStart(usize),
    ToolDelta(usize, String),
}

/// One run: pi-ai's stream state plus the adapter's view of it.
pub struct PiRun {
    model: PiModel,
    /// The adapter's result before Pi's `start` event.
    initial: AssistantMessage,
    /// `fromPi(output)`: Pi's message in wire form.
    out: AssistantMessage,
    /// Pi's own `errorMessage` (not part of `fromPi`).
    pi_error: Option<String>,
    scratch: Vec<Option<ToolScratch>>,
    text_block: Option<usize>,
    thinking_block: Option<usize>,
    by_index: Vec<(f64, usize)>,
    by_id: HashMap<String, usize>,
    started: bool,
    status: Option<u16>,
}

/// Arguments as the wire carries them (an object).
fn wire_arguments(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

impl PiRun {
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
            model,
            initial,
            out,
            pi_error: None,
            scratch: Vec::new(),
            text_block: None,
            thinking_block: None,
            by_index: Vec::new(),
            by_id: HashMap::new(),
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

    /// The adapter's early error result (no request was made).
    pub fn error_without_request(&self, message: &str) -> AssistantMessage {
        let mut result = self.initial.clone();
        result.stop_reason = StopReason::Error;
        result.error_message = Some(message.to_owned());
        result
    }

    /// Pi's error event, classified by the adapter's `fail(false, …)`.
    fn failed(&self, upstream: &str) -> AssistantMessage {
        let mut result = self.out.clone();
        result.stop_reason = StopReason::Error;
        result.error_message = Some(pi_failure(self.status, Some(upstream)));
        result
    }

    pub async fn run(
        &mut self,
        client: &reqwest::Client,
        request: &StreamRequest<'_>,
        long_cache_retention: bool,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Cancelled> {
        // A managed subscription account never falls back to another credential.
        let key = request.api_key.map(js::trim).filter(|key| !key.is_empty());
        if request
            .provider
            .pi_provider
            .as_deref()
            .is_some_and(|p| !p.is_empty())
            && key.is_none()
        {
            return Ok(self.error_without_request("Model credentials are unavailable."));
        }
        let Ok(headers) = opencode_go_headers(
            request.provider.opencode_go,
            &self.model.base_url,
            &request.session_id,
        ) else {
            return Ok(self.error_without_request("Model provider request failed."));
        };
        let options = Options {
            api_key: key.unwrap_or(NO_KEY).to_owned(),
            session_id: request.session_id.clone(),
            max_tokens: request.max_tokens.unwrap_or(request.model.max_tokens),
            reasoning_effort: reasoning_effort(request, &self.model),
            tool_choice: request.tool_choice,
            headers,
            long_cache_retention,
        };
        let context: Vec<PiMessage> = request
            .messages
            .iter()
            .map(|message| history_message(message, request.provider_name, &self.model))
            .collect();
        let http = match prepare(&self.model, request, &context, &options) {
            Ok(http) => http,
            Err(upstream) => return Ok(self.failed(&upstream)),
        };
        match self.stream(client, http, emit).await {
            Ok(result) => Ok(result),
            Err(Failure::Cancelled) => Err(Cancelled),
            Err(Failure::Upstream(upstream)) => Ok(self.failed(&upstream)),
        }
    }

    async fn stream(
        &mut self,
        client: &reqwest::Client,
        http: HttpRequest,
        emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Failure> {
        let headers = http
            .headers
            .to_map()
            .ok_or_else(|| Failure::upstream("Connection error."))?;
        let body = serde_json::to_vec(&http.body).unwrap_or_default();
        let send = client.post(&http.url).headers(headers).body(body).send();
        let mut response = match tokio::time::timeout(SDK_TIMEOUT, send).await {
            Err(_) => return Err(Failure::upstream("Request timed out.")),
            Ok(Err(error)) if error.is_timeout() => {
                return Err(Failure::upstream("Request timed out."));
            }
            Ok(Err(_)) => return Err(Failure::upstream("Connection error.")),
            Ok(Ok(response)) => response,
        };
        let status = response.status().as_u16();
        if !response.status().is_success() {
            let body = response.bytes().await.unwrap_or_default();
            return Err(Failure::Upstream(http_error(
                status,
                &String::from_utf8_lossy(&body),
            )));
        }
        if (100..=599).contains(&status) {
            self.status = Some(status);
        }
        if emit.cancelled() {
            return Err(Failure::Cancelled);
        }
        self.started = true;

        let mut decoder = SdkDecoder::default();
        let mut done = false;
        loop {
            let (events, ended) = match response.chunk().await {
                Ok(Some(bytes)) => (decoder.push(&bytes), false),
                Ok(None) => (decoder.finish(), true),
                Err(_) => return Err(Failure::upstream("terminated")),
            };
            for event in events {
                if done {
                    continue;
                }
                if event.data.starts_with("[DONE]") {
                    done = true;
                    continue;
                }
                let mut pending = Vec::new();
                self.event(&event, &mut pending)?;
                self.flush(pending, emit)?;
            }
            if ended {
                break;
            }
        }
        self.finish(emit)
    }

    fn event(&mut self, event: &Event, pending: &mut Vec<Pending>) -> Result<(), Failure> {
        let parsed: Value = serde_json::from_str(&event.data)
            .map_err(|_| Failure::upstream("JSON Parse error: Unable to parse JSON string"))?;
        let thread = event
            .event
            .as_deref()
            .is_some_and(|name| name.starts_with("thread."));
        if thread {
            let chunk = json!({ "event": event.event, "data": parsed });
            return self.chunk(&chunk, pending);
        }
        let error = get(Some(&parsed), "error");
        if truthy(error) {
            let message = api_error_message(None, error, None);
            return Err(Failure::Upstream(with_raw_metadata(message, error)));
        }
        self.chunk(&parsed, pending)
    }

    fn ensure_text(&mut self, pending: &mut Vec<Pending>) -> usize {
        if let Some(index) = self.text_block {
            return index;
        }
        let index = self.push_block(AssistantContent::Text {
            text: String::new(),
            text_signature: None,
        });
        self.text_block = Some(index);
        pending.push(Pending::TextStart(index));
        index
    }

    fn ensure_thinking(&mut self, signature: &str, pending: &mut Vec<Pending>) -> usize {
        if let Some(index) = self.thinking_block {
            return index;
        }
        let index = self.push_block(AssistantContent::Thinking {
            thinking: String::new(),
            signature: Some(signature.to_owned()),
            redacted: None,
        });
        self.thinking_block = Some(index);
        pending.push(Pending::ThinkingStart(index));
        index
    }

    fn push_block(&mut self, block: AssistantContent) -> usize {
        self.out.content.push(block);
        self.scratch.push(None);
        self.out.content.len() - 1
    }

    fn chunk(&mut self, chunk: &Value, pending: &mut Vec<Pending>) -> Result<(), Failure> {
        if !matches!(chunk, Value::Object(_) | Value::Array(_)) {
            return Ok(());
        }
        let chunk = Some(chunk);
        if self.out.response_id.as_deref().is_none_or(str::is_empty) {
            self.out.response_id = present(get(chunk, "id")).map(js::to_js_string);
        }
        if let Some(model) = non_empty_str(get(chunk, "model"))
            && model != self.model.id
            && self.out.response_model.as_deref().is_none_or(str::is_empty)
        {
            self.out.response_model = Some(model.to_owned());
        }
        let usage = get(chunk, "usage");
        if truthy(usage) {
            self.out.usage = parse_usage(usage);
        }
        let choice = get(chunk, "choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first());
        if !truthy(choice) {
            return Ok(());
        }
        if !truthy(usage) && truthy(get(choice, "usage")) {
            self.out.usage = parse_usage(get(choice, "usage"));
        }
        let finish = get(choice, "finish_reason");
        if let Some(reason) = finish.filter(|reason| truthy(Some(reason))) {
            let (stop_reason, error) = map_stop_reason(reason);
            self.out.stop_reason = stop_reason;
            if let Some(error) = error {
                self.pi_error = Some(error);
            }
        }
        let delta = get(choice, "delta");
        if !truthy(delta) {
            return Ok(());
        }
        if let Some(content) = non_empty_str(get(delta, "content")) {
            let index = self.ensure_text(pending);
            if let AssistantContent::Text { text, .. } = &mut self.out.content[index] {
                text.push_str(content);
            }
            pending.push(Pending::TextDelta(index, content.to_owned()));
        }
        let reasoning = ["reasoning_content", "reasoning", "reasoning_text"]
            .into_iter()
            .find_map(|field| non_empty_str(get(delta, field)).map(|text| (field, text)));
        if let Some((field, text)) = reasoning {
            let index = self.ensure_thinking(field, pending);
            if let AssistantContent::Thinking { thinking, .. } = &mut self.out.content[index] {
                thinking.push_str(text);
            }
            pending.push(Pending::ThinkingDelta(index, text.to_owned()));
        }
        let tool_calls = get(delta, "tool_calls");
        if truthy(tool_calls) {
            let Some(calls) = tool_calls.and_then(Value::as_array) else {
                return Err(Failure::upstream("tool_calls is not iterable"));
            };
            for call in calls {
                if call.is_null() {
                    return Err(Failure::upstream("TypeError: null is not an object"));
                }
                self.tool_call(call, pending);
            }
        }
        if let Some(details) = get(delta, "reasoning_details").and_then(Value::as_array) {
            for detail in details {
                let detail_ref = Some(detail);
                if get(detail_ref, "type").and_then(Value::as_str) != Some("reasoning.encrypted")
                    || !truthy(get(detail_ref, "id"))
                    || !truthy(get(detail_ref, "data"))
                {
                    continue;
                }
                let Some(id) = get(detail_ref, "id").and_then(Value::as_str) else {
                    continue;
                };
                let signature = detail.to_string();
                if let Some(AssistantContent::ToolCall {
                    thought_signature, ..
                }) = self.out.content.iter_mut().find(|part| {
                    matches!(part, AssistantContent::ToolCall { id: call_id, .. } if call_id == id)
                }) {
                    *thought_signature = Some(signature);
                }
            }
        }
        Ok(())
    }

    fn tool_call(&mut self, call: &Value, pending: &mut Vec<Pending>) {
        let call = Some(call);
        let stream_index = js::number(get(call, "index"));
        let id = get(call, "id")
            .filter(|id| truthy(Some(id)))
            .map(js::to_js_string);
        let function = get(call, "function");
        let mut index = stream_index.and_then(|wanted| {
            self.by_index
                .iter()
                .find(|(key, _)| *key == wanted)
                .map(|(_, index)| *index)
        });
        if index.is_none()
            && let Some(id) = &id
        {
            index = self.by_id.get(id).copied();
        }
        let index = match index {
            Some(index) => index,
            None => {
                let name = get(function, "name")
                    .filter(|name| truthy(Some(name)))
                    .map(js::to_js_string)
                    .unwrap_or_default();
                let index = self.push_block(AssistantContent::ToolCall {
                    id: id.clone().unwrap_or_default(),
                    name,
                    arguments: Map::new(),
                    thought_signature: None,
                });
                self.scratch[index] = Some(ToolScratch {
                    partial_args: String::new(),
                    stream_index,
                    arguments: Value::Object(Map::new()),
                });
                if let Some(stream_index) = stream_index {
                    set_index(&mut self.by_index, stream_index, index);
                }
                if let Some(id) = &id {
                    self.by_id.insert(id.clone(), index);
                }
                pending.push(Pending::ToolStart(index));
                index
            }
        };
        let scratch = self.scratch[index].get_or_insert_with(ToolScratch::default);
        if let Some(stream_index) = stream_index
            && scratch.stream_index.is_none()
        {
            scratch.stream_index = Some(stream_index);
            set_index(&mut self.by_index, stream_index, index);
        }
        if let Some(id) = &id {
            self.by_id.insert(id.clone(), index);
        }
        let arguments_delta = get(function, "arguments")
            .filter(|args| truthy(Some(args)))
            .map(js::to_js_string);
        if let Some(arguments_delta) = &arguments_delta {
            scratch.partial_args.push_str(arguments_delta);
            scratch.arguments = parse_streaming_json(&scratch.partial_args);
        }
        let parsed = wire_arguments(&scratch.arguments);
        if let AssistantContent::ToolCall {
            id: block_id,
            name,
            arguments,
            ..
        } = &mut self.out.content[index]
        {
            if block_id.is_empty()
                && let Some(id) = &id
            {
                *block_id = id.clone();
            }
            if name.is_empty()
                && let Some(new_name) = get(function, "name").filter(|n| truthy(Some(n)))
            {
                *name = js::to_js_string(new_name);
            }
            *arguments = parsed;
        }
        pending.push(Pending::ToolDelta(
            index,
            arguments_delta.unwrap_or_default(),
        ));
    }

    fn flush(&mut self, pending: Vec<Pending>, emit: &mut Emitter<'_>) -> Result<(), Failure> {
        for event in pending {
            let delta = match event {
                Pending::TextStart(index) => AssistantDelta::TextStart {
                    content_index: content_index(index),
                },
                Pending::TextDelta(index, delta) => AssistantDelta::TextDelta {
                    content_index: content_index(index),
                    delta,
                },
                Pending::ThinkingStart(index) => AssistantDelta::ThinkingStart {
                    content_index: content_index(index),
                },
                Pending::ThinkingDelta(index, delta) => AssistantDelta::ThinkingDelta {
                    content_index: content_index(index),
                    delta,
                },
                Pending::ToolStart(index) => {
                    let (id, tool_name) = match &self.out.content[index] {
                        AssistantContent::ToolCall { id, name, .. } => (id.clone(), name.clone()),
                        _ => return Err(Failure::upstream("Invalid tool call event")),
                    };
                    AssistantDelta::ToolcallStart {
                        content_index: content_index(index),
                        id,
                        tool_name,
                    }
                }
                Pending::ToolDelta(index, delta) => AssistantDelta::ToolcallDelta {
                    content_index: content_index(index),
                    delta,
                },
            };
            emit.emit(delta, &self.out)
                .map_err(|Cancelled| Failure::Cancelled)?;
        }
        Ok(())
    }

    /// Close every block in order, then end as Pi does.
    fn finish(&mut self, emit: &mut Emitter<'_>) -> Result<AssistantMessage, Failure> {
        let mut ends = Vec::with_capacity(self.out.content.len());
        for index in 0..self.out.content.len() {
            let content_index = content_index(index);
            if let Some(scratch) = self.scratch[index].as_mut() {
                scratch.arguments = parse_streaming_json(&scratch.partial_args);
                let parsed = wire_arguments(&scratch.arguments);
                if let AssistantContent::ToolCall { arguments, .. } = &mut self.out.content[index] {
                    *arguments = parsed;
                }
            }
            ends.push(match &self.out.content[index] {
                AssistantContent::Text { text, .. } => AssistantDelta::TextEnd {
                    content_index,
                    content: text.clone(),
                },
                AssistantContent::Thinking { thinking, .. } => AssistantDelta::ThinkingEnd {
                    content_index,
                    content: thinking.clone(),
                },
                call @ AssistantContent::ToolCall { .. } => AssistantDelta::ToolcallEnd {
                    content_index,
                    tool_call: call.clone(),
                },
            });
        }
        for end in ends {
            emit.emit(end, &self.out)
                .map_err(|Cancelled| Failure::Cancelled)?;
        }
        if self.out.stop_reason == StopReason::Error {
            let upstream = self
                .pi_error
                .clone()
                .filter(|error| !error.is_empty())
                .unwrap_or_else(|| "Provider returned an error stop reason".to_owned());
            return Err(Failure::Upstream(upstream));
        }
        Ok(self.out.clone())
    }
}

/// `Map.set` on the stream-index map.
fn set_index(map: &mut Vec<(f64, usize)>, key: f64, index: usize) {
    match map.iter_mut().find(|(existing, _)| *existing == key) {
        Some(entry) => entry.1 = index,
        None => map.push((key, index)),
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

/// `parseChunkUsage`, then the adapter's `usageOf` total.
fn parse_usage(raw: Option<&Value>) -> pirc_protocol::Usage {
    let number_or_zero = |value: Option<&Value>| {
        if truthy(value) {
            js::number(value).unwrap_or(0.0)
        } else {
            0.0
        }
    };
    let details = get(raw, "prompt_tokens_details");
    let prompt = number_or_zero(get(raw, "prompt_tokens"));
    let reported = present(get(details, "cached_tokens"))
        .or_else(|| present(get(raw, "prompt_cache_hit_tokens")))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let cache_write = number_or_zero(get(details, "cache_write_tokens"));
    let cache_read = if cache_write > 0.0 {
        (reported - cache_write).max(0.0)
    } else {
        reported
    };
    let input = (prompt - cache_read - cache_write).max(0.0);
    let output = number_or_zero(get(raw, "completion_tokens"));
    let mut usage = empty_usage();
    usage.input = js::to_u64(input);
    usage.output = js::to_u64(output);
    usage.cache_read = js::to_u64(cache_read);
    usage.cache_write = js::to_u64(cache_write);
    usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
    usage
}

fn map_stop_reason(reason: &Value) -> (StopReason, Option<String>) {
    match reason.as_str() {
        Some("stop" | "end") => (StopReason::Stop, None),
        Some("length") => (StopReason::Length, None),
        Some("function_call" | "tool_calls") => (StopReason::ToolUse, None),
        _ => (
            StopReason::Error,
            Some(format!(
                "Provider finish_reason: {}",
                js::to_js_string(reason)
            )),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_error_messages_match_the_sdk() {
        assert_eq!(http_error(500, "boom"), "500 boom");
        assert_eq!(http_error(429, ""), "429 status code (no body)");
        assert_eq!(
            http_error(
                400,
                r#"{"error":{"message":"bad","metadata":{"raw":"why"}}}"#
            ),
            "400 bad\nwhy"
        );
        assert_eq!(
            http_error(400, r#"{"detail":"x"}"#),
            "400 status code (no body)"
        );
        assert_eq!(http_error(400, r#"{"error":"x"}"#), "400 \"x\"");
        assert_eq!(http_error(400, "null"), "400 null");
        assert_eq!(
            api_error_message(None, Some(&json!({ "code": 1 })), None),
            r#"{"code":1}"#
        );
    }

    #[test]
    fn usage_buckets_do_not_overlap() {
        let usage = parse_usage(Some(&json!({ "prompt_tokens": 50, "completion_tokens": 7,
            "prompt_tokens_details": { "cached_tokens": 20, "cache_write_tokens": 5 } })));
        assert_eq!(
            (
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write,
                usage.total_tokens
            ),
            (30, 7, 15, 5, 57)
        );
        let usage = parse_usage(Some(
            &json!({ "prompt_tokens": 10, "prompt_cache_hit_tokens": 4 }),
        ));
        assert_eq!((usage.input, usage.cache_read), (6, 4));
    }

    #[test]
    fn maps_stop_reasons() {
        assert_eq!(map_stop_reason(&json!("end")).0, StopReason::Stop);
        assert_eq!(
            map_stop_reason(&json!("weird")),
            (
                StopReason::Error,
                Some("Provider finish_reason: weird".to_owned())
            )
        );
    }
}
