//! Message types (`agent/messages.ts`): the wire types of `pirc-protocol`,
//! and the agent's token estimate.

pub mod js;

pub use pirc_protocol::{
    AssistantContent, AssistantDelta, AssistantMessage, Message, StopReason, Usage, UserBlock,
    UserContent,
};

/// Characters an image counts as.
const IMAGE_CHARS: usize = 4800;

/// `textOf(content)`: the text blocks joined.
pub fn text_of(content: &UserContent) -> String {
    match content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(blocks) => blocks_text(blocks),
    }
}

/// `textOf` of tool result blocks.
pub fn blocks_text(blocks: &[UserBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            UserBlock::Text { text, .. } => Some(text.as_str()),
            UserBlock::Image { .. } => None,
        })
        .collect()
}

fn blocks_chars(blocks: &[UserBlock]) -> usize {
    blocks
        .iter()
        .map(|block| match block {
            UserBlock::Text { text, .. } => js::utf16_len(text),
            UserBlock::Image { .. } => IMAGE_CHARS,
        })
        .sum()
}

/// `estimateTokens(message)`: characters / 4, images as 4800 characters.
pub fn estimate_tokens(message: &Message) -> u64 {
    let chars = match message {
        Message::User { content, .. } => match content {
            UserContent::Text(text) => js::utf16_len(text),
            UserContent::Blocks(blocks) => blocks_chars(blocks),
        },
        Message::Assistant(assistant) => assistant
            .content
            .iter()
            .map(|part| match part {
                AssistantContent::Text { text, .. } => js::utf16_len(text),
                AssistantContent::Thinking { thinking, .. } => js::utf16_len(thinking),
                AssistantContent::ToolCall {
                    name, arguments, ..
                } => {
                    js::utf16_len(name)
                        + js::utf16_len(&js::stringify(&serde_json::Value::Object(
                            arguments.clone(),
                        )))
                }
            })
            .sum(),
        Message::ToolResult { content, .. } => blocks_chars(content),
        Message::Custom { content, .. } => js::utf16_len(content),
        Message::CompactionSummary { summary, .. } => js::utf16_len(summary),
    };
    chars.div_ceil(4) as u64
}

/// `estimateTokens` of a plain text (a user message of it).
pub fn text_tokens(text: &str) -> u64 {
    js::utf16_len(text).div_ceil(4) as u64
}

/// `emptyUsage()`.
pub fn empty_usage() -> Usage {
    Usage {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(value: serde_json::Value) -> Message {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn estimates_characters_over_four() {
        let user = message(json!({"role": "user", "content": "abcde", "timestamp": 1}));
        assert_eq!(estimate_tokens(&user), 2);
        let blocks = message(json!({"role": "user", "content": [
            {"type": "text", "text": "abcd"},
            {"type": "image", "data": "x", "mimeType": "image/png"}
        ], "timestamp": 1}));
        assert_eq!(estimate_tokens(&blocks), 1201);
        // UTF-16 code units, as `string.length` counts them.
        let emoji = message(json!({"role": "user", "content": "😀😀😀", "timestamp": 1}));
        assert_eq!(estimate_tokens(&emoji), 2);
        let assistant = message(json!({
            "role": "assistant",
            "content": [
                {"type": "text", "text": "hi"},
                {"type": "thinking", "thinking": "hmm"},
                {"type": "toolCall", "id": "c", "name": "ptc", "arguments": {"n": 1.0}}
            ],
            "api": "a", "provider": "p", "model": "m",
            "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0},
            "stopReason": "toolUse", "timestamp": 1
        }));
        // 2 + 3 + 3 + len('{"n":1}') = 15
        assert_eq!(estimate_tokens(&assistant), 4);
        let result = message(json!({
            "role": "toolResult", "toolCallId": "c", "toolName": "t",
            "content": [{"type": "text", "text": "123456789"}], "isError": false, "timestamp": 1
        }));
        assert_eq!(estimate_tokens(&result), 3);
        let custom = message(json!({
            "role": "custom", "customType": "x", "content": "", "display": true, "timestamp": 1
        }));
        assert_eq!(estimate_tokens(&custom), 0);
        let summary = message(json!({
            "role": "compactionSummary", "summary": "x".repeat(400), "tokensBefore": 1, "timestamp": 1
        }));
        assert_eq!(estimate_tokens(&summary), 100);
    }
}
