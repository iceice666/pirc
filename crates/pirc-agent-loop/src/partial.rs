//! The streaming reply so far, built from its deltas' block boundaries.

use pirc_llm_types::{AssistantContent, AssistantDelta, AssistantMessage};
use serde_json::Map;

/// A reply being streamed. Only block starts and ends change it: a start
/// appends an empty block, an end replaces the block with its whole
/// content (a tool call's arguments stream as unparsed JSON, so they stay
/// empty until its end), and content deltas are ignored. So the message
/// lags at most the block being streamed, and no delta is copied into it.
/// A boundary out of order (a start not at the end, an end of no block)
/// breaks the partial: it keeps what it had and ignores the rest.
#[derive(Clone, Debug, PartialEq)]
pub struct Partial {
    message: AssistantMessage,
    broken: bool,
}

impl Partial {
    /// Start from `skeleton` without its content.
    pub fn new(skeleton: AssistantMessage) -> Self {
        Self {
            message: AssistantMessage {
                content: Vec::new(),
                ..skeleton
            },
            broken: false,
        }
    }

    /// A snapshot the host built itself.
    pub fn snapshot(message: AssistantMessage) -> Self {
        Self {
            message,
            broken: false,
        }
    }

    pub fn message(&self) -> &AssistantMessage {
        &self.message
    }

    pub fn into_message(self) -> AssistantMessage {
        self.message
    }

    /// A boundary came out of order: no delta changes this partial any more.
    pub fn broken(&self) -> bool {
        self.broken
    }

    /// Apply `delta`: whether the message changed.
    pub fn apply(&mut self, delta: &AssistantDelta) -> bool {
        if self.broken {
            return false;
        }
        let (index, block) = match delta {
            AssistantDelta::TextStart { content_index } => (
                content_index,
                AssistantContent::Text {
                    text: String::new(),
                    text_signature: None,
                },
            ),
            AssistantDelta::TextEnd {
                content_index,
                content,
            } => (
                content_index,
                AssistantContent::Text {
                    text: content.clone(),
                    text_signature: None,
                },
            ),
            AssistantDelta::ThinkingStart { content_index } => (
                content_index,
                AssistantContent::Thinking {
                    thinking: String::new(),
                    signature: None,
                    redacted: None,
                },
            ),
            AssistantDelta::ThinkingEnd {
                content_index,
                content,
            } => (
                content_index,
                AssistantContent::Thinking {
                    thinking: content.clone(),
                    signature: None,
                    redacted: None,
                },
            ),
            AssistantDelta::ToolcallStart {
                content_index,
                id,
                tool_name,
            } => (
                content_index,
                AssistantContent::ToolCall {
                    id: id.clone(),
                    name: tool_name.clone(),
                    arguments: Map::new(),
                    thought_signature: None,
                },
            ),
            AssistantDelta::ToolcallEnd {
                content_index,
                tool_call,
            } => (content_index, tool_call.clone()),
            AssistantDelta::TextDelta { .. }
            | AssistantDelta::ThinkingDelta { .. }
            | AssistantDelta::ToolcallDelta { .. } => return false,
        };
        let index = *index as usize;
        let content = &mut self.message.content;
        let starts = matches!(
            delta,
            AssistantDelta::TextStart { .. }
                | AssistantDelta::ThinkingStart { .. }
                | AssistantDelta::ToolcallStart { .. }
        );
        if starts && index == content.len() {
            content.push(block);
        } else if !starts && index < content.len() {
            content[index] = block;
        } else {
            self.broken = true;
            return false;
        }
        true
    }
}
