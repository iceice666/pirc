//! The unit cases of `agent-assistant.test.ts` ("where a memory comes
//! from") and the prompt rendering.

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
            &["grep".to_owned(), "memory_propose_user".to_owned()]
        ),
        ["assistant", "tool:grep", "tool:ptc", "tool:web_fetch"]
    );
}

#[test]
fn renders_memory_and_workspaces() {
    let context = json!({
        "enabled": true,
        "user": [{ "id": "u11111111", "content": "Prefers short answers.", "revision": 2 }],
        "notes": [],
        "usage": { "user": { "used": 22, "max": 2000 }, "note": { "used": 0, "max": 8000 } },
        "pendingProposals": 2,
    });
    let text = render_memory(&context);
    assert!(text.contains("### USER (22/2,000 characters)\n[u11111111] Prefers short answers."));
    assert!(text.contains("### MEMORY (0/8,000 characters)\n(none yet)"));
    assert!(text.contains("2 proposed USER changes are waiting for the user's approval."));
    let workspaces = render_workspaces(&[
        json!({ "id": "work:test", "name": "Test", "node": "work", "online": true }),
        json!({ "id": "lab:x", "name": "X", "node": "lab", "online": false,
            "roles": [{ "name": "plain" }] }),
    ]);
    assert_eq!(
        workspaces,
        "## Workspaces\n\nThe user's repositories you can hand tasks to with delegate. Online status is as of this chat's start. Their coding sessions keep notes there (workspace memory): search them with memory_search, and open a note's sources with recall.\n[work:test] Test on work\n[lab:x] X on lab (offline)\n  Roles:\n  - plain: (no description)"
    );
    let section = format!("{text}\n\n{workspaces}");
    let policy = |value: Value| Capabilities::from_value(&value);
    assert_eq!(present_section(&section, &policy(json!({}))), section);
    assert_eq!(
        present_section(&section, &policy(json!({ "delegation": false }))),
        text
    );
    assert!(
        !present_section(&section, &policy(json!({ "memory_search": false })))
            .contains("workspace memory")
    );
    assert!(
        present_section(&section, &policy(json!({ "remote_recall": false })))
            .contains("search them with memory_search.\n")
    );
}

#[test]
fn renders_user_for_coding_sessions() {
    assert_eq!(render_user(&[]), "");
    let text = render_user(&[
        json!({ "id": "u11111111", "content": "Prefers short answers.", "revision": 2 }),
        json!({ "id": "u22222222", "content": "Writes commit messages in English.", "revision": 1 }),
    ]);
    assert!(text.starts_with("## User\n\n"), "{text}");
    assert!(text.ends_with("\n\n- Prefers short answers.\n- Writes commit messages in English."));
    // No ids: nothing here can change an entry.
    assert!(!text.contains("u11111111"));
    assert!(text.contains("you cannot change it here"));
}
