//! The HTTP request of pi-ai's `streamAnthropic`: `createClient` (auth
//! branches, betas, default headers), `buildParams` and `convertMessages`,
//! and what `@anthropic-ai/sdk` 0.91.1 adds (`buildHeaders`, `buildURL`).

use indexmap::IndexMap;
use pirc_llm_types::{AssistantContent, ToolChoice, ToolSpec, UserBlock, UserContent};
use serde_json::{Map, Value, json};

use crate::http::Headers;
use crate::js::{self, present, truthy};
use crate::pi::{PiMessage, PiModel, has_images, transform_messages};
use crate::sdk::cloudflare_base_url;

const SDK_USER_AGENT: &str = "Anthropic/JS 0.91.1";
const CLAUDE_CODE_VERSION: &str = "2.1.75";
const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
const FINE_GRAINED_TOOL_STREAMING_BETA: &str = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";

/// Claude Code 2.x tool names (canonical casing).
const CLAUDE_CODE_TOOLS: [&str; 17] = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];

/// `toClaudeCodeName`: Claude Code's casing for its own tool names.
pub fn to_claude_code_name(name: &str) -> String {
    let lower = name.to_lowercase();
    CLAUDE_CODE_TOOLS
        .iter()
        .find(|tool| tool.to_lowercase() == lower)
        .map_or_else(|| name.to_owned(), |tool| (*tool).to_owned())
}

/// `fromClaudeCodeName`: back to the caller's tool of that name, if any.
pub fn from_claude_code_name(name: &str, tools: &[ToolSpec]) -> String {
    let lower = name.to_lowercase();
    tools
        .iter()
        .find(|tool| tool.name.to_lowercase() == lower)
        .map_or_else(|| name.to_owned(), |tool| tool.name.clone())
}

/// `supportsAdaptiveThinking`: Opus 4.6+ and Sonnet 4.6.
pub fn supports_adaptive_thinking(model_id: &str) -> bool {
    [
        "opus-4-6",
        "opus-4.6",
        "opus-4-7",
        "opus-4.7",
        "sonnet-4-6",
        "sonnet-4.6",
    ]
    .iter()
    .any(|part| model_id.contains(part))
}

/// `getAnthropicCompat`: unset (or `null`) means supported.
fn compat_flag(model: &PiModel, key: &str) -> bool {
    present(model.compat.get(key)).is_none_or(|value| truthy(Some(value)))
}

