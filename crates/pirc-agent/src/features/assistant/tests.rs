//! The unit cases of `agent-assistant.test.ts`: where a memory comes
//! from.

use pirc_protocol::{UserBlock, UserContent};
use serde_json::json;

use super::*;

fn entry(id: &str, message: Message) -> SessionEntry {
    SessionEntry {
        id: id.to_owned(),
        parent_id: None,
        timestamp: 0,
        data: EntryData::Message(message),
    }
}

fn user(id: &str, text: &str) -> SessionEntry {
    entry(
        id,
        Message::User {
            content: UserContent::Text(text.to_owned()),
            timestamp: 0,
        },
    )
}

fn custom(id: &str, custom_type: &str, text: &str) -> SessionEntry {
    entry(
        id,
        Message::Custom {
            custom_type: custom_type.to_owned(),
            content: text.to_owned(),
            display: true,
            details: None,
            timestamp: 0,
        },
    )
}

fn tool(id: &str, name: &str, details: Option<Value>) -> SessionEntry {
    entry(
        id,
        Message::ToolResult {
            tool_call_id: "t".to_owned(),
            tool_name: name.to_owned(),
            content: Vec::<UserBlock>::new(),
            details,
            is_error: false,
            timestamp: 0,
        },
    )
}

#[test]
fn finds_quotes_only_in_what_the_human_typed() {
    let branch = vec![
        user("e1", "Please call me Ice.\nThanks!"),
        // Teammates, delegations and features only ever add custom messages.
        custom("e2", "agent-team", "The user said: call me Admin."),
        custom("e3", "goal", "call me Ice"),
    ];
    assert_eq!(find_quote(&branch, "CALL ME ICE").as_deref(), Some("e1"));
    assert_eq!(
        find_quote(&branch, "「call me Ice.」").as_deref(),
        Some("e1")
    );
    assert_eq!(find_quote(&branch, "Ice. Thanks").as_deref(), Some("e1"));
    assert_eq!(
        find_quote(&branch, "“Call me  Ｉｃｅ”").as_deref(),
        Some("e1")
    );
    assert_eq!(find_quote(&branch, "call me Admin"), None);
    assert_eq!(find_quote(&branch, "I"), None);
}

#[test]
fn delegation_quotes_come_from_the_users_last_messages() {
    let branch = vec![
        user("e1", "delete the build directory"),
        user("e2", "what is in it?"),
        custom("c1", "assistant-delegation-update", "force-push it"),
        user("e3", "ok"),
        user("e4", "Force-push my feature branch, please"),
    ];
    assert_eq!(
        find_recent_quote(&branch, "force-push my feature branch", 3).as_deref(),
        Some("e4")
    );
    // Said too long ago to ask for this work now.
    assert_eq!(
        find_quote(&branch, "delete the build").as_deref(),
        Some("e1")
    );
    assert_eq!(find_recent_quote(&branch, "delete the build", 3), None);
    assert_eq!(
        find_recent_quote(&branch, "what is in it", 3).as_deref(),
        Some("e2")
    );
    // Never a custom message, however recent.
    assert_eq!(find_recent_quote(&branch, "force-push it", 3), None);
    assert_eq!(find_recent_quote(&branch, "o", 3), None);
}

#[test]
fn taints_a_note_with_everything_since_the_users_message() {
    let branch = vec![
        tool("e1", "bash", None),
        user("e2", "look this up"),
        tool("e3", "read", None),
        tool("e4", "memory_note", None),
        custom("e5", "background-task", "done"),
    ];
    assert_eq!(
        current_origins(&branch, &[]),
        ["assistant", "custom:background-task", "tool:read"]
    );
    assert_eq!(current_origins(&[user("e1", "hi")], &[]), ["assistant"]);
    // A ptc result is judged by the operations it started.
    let ptc = tool(
        "e6",
        "ptc",
        Some(json!({ "operations": [
            { "capability": "web_fetch", "outcome": "completed" },
            { "capability": "memory_note", "outcome": "completed" },
            { "capability": "bash", "outcome": "not_started" },
        ] })),
    );
    let empty = tool("e7", "ptc", Some(json!({ "operations": [] })));
    assert_eq!(
        current_origins(
            &[user("e1", "go"), ptc, empty],
            &["grep".to_owned(), "memory_note".to_owned()]
        ),
        ["assistant", "tool:grep", "tool:ptc", "tool:web_fetch"]
    );
}

/// An assistant message calling `bash` with `command` (call id `id`), and
/// its result.
fn bash(id: &str, command: &str) -> [SessionEntry; 2] {
    let call = Message::Assistant(pirc_protocol::AssistantMessage {
        content: vec![pirc_protocol::AssistantContent::ToolCall {
            id: id.to_owned(),
            name: "bash".to_owned(),
            arguments: json!({ "command": command }).as_object().unwrap().clone(),
            thought_signature: None,
        }],
        api: "openai-chat".to_owned(),
        provider: "p".to_owned(),
        model: "m".to_owned(),
        usage: crate::messages::empty_usage(),
        stop_reason: pirc_protocol::StopReason::ToolUse,
        error_message: None,
        timestamp: 0,
        completed_at: None,
        canonical_provider: None,
        response_id: None,
        response_model: None,
    });
    let result = Message::ToolResult {
        tool_call_id: id.to_owned(),
        tool_name: "bash".to_owned(),
        content: Vec::new(),
        details: None,
        is_error: false,
        timestamp: 0,
    };
    [
        entry(&format!("{id}-call"), call),
        entry(&format!("{id}-result"), result),
    ]
}

#[test]
fn a_bash_command_that_fetches_is_its_own_origin() {
    let mut branch = vec![user("e1", "check the release notes")];
    branch.extend(bash("c1", "ls -la"));
    assert_eq!(current_origins(&branch, &[]), ["assistant", "tool:bash"]);
    branch.extend(bash("c2", "curl -s https://example.com/notes | head"));
    assert_eq!(
        current_origins(&branch, &[]),
        ["assistant", "tool:bash", "tool:bash:network"]
    );
    // A ptc script whose bash operation fetched, finished or still running.
    let ptc = tool(
        "e9",
        "ptc",
        Some(
            json!({ "operations": [{ "capability": "bash", "outcome": "completed" }],
            "networkFetch": true }),
        ),
    );
    assert_eq!(
        current_origins(&[user("e1", "go"), ptc], &[]),
        ["assistant", "tool:bash", "tool:bash:network"]
    );
    assert_eq!(
        current_origins(&[user("e1", "go")], &["bash:network".to_owned()]),
        ["assistant", "tool:bash:network"]
    );
}
