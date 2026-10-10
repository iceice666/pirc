//! pi-adapter's mapping shared by every pi-ai wire API (`modelFor`,
//! `historyMessage`, `streamOptions`' reasoning level) and pi-ai 0.73.1's
//! `transformMessages`, which each provider runs with its own tool call id
//! normalization.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use pirc_protocol::{
    AssistantContent, Message, ModelApi, StopReason, ThinkingLevel, UserBlock, UserContent,
};
use serde_json::{Map, Value};

use crate::js;
use crate::stream::StreamRequest;

/// Placeholder bearer for user-configured keyless endpoints.
pub const NO_KEY: &str = "pirc-no-api-key";

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

pub fn level_name(level: ThinkingLevel) -> &'static str {
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
    pub fn level_map(&self, level: &str) -> Option<Option<&str>> {
        self.thinking_level_map
            .as_ref()?
            .get(level)
            .map(Option::as_deref)
    }

    /// `model.thinkingLevelMap?.[effort] ?? effort`.
    pub fn mapped_effort(&self, effort: &str) -> String {
        self.level_map(effort)
            .flatten()
            .unwrap_or(effort)
            .to_owned()
    }

    pub fn has_image_input(&self) -> bool {
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
pub enum PiMessage {
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
        is_error: bool,
    },
}

pub fn history_message(message: &Message, provider_name: &str, model: &PiModel) -> PiMessage {
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
            is_error,
            ..
        } => PiMessage::ToolResult {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            content: content.clone(),
            is_error: *is_error,
        },
    }
}

pub fn has_images(blocks: &[UserBlock]) -> bool {
    blocks
        .iter()
        .any(|block| matches!(block, UserBlock::Image { .. }))
}

pub const USER_IMAGE_PLACEHOLDER: &str = "(image omitted: model does not support images)";
pub const TOOL_IMAGE_PLACEHOLDER: &str = "(tool image omitted: model does not support images)";

pub fn replace_images(content: &[UserBlock], placeholder: &str) -> Vec<UserBlock> {
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

/// The assistant message a tool call came from (`normalizeToolCallId`'s
/// `source`). Only the Responses APIs read it.
#[allow(dead_code)]
pub struct Source<'a> {
    pub api: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
}

/// `transformMessages`: image downgrade, cross-model thinking and tool call
/// ids (through the provider's `normalize`), dropped failed turns, synthetic
/// results for orphaned calls.
pub fn transform_messages(
    messages: Vec<PiMessage>,
    model: &PiModel,
    normalize: &dyn Fn(&str, &PiModel, &Source<'_>) -> String,
) -> Vec<PiMessage> {
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
                is_error,
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
                    is_error,
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
                                let source = Source {
                                    api: &api,
                                    provider: &provider,
                                    model: &model_id,
                                };
                                let normalized = normalize(&id, model, &source);
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
                    is_error: true,
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
