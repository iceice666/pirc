//! The live state a snapshot shows while an agent runs (`node/reducer.ts`).
//! Owner: **runner** ([`ReducedState::reduce`]); the types are the
//! layout's, read by core's snapshot route.
//!
//! History is not here: snapshots read it from the session file (the
//! branch cache). TS also pushed every `message_end` onto an unused
//! `history`; the port leaves it out.
//!
//! Where TS kept a value of an unexpected type as it came (a non-string
//! `text_end` content, a non-array queue), the typed fields here take its
//! `String(...)` or an empty list; the Rust agent never sends either.
//! Content indexes that are not non-negative integers are ignored (JS
//! would key them as strings).

use std::collections::BTreeMap;

use indexmap::IndexMap;
use pirc_agent::messages::js::{stringify, utf16_len, utf16_prefix};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::util::now_ms;

/// A ptc execution has at most 8 operations in flight; keep a margin, never
/// grow unbounded.
const MAX_RUNNING_OPERATIONS: usize = 32;
/// Arguments kept per running operation (a `write` may carry 1 MiB of
/// content), in UTF-16 units of their JSON.
const MAX_ARGS_CHARS: usize = 4096;
/// Widget lines kept: room for a header plus the todo list's 50 tasks.
const MAX_WIDGET_LINES: usize = 64;

/// `ReducedSessionState` without `history`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReducedState {
    /// The assistant message being streamed, if any.
    pub partial_message: Option<PartialMessage>,
    pub queue: Queue,
    /// `notify` requests with `receivedAt` (unbounded, as TS).
    pub notifications: Vec<Map<String, Value>>,
    /// Extension panels (`setWidget`), at most 64 lines each.
    pub widgets: IndexMap<String, Vec<String>>,
    /// Status-line entries (`setStatus`).
    pub statuses: IndexMap<String, String>,
    /// `ptc` operations started and not ended (at most 32).
    pub operations: Vec<RunningOperation>,
}

/// `{base, content}`: `content` by `contentIndex` (a JSON object with
/// numeric keys, in ascending order as JS lists them).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PartialMessage {
    /// `message_start`'s message (`null` when an update came first).
    pub base: Value,
    pub content: BTreeMap<u32, PartialContent>,
}

/// One block of a partial message (`PartialContent`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialContent {
    /// `text`, `thinking` or `toolCall`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<Value>,
}

impl PartialContent {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            text: None,
            id: None,
            tool_name: None,
            arguments: None,
            tool_call: None,
        }
    }

    fn text(kind: &str, text: String) -> Self {
        Self {
            text: Some(text),
            ..Self::new(kind)
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub steering: Vec<Value>,
    pub follow_up: Vec<Value>,
}

/// `RunningOperation`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningOperation {
    pub tool_call_id: String,
    pub parent_tool_call_id: String,
    pub tool_name: String,
    /// Bounded for display (`boundedArgs`).
    pub args: Value,
}

/// An agent-line field as text (`(missing)` when absent).
pub(crate) fn js_string(value: Option<&Value>) -> String {
    pirc_agent::tools::js::shown(value)
}

/// `value ?? fallback` as a string in a template literal.
fn nullish_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        value => js_string(value),
    }
}

/// `boundedArgs`: arguments for display; long strings are cut, and
/// anything larger than the bound is dropped.
fn bounded_args(args: Option<&Value>) -> Value {
    let cut = |value: &Value| match value {
        Value::String(text) if utf16_len(text) > 1000 => {
            Value::String(format!("{}…", utf16_prefix(text, 1000)))
        }
        value => value.clone(),
    };
    let shallow = match args {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(object)) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), cut(value)))
                .collect(),
        ),
        Some(value) => cut(value),
    };
    if utf16_len(&stringify(&shallow)) <= MAX_ARGS_CHARS {
        shallow
    } else {
        Value::Object(Map::new())
    }
}

