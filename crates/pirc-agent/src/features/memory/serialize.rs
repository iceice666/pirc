//! Messages as the memory observer (and `recall`) reads them
//! (`features/memory/serialize.ts`).

use indexmap::IndexMap;
use pirc_protocol::{AssistantContent, Message, UserBlock, UserContent};
use serde_json::Value;

use super::ledger::{estimate_string_tokens, local_stamp, source_message};
use crate::session_store::SessionEntry;
use crate::tools::js;

/// `textOf(content)` of a user message or tool result.
pub fn user_text(content: &UserContent) -> String {
    match content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(blocks) => blocks_text(blocks),
    }
}

fn blocks_text(blocks: &[UserBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            UserBlock::Text { text, .. } => Some(text.as_str()),
            UserBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub use crate::ptc::started_capabilities;

/// `messageOrigin`: where a message came from, from its role (never from
/// the model): `user`, `assistant`, `tool:<name>` or `custom:<type>`.
pub fn message_origin(message: &Message) -> String {
    match message {
        Message::ToolResult { tool_name, .. } => format!("tool:{tool_name}"),
        Message::Custom { custom_type, .. } => format!("custom:{custom_type}"),
        Message::User { .. } => "user".to_owned(),
        Message::Assistant(_) => "assistant".to_owned(),
        Message::CompactionSummary { .. } => "compactionSummary".to_owned(),
    }
}

/// `RECALL_OMITTED`: what the observer sees instead of recall output:
/// recalled memory replays older evidence, and learning it again would let
/// memory reinforce itself.
pub const RECALL_OMITTED: &str = "[recalled memory omitted: not new evidence]";

const HEADERS: [&str; 6] = [
    "user",
    "assistant",
    "tool result",
    "custom",
    "skill loaded",
    "source entry id",
];

/// `neutralizeHeaders`: escape the block headers this file emits
/// (`[User @ …]:`, `[Source entry id: …]`, …) inside text that is not the
/// user's, so a tool result or a prompt-injected reply cannot forge a user
/// message the observer records as the human's words. JavaScript's
/// `/\[(?=\s*(?:User|…)\b)/gi`: ASCII case folding and word boundary.
pub fn neutralize_headers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (index, c) in text.char_indices() {
        if c == '[' && starts_header(&text[index + 1..]) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn starts_header(rest: &str) -> bool {
    let rest = rest.trim_start_matches(js::is_space);
    HEADERS.iter().any(|header| {
        rest.len() >= header.len()
            && rest.is_char_boundary(header.len())
            && rest[..header.len()].eq_ignore_ascii_case(header)
            && !rest[header.len()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// How a message is rendered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Observer,
    Recall,
}

/// `renderMessage`: one message for the observer (and recall); empty when
/// it shows nothing.
pub fn render_message(message: &Message, style: Style) -> String {
    let timestamp = match message {
        Message::User { timestamp, .. }
        | Message::ToolResult { timestamp, .. }
        | Message::Custom { timestamp, .. }
        | Message::CompactionSummary { timestamp, .. } => *timestamp,
        Message::Assistant(assistant) => assistant.timestamp,
    };
    let time = local_stamp(timestamp as f64);
    let at = if time.starts_with('?') && style == Style::Recall {
        "Unknown time".to_owned()
    } else {
        time
    };
    match message {
        Message::User { content, .. } => format!("[User @ {at}]: {}", user_text(content)),
        Message::Assistant(assistant) => {
            let joined = assistant
                .content
                .iter()
                .map(|part| match part {
                    AssistantContent::Text { text, .. } => neutralize_headers(text),
                    AssistantContent::Thinking {
                        thinking, redacted, ..
                    } => {
                        if *redacted == Some(true) {
                            String::new()
                        } else {
                            format!("[thinking: {}]", neutralize_headers(thinking))
                        }
                    }
                    AssistantContent::ToolCall {
                        name, arguments, ..
                    } => format!(
                        "[{name}({})]",
                        neutralize_headers(&js::stringify(&Value::Object(arguments.clone())))
                    ),
                })
                .collect::<Vec<_>>()
                .join("\n");
            let body = joined
                .split('\n')
                .filter(|line| !js::trim(line).is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if body.is_empty() {
                String::new()
            } else {
                format!("[Assistant @ {at}]: {body}")
            }
        }
        Message::ToolResult {
            tool_name, content, ..
        } => {
            let quoted = neutralize_headers(&blocks_text(content));
            match style {
                Style::Recall => format!("[Tool result: {tool_name} @ {at}]: {quoted}"),
                Style::Observer => {
                    let recalled = tool_name == "recall"
                        || started_capabilities(message)
                            .is_some_and(|names| names.iter().any(|name| name == "recall"));
                    format!(
                        "[Tool result for {tool_name} @ {at}]: {}",
                        if recalled { RECALL_OMITTED } else { &quoted }
                    )
                }
            }
        }
        Message::Custom {
            custom_type,
            content,
            details,
            ..
        } => {
            // Recaps are derived recommendations, not new evidence or approved preferences.
            if custom_type == "recap.report" && style == Style::Observer {
                return String::new();
            }
            // A loaded skill is installed instructions, not something the user said.
            if custom_type == "skill" && style == Style::Observer {
                let name = match details.as_ref().and_then(|details| details.get("name")) {
                    None | Some(Value::Null) => "unknown".to_owned(),
                    Some(name) => js::string_of(name),
                };
                return format!("[Skill loaded @ {at}: {}]", neutralize_headers(&name));
            }
            let quoted = neutralize_headers(content);
            match style {
                Style::Recall => format!("[Custom message ({custom_type}) @ {at}]: {quoted}"),
                Style::Observer => format!("[Custom ({custom_type}) @ {at}]: {quoted}"),
            }
        }
        Message::CompactionSummary { .. } => String::new(),
    }
}

const MIDDLE: &str = "\n\n[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]\n\n";

/// `Chunk`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Chunk {
    pub text: String,
    pub source_entry_ids: Vec<String>,
    /// `messageOrigin` of every source entry in the chunk, by entry id.
    pub origins: IndexMap<String, String>,
    pub estimated_tokens: u64,
}

/// `serializeChunk`: source entries oldest-first until `max_tokens`.
pub fn serialize_chunk(entries: &[SessionEntry], max_tokens: u64) -> Chunk {
    let mut blocks: Vec<String> = Vec::new();
    let mut chunk = Chunk::default();
    for entry in entries {
        let Some(message) = source_message(entry) else {
            continue;
        };
        let rendered = render_message(message, Style::Observer);
        if rendered.is_empty() {
            continue;
        }
        let block = format!("[Source entry id: {}]\n{rendered}", entry.id);
        let separator = if blocks.is_empty() { "" } else { "\n\n" };
        let cost = estimate_string_tokens(&format!("{separator}{block}"));
        if chunk.estimated_tokens + cost > max_tokens {
            if !blocks.is_empty() {
                break;
            }
            let max_chars = max_tokens as usize * 4;
            let half = max_chars.saturating_sub(js::len16(MIDDLE)) / 2;
            // `block.slice(-0)` is the whole block.
            let tail = if half == 0 {
                block.as_str()
            } else {
                js::tail16(&block, half)
            };
            let block = format!("{}{MIDDLE}{tail}", js::head16(&block, half));
            chunk.estimated_tokens = estimate_string_tokens(&block);
            blocks.push(block);
            chunk.source_entry_ids.push(entry.id.clone());
            chunk
                .origins
                .insert(entry.id.clone(), message_origin(message));
            break;
        }
        blocks.push(block);
        chunk.source_entry_ids.push(entry.id.clone());
        chunk
            .origins
            .insert(entry.id.clone(), message_origin(message));
        chunk.estimated_tokens += cost;
    }
    chunk.text = blocks.join("\n\n");
    chunk
}
