use pirc_agent_loop::*;
use pirc_llm_types::*;
use serde_json::json;

pub fn answer(request: &ModelRequest) -> AssistantMessage {
    let has_result = request
        .messages
        .iter()
        .any(|m| matches!(m, Message::ToolResult { .. }));
    serde_json::from_value(json!({
        "content": if has_result { json!([{ "type": "text", "text": "finished" }]) }
            else { json!([{ "type": "toolCall", "id": "stable-id", "name": "fake", "arguments": {} }]) },
        "api": "fake", "provider": "fake", "model": "fake",
        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 },
        "stopReason": if has_result { "stop" } else { "toolUse" }, "timestamp": 0
    })).unwrap()
}

pub fn tool_result() -> ToolOutcome {
    ToolOutcome {
        status: ToolStatus::Completed,
        content: vec![UserBlock::Text {
            text: "fake output".into(),
            text_signature: None,
        }],
        details: None,
        timestamp: 0,
    }
}
