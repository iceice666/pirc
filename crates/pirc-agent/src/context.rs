//! The system prompt's sections and the context snapshot the side panel
//! shows (`agent/context.ts`), written to `<session>/context.json`.

use pirc_protocol::{Message, ToolSpec, Usage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `PromptSection`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PromptSection {
    pub id: String,
    pub title: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen: Option<bool>,
    pub text: String,
}

impl PromptSection {
    pub fn new(id: &str, title: &str, source: &str, text: impl Into<String>) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            source: source.to_owned(),
            frozen: None,
            text: text.into(),
        }
    }
}

/// `joinPrompt`: non-empty section texts joined by a blank line.
pub fn join_prompt(sections: &[PromptSection]) -> String {
    let _ = sections;
    todo!("M4 store: joinPrompt")
}

/// `trimSections`.
pub fn trim_sections(sections: &[PromptSection]) -> Vec<PromptSection> {
    let _ = sections;
    todo!("M4 store: trimSections")
}

/// `captureContext`'s input.
pub struct ContextInput<'a> {
    pub sections: &'a [PromptSection],
    pub tools: &'a [ToolSpec],
    pub messages: &'a [Message],
    pub provider: &'a str,
    pub model_id: &'a str,
    pub context_window: Option<u64>,
    pub memory_tokens: u64,
    /// `capabilities` (the registry's summaries).
    pub capabilities: Option<Value>,
}

/// `captureContext`: a `ContextSnapshot` (as JSON, as clients read it).
pub fn capture_context(input: ContextInput<'_>) -> Value {
    let _ = input;
    todo!("M4 store: captureContext")
}

/// `withReportedUsage`.
pub fn with_reported_usage(snapshot: &Value, usage: &Usage) -> Value {
    let _ = (snapshot, usage);
    todo!("M4 store: withReportedUsage")
}

/// `writeContext(dir, snapshot)`: atomically, as `context.json`.
pub fn write_context(dir: &std::path::Path, snapshot: &Value) -> Result<(), String> {
    let _ = (dir, snapshot);
    todo!("M4 store: writeContext")
}