impl ReducedState {
    /// `reducePiEvent(state, event)`.
    pub fn reduce(&mut self, event: &Map<String, Value>) {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let method = event.get("method").and_then(Value::as_str);
        match kind {
            "message_start" => {
                self.partial_message = Some(PartialMessage {
                    base: event.get("message").cloned().unwrap_or(Value::Null),
                    content: BTreeMap::new(),
                });
            }
            "message_update" => self.update(event),
            "message_end" => self.partial_message = None,
            "tool_execution_start" => {
                let (Some(Value::String(parent)), Some(Value::String(id))) =
                    (event.get("parentToolCallId"), event.get("toolCallId"))
                else {
                    return;
                };
                self.operations.retain(|item| &item.tool_call_id != id);
                self.operations.push(RunningOperation {
                    tool_call_id: id.clone(),
                    parent_tool_call_id: parent.clone(),
                    tool_name: match event.get("toolName") {
                        None | Some(Value::Null) => "tool".to_owned(),
                        name => js_string(name),
                    },
                    args: bounded_args(event.get("args")),
                });
                let excess = self.operations.len().saturating_sub(MAX_RUNNING_OPERATIONS);
                self.operations.drain(..excess);
            }
            "tool_execution_end" => {
                if event.get("parentToolCallId").is_some_and(Value::is_string) {
                    let id = event.get("toolCallId").and_then(Value::as_str);
                    self.operations
                        .retain(|item| Some(item.tool_call_id.as_str()) != id);
                }
            }
            "agent_end" | "agent_settled" => self.operations.clear(),
            "queue_update" => {
                let list = |name: &str| match event.get(name) {
                    Some(Value::Array(items)) => items.clone(),
                    _ => Vec::new(),
                };
                self.queue = Queue {
                    steering: list("steering"),
                    follow_up: list("followUp"),
                };
            }
            "extension_ui_request" if method == Some("notify") => {
                let mut notice = event.clone();
                notice.insert("receivedAt".to_owned(), Value::from(now_ms()));
                self.notifications.push(notice);
            }
            "extension_ui_request" if method == Some("setWidget") => {
                let key = nullish_string(event.get("widgetKey"));
                match event.get("widgetLines") {
                    Some(Value::Array(lines)) if !lines.is_empty() => {
                        let lines = lines
                            .iter()
                            .take(MAX_WIDGET_LINES)
                            .map(|line| js_string(Some(line)))
                            .collect();
                        self.widgets.insert(key, lines);
                    }
                    _ => {
                        self.widgets.shift_remove(&key);
                    }
                }
            }
            "extension_ui_request" if method == Some("setStatus") => {
                let key = nullish_string(event.get("statusKey"));
                match event.get("statusText") {
                    Some(Value::String(text)) if !text.is_empty() => {
                        self.statuses.insert(key, text.clone());
                    }
                    _ => {
                        self.statuses.shift_remove(&key);
                    }
                }
            }
            _ => {}
        }
    }