/// What the adapter's `streamOptions` passes for this API.
pub struct Options {
    pub api_key: String,
    pub max_tokens: u64,
    /// The model's own `maxTokens`, the fallback when `max_tokens` is 0.
    pub model_max_tokens: u64,
    pub thinking_enabled: bool,
    pub effort: Option<String>,
    pub thinking_budget_tokens: u64,
    pub tool_choice: Option<ToolChoice>,
    /// `opencodeGoHeaders`.
    pub headers: Vec<(&'static str, String)>,
    /// `PI_CACHE_RETENTION=long`.
    pub long_cache_retention: bool,
}

/// The prepared HTTP request.
pub struct HttpRequest {
    pub url: String,
    pub headers: Headers,
    pub body: Map<String, Value>,
    /// Bearer auth with Claude Code's identity: tool names are mapped.
    pub is_oauth: bool,
}

/// `buildCopilotDynamicHeaders` over the adapter's context messages.
fn copilot_headers(context: &[PiMessage]) -> Vec<(&'static str, String)> {
    let initiator = match context.last() {
        Some(PiMessage::User(_)) | None => "user",
        Some(_) => "agent",
    };
    let mut headers = vec![
        ("X-Initiator", initiator.to_owned()),
        ("Openai-Intent", "conversation-edits".to_owned()),
    ];
    let vision = context.iter().any(|message| match message {
        PiMessage::User(UserContent::Blocks(blocks)) => has_images(blocks),
        PiMessage::ToolResult { content, .. } => has_images(content),
        _ => false,
    });
    if vision {
        headers.push(("Copilot-Vision-Request", "true".to_owned()));
    }
    headers
}

/// `createClient` and the SDK's request building.
pub fn prepare(
    model: &PiModel,
    system_prompt: &str,
    context: &[PiMessage],
    tools: &[ToolSpec],
    options: &Options,
    resolve_variable: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<HttpRequest, String> {
    let mut betas = Vec::new();
    if !tools.is_empty() && !compat_flag(model, "supportsEagerToolInputStreaming") {
        betas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
    }
    if !supports_adaptive_thinking(&model.id) {
        betas.push(INTERLEAVED_THINKING_BETA);
    }
    let key = options.api_key.as_str();
    // pi-ai merges plain objects: keys of the same spelling replace in place.
    let mut defaults: IndexMap<String, Option<String>> = IndexMap::new();
    let mut set = |name: &str, value: Option<String>| {
        defaults.insert(name.to_owned(), value);
    };
    set("accept", Some("application/json".to_owned()));
    set(
        "anthropic-dangerous-direct-browser-access",
        Some("true".to_owned()),
    );
    // The SDK's `apiKey` (X-Api-Key) and `authToken` (Bearer).
    let (mut api_key, mut auth_token) = (None, None);
    let mut is_oauth = false;
    let mut dynamic = Vec::new();
    let base_url = if model.provider == "cloudflare-ai-gateway" {
        set("cf-aig-authorization", Some(format!("Bearer {key}")));
        set("x-api-key", None);
        set("Authorization", None);
        if !betas.is_empty() {
            set("anthropic-beta", Some(betas.join(",")));
        }
        cloudflare_base_url(model, resolve_variable)?
    } else {
        if model.provider == "github-copilot" {
            auth_token = Some(key);
            dynamic = copilot_headers(context);
            if !betas.is_empty() {
                set("anthropic-beta", Some(betas.join(",")));
            }
        } else if key.contains("sk-ant-oat") {
            auth_token = Some(key);
            is_oauth = true;
            let mut all = vec!["claude-code-20250219", "oauth-2025-04-20"];
            all.extend(&betas);
            set("anthropic-beta", Some(all.join(",")));
            set(
                "user-agent",
                Some(format!("claude-cli/{CLAUDE_CODE_VERSION}")),
            );
            set("x-app", Some("cli".to_owned()));
        } else {
            api_key = Some(key);
            if !betas.is_empty() {
                set("anthropic-beta", Some(betas.join(",")));
            }
        }
        model.base_url.clone()
    };
    for (name, value) in &model.headers {
        defaults.insert(name.clone(), Some(value.clone()));
    }
    for (name, value) in dynamic.into_iter().chain(options.headers.iter().cloned()) {
        defaults.insert(name.to_owned(), Some(value));
    }

    let mut headers = Headers::default();
    headers.set("Accept", "application/json");
    headers.set("User-Agent", SDK_USER_AGENT);
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    headers.set("anthropic-version", "2023-06-01");
    if let Some(key) = api_key {
        headers.set("X-Api-Key", key);
    }
    if let Some(token) = auth_token {
        headers.set("Authorization", &format!("Bearer {token}"));
    }
    for (name, value) in &defaults {
        match value {
            Some(value) => headers.set(name, value),
            None => headers.remove(name),
        }
    }
    headers.set("content-type", "application/json");

    let base_url = if base_url.is_empty() {
        "https://api.anthropic.com".to_owned()
    } else {
        base_url
    };
    let path = if base_url.ends_with('/') {
        "v1/messages"
    } else {
        "/v1/messages"
    };
    Ok(HttpRequest {
        url: format!("{base_url}{path}"),
        headers,
        body: build_params(model, system_prompt, context, tools, is_oauth, options),
        is_oauth,
    })
}

/// `buildParams` (the adapter's `onPayload` re-sets the same `tool_choice`).
fn build_params(
    model: &PiModel,
    system_prompt: &str,
    context: &[PiMessage],
    tools: &[ToolSpec],
    is_oauth: bool,
    options: &Options,
) -> Map<String, Value> {
    let cache_control =
        if options.long_cache_retention && compat_flag(model, "supportsLongCacheRetention") {
            json!({ "type": "ephemeral", "ttl": "1h" })
        } else {
            json!({ "type": "ephemeral" })
        };
    let max_tokens = if options.max_tokens > 0 {
        options.max_tokens
    } else {
        options.model_max_tokens / 3
    };
    let mut params = Map::new();
    params.insert("model".to_owned(), json!(model.id));
    params.insert(
        "messages".to_owned(),
        Value::Array(convert_messages(context, model, is_oauth, &cache_control)),
    );
    params.insert("max_tokens".to_owned(), json!(max_tokens));
    params.insert("stream".to_owned(), json!(true));
    let text = |text: &str| json!({ "type": "text", "text": text, "cache_control": cache_control });
    if is_oauth {
        let mut system = vec![text(CLAUDE_CODE_IDENTITY)];
        if !system_prompt.is_empty() {
            system.push(text(system_prompt));
        }
        params.insert("system".to_owned(), Value::Array(system));
    } else if !system_prompt.is_empty() {
        params.insert("system".to_owned(), json!([text(system_prompt)]));
    }
    if !tools.is_empty() {
        let eager = compat_flag(model, "supportsEagerToolInputStreaming");
        params.insert(
            "tools".to_owned(),
            Value::Array(convert_tools(tools, is_oauth, eager, &cache_control)),
        );
    }
    if model.reasoning {
        if options.thinking_enabled {
            if supports_adaptive_thinking(&model.id) {
                params.insert(
                    "thinking".to_owned(),
                    json!({ "type": "adaptive", "display": "summarized" }),
                );
                if let Some(effort) = options.effort.as_deref().filter(|e| !e.is_empty()) {
                    params.insert("output_config".to_owned(), json!({ "effort": effort }));
                }
            } else {
                let budget = if options.thinking_budget_tokens > 0 {
                    options.thinking_budget_tokens
                } else {
                    1024
                };
                params.insert(
                    "thinking".to_owned(),
                    json!({ "type": "enabled", "budget_tokens": budget, "display": "summarized" }),
                );
            }
        } else {
            params.insert("thinking".to_owned(), json!({ "type": "disabled" }));
        }
    }
    if let Some(choice) = options.tool_choice {
        let kind = match choice {
            ToolChoice::Auto => "auto",
            ToolChoice::None => "none",
        };
        params.insert("tool_choice".to_owned(), json!({ "type": kind }));
    }
    params
}

/// `normalizeToolCallId`: `[^a-zA-Z0-9_-]` becomes `_` per UTF-16 unit,
/// then at most 64 units.
fn normalize_tool_call_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out.truncate(64);
    out
}

fn image(mime_type: &str, data: &str) -> Value {
    json!({ "type": "image", "source": { "type": "base64", "media_type": mime_type, "data": data } })
}

/// `convertContentBlocks` of a tool result.
fn convert_content_blocks(content: &[UserBlock]) -> Value {
    if !has_images(content) {
        let texts: Vec<&str> = content
            .iter()
            .filter_map(|block| match block {
                UserBlock::Text { text, .. } => Some(text.as_str()),
                UserBlock::Image { .. } => None,
            })
            .collect();
        return json!(texts.join("\n"));
    }
    let mut blocks: Vec<Value> = content
        .iter()
        .map(|block| match block {
            UserBlock::Text { text, .. } => json!({ "type": "text", "text": text }),
            UserBlock::Image { data, mime_type } => image(mime_type, data),
        })
        .collect();
    if !content
        .iter()
        .any(|block| matches!(block, UserBlock::Text { .. }))
    {
        blocks.insert(0, json!({ "type": "text", "text": "(see attached image)" }));
    }
    Value::Array(blocks)
}

fn tool_result(tool_call_id: &str, content: &[UserBlock], is_error: bool) -> Value {
    json!({
        "type": "tool_result",
        "tool_use_id": tool_call_id,
        "content": convert_content_blocks(content),
        "is_error": is_error,
    })
}

/// `convertMessages`, with cache control on the last user message.
fn convert_messages(
    messages: &[PiMessage],
    model: &PiModel,
    is_oauth: bool,
    cache_control: &Value,
) -> Vec<Value> {
    let transformed = transform_messages(messages.to_vec(), model, &|id, _, _| {
        normalize_tool_call_id(id)
    });
    let mut params: Vec<Value> = Vec::new();
    let mut index = 0;
    while index < transformed.len() {
        match &transformed[index] {
            PiMessage::User(UserContent::Text(text)) => {
                if !js::trim(text).is_empty() {
                    params.push(json!({ "role": "user", "content": text }));
                }
            }
            PiMessage::User(UserContent::Blocks(blocks)) => {
                let content: Vec<Value> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        UserBlock::Text { text, .. } => (!js::trim(text).is_empty())
                            .then(|| json!({ "type": "text", "text": text })),
                        UserBlock::Image { data, mime_type } => Some(image(mime_type, data)),
                    })
                    .collect();
                if !content.is_empty() {
                    params.push(json!({ "role": "user", "content": content }));
                }
            }
            PiMessage::Assistant { content, .. } => {
                let blocks = convert_assistant(content, is_oauth);
                if !blocks.is_empty() {
                    params.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            PiMessage::ToolResult { .. } => {
                let mut results = Vec::new();
                while let Some(PiMessage::ToolResult {
                    tool_call_id,
                    content,
                    is_error,
                    ..
                }) = transformed.get(index)
                {
                    results.push(tool_result(tool_call_id, content, *is_error));
                    index += 1;
                }
                index -= 1;
                params.push(json!({ "role": "user", "content": results }));
            }
        }
        index += 1;
    }
    if let Some(last) = params.last_mut()
        && last["role"] == "user"
    {
        match &mut last["content"] {
            Value::Array(blocks) => {
                if let Some(Value::Object(block)) = blocks.last_mut()
                    && matches!(
                        block.get("type").and_then(Value::as_str),
                        Some("text" | "image" | "tool_result")
                    )
                {
                    block.insert("cache_control".to_owned(), cache_control.clone());
                }
            }
            content @ Value::String(_) => {
                let text = std::mem::take(content);
                *content =
                    json!([{ "type": "text", "text": text, "cache_control": cache_control }]);
            }
            _ => {}
        }
    }
    params
}

fn convert_assistant(content: &[AssistantContent], is_oauth: bool) -> Vec<Value> {
    let mut blocks = Vec::new();
    for block in content {
        match block {
            AssistantContent::Text { text, .. } => {
                if !js::trim(text).is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
            }
            AssistantContent::Thinking {
                thinking,
                signature,
                redacted,
            } => {
                if *redacted == Some(true) {
                    let mut redacted = Map::new();
                    redacted.insert("type".to_owned(), json!("redacted_thinking"));
                    if let Some(signature) = signature {
                        redacted.insert("data".to_owned(), json!(signature));
                    }
                    blocks.push(Value::Object(redacted));
                    continue;
                }
                if js::trim(thinking).is_empty() {
                    continue;
                }
                match signature.as_deref() {
                    Some(signature) if !js::trim(signature).is_empty() => blocks.push(json!({
                        "type": "thinking",
                        "thinking": thinking,
                        "signature": signature,
                    })),
                    _ => blocks.push(json!({ "type": "text", "text": thinking })),
                }
            }
            AssistantContent::ToolCall {
                id,
                name,
                arguments,
                ..
            } => {
                let name = if is_oauth {
                    to_claude_code_name(name)
                } else {
                    name.clone()
                };
                blocks.push(
                    json!({ "type": "tool_use", "id": id, "name": name, "input": arguments }),
                );
            }
        }
    }
    blocks
}

fn convert_tools(
    tools: &[ToolSpec],
    is_oauth: bool,
    eager: bool,
    cache_control: &Value,
) -> Vec<Value> {
    tools
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let mut out = Map::new();
            let name = if is_oauth {
                to_claude_code_name(&tool.name)
            } else {
                tool.name.clone()
            };
            out.insert("name".to_owned(), json!(name));
            out.insert("description".to_owned(), json!(tool.description));
            if eager {
                out.insert("eager_input_streaming".to_owned(), json!(true));
            }
            let schema = &tool.parameters;
            out.insert(
                "input_schema".to_owned(),
                json!({
                    "type": "object",
                    "properties": present(schema.get("properties")).cloned().unwrap_or_else(|| json!({})),
                    "required": present(schema.get("required")).cloned().unwrap_or_else(|| json!([])),
                }),
            );
            if index == tools.len() - 1 {
                out.insert("cache_control".to_owned(), cache_control.clone());
            }
            Value::Object(out)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tool_call_ids() {
        assert_eq!(normalize_tool_call_id("call_x+y|z"), "call_x_y_z");
        assert_eq!(normalize_tool_call_id("a\u{1F600}b"), "a__b");
        assert_eq!(normalize_tool_call_id(&"x".repeat(70)).len(), 64);
    }

    #[test]
    fn maps_claude_code_tool_names() {
        assert_eq!(to_claude_code_name("bash"), "Bash");
        assert_eq!(to_claude_code_name("TODOWRITE"), "TodoWrite");
        assert_eq!(to_claude_code_name("my_tool"), "my_tool");
        let tools = [ToolSpec {
            name: "read".to_owned(),
            description: String::new(),
            parameters: Map::new(),
        }];
        assert_eq!(from_claude_code_name("Read", &tools), "read");
        assert_eq!(from_claude_code_name("Grep", &tools), "Grep");
    }

    #[test]
    fn detects_adaptive_models() {
        assert!(supports_adaptive_thinking("claude-opus-4-6-20260101"));
        assert!(supports_adaptive_thinking("anthropic/claude-sonnet-4.6"));
        assert!(!supports_adaptive_thinking("claude-sonnet-4-5"));
    }
}
