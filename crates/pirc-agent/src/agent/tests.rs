use super::*;

fn mode_agent(
    dir: &std::path::Path,
    mode: pirc_protocol::Mode,
    features: Value,
    allowed_tools: Option<Vec<String>>,
) -> Rc<Agent> {
    mode_agent_with_ui(dir, mode, features, allowed_tools).0
}

fn mode_agent_with_ui(
    dir: &std::path::Path,
    mode: pirc_protocol::Mode,
    features: Value,
    allowed_tools: Option<Vec<String>>,
) -> (Rc<Agent>, Rc<crate::tools::testing::TestUi>) {
    let ui = Rc::new(crate::tools::testing::TestUi::default());
    let mut config = crate::tools::testing::config(&dir.display().to_string(), features);
    config.mode = mode;
    config.role_dirs = crate::roles::role_dirs(&config.config_dir, &config.workspace);
    let store = SessionStore::open(dir.join("session"), &config.workspace).unwrap();
    let agent = Agent::new(AgentOptions {
        config,
        capabilities: Default::default(),
        project_instructions: None,
        role: None,
        store,
        emit: Rc::new(|_| {}),
        ui: ui.clone(),
        has_ui: false,
        tools: crate::tools::builtin_tools(),
        features: crate::features::builtin_features(),
        acquire_write: None,
        allowed_tools,
        stream_override: None,
    });
    (agent, ui)
}

#[test]
fn mode_configures_every_feature_without_removing_diagnostics() {
    for key in pirc_protocol::mode::FEATURE_NAMES {
        for mode_enabled in [false, true] {
            for explicit in [None, Some(true), Some(false)] {
                let dir = tempfile::tempdir().unwrap();
                let mut mode = pirc_protocol::mode::default_work();
                if mode_enabled {
                    mode.features_on.push((*key).into());
                } else {
                    mode.features_off.push((*key).into());
                }
                let mut features = json!({});
                if let Some(enabled) = explicit {
                    features[*key] = json!({"enabled":enabled});
                }
                let agent = mode_agent(dir.path(), mode, features, None);
                assert!(
                    agent.features.iter().any(|feature| {
                        crate::features::config_key(feature.name()) == Some(*key)
                    }),
                    "{key} must retain its diagnostics"
                );
                assert_eq!(
                    agent.config.features[*key]["enabled"],
                    json!(explicit.unwrap_or(mode_enabled)),
                    "{key}"
                );
            }
        }
    }
}

#[tokio::test]
async fn disabled_memory_keeps_status_notifications_after_init() {
    for disabled_by_mode in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut mode = pirc_protocol::mode::default_work();
        let features = if disabled_by_mode {
            mode.features_off.push("observationalMemory".into());
            json!({})
        } else {
            json!({"observationalMemory": {"enabled": false}})
        };
        let (agent, ui) = mode_agent_with_ui(dir.path(), mode, features, None);
        agent.init().await.unwrap();
        assert!(agent.get_tool("recall").is_some());
        let memory = agent
            .features
            .iter()
            .find(|feature| feature.name() == "observational-memory")
            .expect("disabled memory must retain its status commands");
        assert!(
            memory
                .commands()
                .iter()
                .any(|command| command.name == "om:status")
        );
        memory
            .run_command(&agent, "om:status", String::new())
            .await
            .unwrap();
        assert!(
            ui.notes
                .borrow()
                .iter()
                .any(|note| note.starts_with("Session handoffs:"))
        );
    }
}