    fn update(&mut self, event: &Map<String, Value>) {
        let partial = self.partial_message.get_or_insert_with(|| PartialMessage {
            base: Value::Null,
            content: BTreeMap::new(),
        });
        let Some(Value::Object(delta)) = event.get("assistantMessageEvent") else {
            return;
        };
        let Some(index) = delta.get("contentIndex").and_then(Value::as_u64) else {
            return;
        };
        let Ok(index) = u32::try_from(index) else {
            return;
        };
        let existing = partial.content.get(&index);
        let existing_text = || {
            existing
                .and_then(|content| content.text.clone())
                .unwrap_or_default()
        };
        let appended = || format!("{}{}", existing_text(), nullish_string(delta.get("delta")));
        let ended = || match delta.get("content") {
            None | Some(Value::Null) => existing_text(),
            content => js_string(content),
        };
        let content = match delta.get("type").and_then(Value::as_str) {
            Some("text_start") => PartialContent::text("text", String::new()),
            Some("text_delta") => PartialContent::text("text", appended()),
            Some("text_end") => PartialContent::text("text", ended()),
            Some("thinking_start") => PartialContent::text("thinking", String::new()),
            Some("thinking_delta") => PartialContent::text("thinking", appended()),
            Some("thinking_end") => PartialContent::text("thinking", ended()),
            Some("toolcall_start") => PartialContent {
                id: delta.get("id").cloned(),
                tool_name: delta.get("toolName").cloned(),
                arguments: Some(String::new()),
                ..PartialContent::new("toolCall")
            },
            Some("toolcall_delta") => {
                let arguments = format!(
                    "{}{}",
                    existing
                        .and_then(|content| content.arguments.clone())
                        .unwrap_or_default(),
                    nullish_string(delta.get("delta"))
                );
                PartialContent {
                    kind: "toolCall".to_owned(),
                    arguments: Some(arguments),
                    ..existing
                        .cloned()
                        .unwrap_or_else(|| PartialContent::new("toolCall"))
                }
            }
            Some("toolcall_end") => PartialContent {
                kind: "toolCall".to_owned(),
                tool_call: delta.get("toolCall").cloned(),
                ..existing
                    .cloned()
                    .unwrap_or_else(|| PartialContent::new("toolCall"))
            },
            _ => return,
        };
        partial.content.insert(index, content);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn reduce(state: &mut ReducedState, event: Value) {
        let Value::Object(event) = event else {
            panic!("not an object")
        };
        state.reduce(&event);
    }

    // events-reducer.test.ts: "keeps running ptc operations (start, not
    // end) for snapshots, without results"
    #[test]
    fn keeps_running_ptc_operations() {
        let mut state = ReducedState::default();
        let op = |state: &mut ReducedState, kind: &str, id: &str, extra: Value| {
            let mut event = json!({ "type": kind, "toolCallId": id, "toolName": "edit",
                "parentToolCallId": "p" });
            if let Value::Object(extra) = extra {
                event.as_object_mut().unwrap().extend(extra);
            }
            reduce(state, event);
        };
        op(
            &mut state,
            "tool_execution_start",
            "p:op1",
            json!({ "args": { "path": "a" } }),
        );
        op(
            &mut state,
            "tool_execution_start",
            "p:op2",
            json!({ "args": { "path": "b" } }),
        );
        // A direct call (no parent) is not an operation.
        reduce(
            &mut state,
            json!({ "type": "tool_execution_start", "toolCallId": "p", "toolName": "ptc" }),
        );
        op(
            &mut state,
            "tool_execution_end",
            "p:op1",
            json!({ "result": { "content": [{ "type": "text", "text": "secret" }] } }),
        );
        assert_eq!(
            serde_json::to_value(&state.operations).unwrap(),
            json!([{ "toolCallId": "p:op2", "parentToolCallId": "p", "toolName": "edit",
                "args": { "path": "b" } }])
        );
        // Large arguments are cut for display.
        op(
            &mut state,
            "tool_execution_start",
            "big",
            json!({ "args": { "path": "a", "content": "x".repeat(5000) } }),
        );
        assert_eq!(
            state.operations.last().unwrap().args,
            json!({ "path": "a", "content": format!("{}…", "x".repeat(1000)) })
        );
        for index in 0..50 {
            op(
                &mut state,
                "tool_execution_start",
                &format!("x{index}"),
                Value::Null,
            );
        }
        assert_eq!(state.operations.len(), 32);
        assert_eq!(state.operations[0].tool_call_id, "x18");
        assert_eq!(state.operations[0].args, json!({}));
        reduce(&mut state, json!({ "type": "agent_end" }));
        assert!(state.operations.is_empty());
    }

    // "assembles deltas but trusts message_end"
    #[test]
    fn assembles_deltas_but_trusts_message_end() {
        let mut state = ReducedState::default();
        reduce(
            &mut state,
            json!({ "type": "message_start", "message": { "role": "assistant" } }),
        );
        reduce(
            &mut state,
            json!({ "type": "message_update", "assistantMessageEvent":
                { "type": "text_delta", "contentIndex": 0, "delta": "partial" } }),
        );
        assert_eq!(
            state.partial_message.as_ref().unwrap().content[&0]
                .text
                .as_deref(),
            Some("partial")
        );
        reduce(
            &mut state,
            json!({ "type": "message_end", "message": { "role": "assistant",
                "content": [{ "type": "text", "text": "final" }] } }),
        );
        assert!(state.partial_message.is_none());
    }

    #[test]
    fn partial_tool_calls_and_thinking() {
        let mut state = ReducedState::default();
        let update = |state: &mut ReducedState, delta: Value| {
            reduce(
                state,
                json!({ "type": "message_update", "assistantMessageEvent": delta }),
            );
        };
        // An update before message_start opens a message with a null base.
        update(
            &mut state,
            json!({ "type": "thinking_start", "contentIndex": 1 }),
        );
        update(
            &mut state,
            json!({ "type": "thinking_delta", "contentIndex": 1, "delta": "hm" }),
        );
        update(
            &mut state,
            json!({ "type": "toolcall_start", "contentIndex": 2, "id": "c", "toolName": "read" }),
        );
        update(
            &mut state,
            json!({ "type": "toolcall_delta", "contentIndex": 2, "delta": "{\"pa" }),
        );
        update(
            &mut state,
            json!({ "type": "toolcall_delta", "contentIndex": 2, "delta": "th\":1}" }),
        );
        update(
            &mut state,
            json!({ "type": "toolcall_end", "contentIndex": 2, "toolCall": { "id": "c" } }),
        );
        update(
            &mut state,
            json!({ "type": "text_end", "contentIndex": 0, "content": "t" }),
        );
        update(
            &mut state,
            json!({ "type": "text_delta", "delta": "ignored" }),
        );
        assert_eq!(
            serde_json::to_value(&state.partial_message).unwrap(),
            json!({ "base": null, "content": {
                "0": { "type": "text", "text": "t" },
                "1": { "type": "thinking", "text": "hm" },
                "2": { "type": "toolCall", "id": "c", "toolName": "read",
                    "arguments": "{\"path\":1}", "toolCall": { "id": "c" } } } })
        );
    }

    #[test]
    fn queue_notifications_widgets_and_statuses() {
        let mut state = ReducedState::default();
        reduce(
            &mut state,
            json!({ "type": "queue_update", "steering": ["a"], "followUp": null }),
        );
        assert_eq!(
            serde_json::to_value(&state.queue).unwrap(),
            json!({ "steering": ["a"], "followUp": [] })
        );
        reduce(
            &mut state,
            json!({ "type": "extension_ui_request", "id": "n", "method": "notify",
                "message": "hi" }),
        );
        assert_eq!(state.notifications[0]["message"], "hi");
        assert!(state.notifications[0]["receivedAt"].is_i64());
        let widget = |state: &mut ReducedState, key: Value, lines: Value| {
            reduce(
                state,
                json!({ "type": "extension_ui_request", "method": "setWidget",
                    "widgetKey": key, "widgetLines": lines }),
            );
        };
        widget(&mut state, json!("todo"), json!(["a", 1, null, [1, null]]));
        widget(&mut state, json!(null), json!(["x"]));
        widget(&mut state, json!("long"), json!(vec!["l"; 100]));
        assert_eq!(state.widgets["todo"], ["a", "1", "null", "[1,null]"]);
        assert_eq!(state.widgets[""], ["x"]);
        assert_eq!(state.widgets["long"].len(), 64);
        widget(&mut state, json!("todo"), json!([]));
        assert_eq!(state.widgets.keys().collect::<Vec<_>>(), ["", "long"]);
        reduce(
            &mut state,
            json!({ "type": "extension_ui_request", "method": "setStatus",
                "statusKey": "goal", "statusText": "on" }),
        );
        assert_eq!(state.statuses["goal"], "on");
        reduce(
            &mut state,
            json!({ "type": "extension_ui_request", "method": "setStatus", "statusKey": "goal" }),
        );
        assert!(state.statuses.is_empty());
    }
}