#[tokio::test]
async fn mode_default_off_survives_malformed_feature_settings() {
    for mode_disabled in [false, true] {
        for explicit in [None, Some(true), Some(false)] {
            let dir = tempfile::tempdir().unwrap();
            let mut mode = pirc_protocol::mode::default_work();
            if mode_disabled {
                mode.features_off = vec!["observationalMemory".into(), "sessionTitle".into()];
            }
            // Both validators reset the whole configuration on bad fields,
            // including an explicit false. Preserve that legacy fallback
            // outside a default-off mode without letting it bypass the mode.
            let mut features = json!({
                "observationalMemory": {"fallbackModels": [{"provider": "missing-id"}]},
                "sessionTitle": {"maxAttempts": 0}
            });
            if let Some(enabled) = explicit {
                features["observationalMemory"]["enabled"] = json!(enabled);
                features["sessionTitle"]["enabled"] = json!(enabled);
            }
            let (agent, ui) = mode_agent_with_ui(dir.path(), mode, features, None);
            agent.init().await.unwrap();
            let enabled = explicit != Some(false) && (!mode_disabled || explicit == Some(true));
            assert_eq!(
                crate::features::memory::memory_config(&agent).enabled,
                enabled
            );
            assert_eq!(
                crate::features::title::title_settings(&agent).enabled,
                !mode_disabled || explicit == Some(true)
            );
            assert!(agent.get_tool("recall").is_some());
            let memory = agent
                .features
                .iter()
                .find(|feature| feature.name() == "observational-memory")
                .unwrap();
            memory
                .run_command(&agent, "om:status", String::new())
                .await
                .unwrap();
            assert!(
                ui.notes
                    .borrow()
                    .iter()
                    .any(|note| note.starts_with("Session handoffs:"))
            );
        }
    }
}

#[test]
fn default_chat_keeps_management_commands_while_hiding_default_off_tools() {
    let dir = tempfile::tempdir().unwrap();
    let agent = mode_agent(
        dir.path(),
        pirc_protocol::mode::default_chat(),
        json!({}),
        None,
    );
    let commands = agent
        .features
        .iter()
        .flat_map(|feature| feature.commands())
        .map(|command| command.name.to_string())
        .collect::<Vec<_>>();
    assert!(commands.iter().any(|name| name == "todo"));
    assert!(commands.iter().any(|name| name == "bg"));
    assert!(agent.get_tool("todo").is_none());
    assert!(agent.get_tool("background_task").is_none());
}

#[test]
fn mode_tool_registry_matches_actual_registered_operation_names() {
    use crate::features::{assistant, browser, calendar, sandbox, schedules, web_search};
    let dir = tempfile::tempdir().unwrap();
    let agent = mode_agent(
        dir.path(),
        pirc_protocol::mode::default_work(),
        json!({}),
        None,
    );
    let mut names: std::collections::BTreeSet<String> = agent
        .available_tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    names.extend(browser::registered_tool_names());
    names.extend(sandbox::registered_tool_names());
    names.extend(schedules::registered_tool_names());
    names.extend(calendar::registered_tool_names());
    names.extend(web_search::registered_tool_names());
    names.extend(assistant::registered_tool_names(&agent));
    let declared = pirc_protocol::mode::TOOL_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(names, declared);
}

#[test]
fn mode_tool_ceiling_survives_roles_cli_and_recorded_role_restoration() {
    let dir = tempfile::tempdir().unwrap();
    let mut mode = pirc_protocol::mode::default_work();
    mode.tools = Some(vec!["read".into()]);
    let agent = mode_agent(
        dir.path(),
        mode.clone(),
        json!({}),
        Some(vec!["read".into(), "write".into(), "ptc".into()]),
    );
    let roles = dir.path().join(".pirc/roles");
    std::fs::create_dir_all(&roles).unwrap();
    std::fs::write(
        roles.join("wide.md"),
        "---\ntools: [read, write, agent_spawn]\n---\n",
    )
    .unwrap();
    agent.set_role("wide").unwrap();
    assert_eq!(
        agent
            .available_tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        ["read"]
    );
    assert!(agent.get_tool("write").is_none());
    assert!(agent.get_tool("ptc").is_none());
    assert_eq!(
        agent
            .model_tool_list()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        ["ptc", "ptc_docs", "read"]
    );
    drop(agent);
    let restored = mode_agent(dir.path(), mode, json!({}), None);
    assert_eq!(
        restored
            .available_tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        ["read"]
    );
    assert_eq!(restored.role.borrow().as_ref().unwrap().name, "wide");
}

#[tokio::test]
async fn mode_denied_operations_cannot_execute_through_ptc() {
    let dir = tempfile::tempdir().unwrap();
    let mut mode = pirc_protocol::mode::default_work();
    mode.tools = Some(vec!["read".into()]);
    let agent = mode_agent(dir.path(), mode.clone(), json!({}), None);
    let outcome = agent
        .run_operation(
            "ptc-call",
            "write",
            json!({"path":"escaped.txt","content":"no"})
                .as_object()
                .unwrap()
                .clone(),
            &AbortSignal::never(),
            "op-denied",
            OperationOptions::default(),
        )
        .await;
    assert!(outcome.result.is_error);
    assert!(!dir.path().join("escaped.txt").exists());
    mode.tools = Some(Vec::new());
    let empty = mode_agent(dir.path(), mode, json!({}), None);
    assert!(empty.available_tools().is_empty());
    assert!(empty.model_tool_list().is_empty());
}

fn call(id: &str) -> AssistantContent {
    AssistantContent::ToolCall {
        id: id.to_owned(),
        name: "read".to_owned(),
        arguments: Map::new(),
        thought_signature: None,
    }
}

fn assistant(content: Vec<AssistantContent>, stop: StopReason) -> Message {
    Message::Assistant(AssistantMessage {
        content,
        api: "x".to_owned(),
        provider: "p".to_owned(),
        model: "m".to_owned(),
        usage: empty_usage(),
        stop_reason: stop,
        error_message: None,
        timestamp: 1,
        completed_at: None,
        canonical_provider: None,
        response_id: None,
        response_model: None,
    })
}

fn result(id: &str) -> Message {
    Message::ToolResult {
        tool_call_id: id.to_owned(),
        tool_name: "read".to_owned(),
        content: vec![],
        details: None,
        is_error: false,
        timestamp: 2,
    }
}

#[test]
fn sanitizes_orphans_and_missing_results() {
    let user = Message::User {
        content: UserContent::Text("hi".to_owned()),
        timestamp: 0,
    };
    let messages = vec![
        result("orphan"),
        assistant(vec![call("a"), call("b")], StopReason::ToolUse),
        result("b"),
        user.clone(),
        assistant(vec![call("c")], StopReason::Error),
        result("c"),
    ];
    let out = sanitize_history(&messages);
    let shape: Vec<String> = out
        .iter()
        .map(|m| match m {
            Message::ToolResult {
                tool_call_id,
                is_error,
                ..
            } => format!("result {tool_call_id} {is_error}"),
            Message::Assistant(_) => "assistant".to_owned(),
            Message::User { .. } => "user".to_owned(),
            _ => "other".to_owned(),
        })
        .collect();
    assert_eq!(
        shape,
        [
            "assistant",
            "result b false",
            "result a true",
            "user",
            "assistant"
        ]
    );
}

#[test]
fn interrupted_notes_carry_the_partial_text() {
    let message = match assistant(
        vec![AssistantContent::Text {
            text: "  partial  ".to_owned(),
            text_signature: None,
        }],
        StopReason::Aborted,
    ) {
        Message::Assistant(message) => message,
        _ => unreachable!(),
    };
    match interrupted_note(&message) {
        QueueItem::Custom(message) => match *message {
            Message::Custom { content, .. } => assert_eq!(
                content,
                "[Your previous response was interrupted by the user.] Partial output:\n\npartial"
            ),
            _ => panic!(),
        },
        _ => panic!(),
    }
}

#[test]
fn parses_slash_commands() {
    let parsed = |text: &str| parse_command(text);
    assert_eq!(
        parsed("  /goal   finish it \n"),
        Some(("goal".to_owned(), "finish it".to_owned()))
    );
    assert_eq!(
        parsed("/om:status"),
        Some(("om:status".to_owned(), String::new()))
    );
    assert_eq!(
        parsed("/Todo\u{3000}a\nb"),
        Some(("Todo".to_owned(), "a\nb".to_owned()))
    );
    for text in ["goal", "/1goal", "/goal!", "/ goal", "/goal\u{85}x"] {
        assert_eq!(parsed(text), None, "{text:?}");
    }
}

#[test]
fn retryable_errors() {
    for text in [
        "Model request failed (HTTP 503)",
        "Inference request timed out",
        "rate limit",
    ] {
        assert!(is_retryable(Some(text)), "{text}");
    }
    for text in ["Gateway inference is unavailable", "HTTP 400", ""] {
        assert!(!is_retryable(Some(text)), "{text}");
    }
    assert!(!is_retryable(None));
}
