//! `auto-mode-gate.test.ts` without the model classifier (M5).

use std::rc::Rc;

use pirc_policy::real_resolve;
use serde_json::{Value, json};

use super::*;
use crate::tools::testing::{TestHost, args, config};

const WORKSPACE: &str = "/nonexistent-pirc-gate/home/repo";

fn host(features: Value, has_ui: bool) -> TestHost {
    let mut config = config("/", features);
    config.workspace = WORKSPACE.to_owned();
    config.path_policy.allow_write = vec![WORKSPACE.to_owned()];
    TestHost::new(config, Vec::new(), has_ui)
}

fn default_host() -> TestHost {
    host(json!({ "autoMode": { "useModel": false } }), false)
}

fn write(id: &str, input: &str) -> Map<String, Value> {
    args(json!({ "action": "write", "id": id, "input": input }))
}

async fn gate(
    auto: &AutoMode,
    host: &TestHost,
    tool: &str,
    args: Map<String, Value>,
) -> Option<String> {
    auto.gate(host, tool, &args, &AbortSignal::never())
        .await
        .unwrap()
}

#[tokio::test]
async fn judges_keystrokes_together_with_the_rest_of_their_line() {
    let host = default_host();
    let auto = AutoMode::new();
    // Each fragment alone looks harmless or unclear; together they are `rm -rf ~`.
    assert_eq!(
        gate(&auto, &host, "background_task", write("t1", "r")).await,
        None
    );
    let refused = gate(&auto, &host, "background_task", write("t1", "m -rf ~\n"))
        .await
        .unwrap();
    assert!(refused.contains("deletes"), "{refused}");
    assert!(refused.contains("no UI"), "{refused}");
    // Another task's line is separate.
    assert_eq!(
        gate(&auto, &host, "background_task", write("t2", "ls\n")).await,
        None
    );
    // The refused fragment was not sent: the pending line is still `r`.
    assert_eq!(
        auto.action_for(&host, "background_task", &write("t1", "x"))
            .unwrap()
            .text,
        "rx"
    );
    // Enter submits the line; the next one starts fresh.
    assert_eq!(
        gate(&auto, &host, "background_task", write("t1", "eadme\n")).await,
        None
    );
    assert_eq!(
        auto.action_for(&host, "background_task", &write("t1", "ls"))
            .unwrap()
            .text,
        "ls"
    );
    // Ctrl-C discards the line too.
    gate(&auto, &host, "background_task", write("t1", "r")).await;
    gate(&auto, &host, "background_task", write("t1", "\u{3}")).await;
    assert_eq!(
        auto.action_for(&host, "background_task", &write("t1", "ls"))
            .unwrap()
            .text,
        "ls"
    );
}

#[tokio::test]
async fn judges_concurrent_keystrokes_to_one_task_in_order() {
    let host = default_host();
    // A slow lease answer keeps the first write inside its gate.
    host.lease_delay_ms.set(30);
    let auto = AutoMode::new();
    let (first, second) = tokio::join!(
        gate(&auto, &host, "background_task", write("t1", "r")),
        gate(&auto, &host, "background_task", write("t1", "m -rf ~\n")),
    );
    assert_eq!(first, None);
    assert!(second.unwrap().contains("deletes"));
    assert!(auto.input_gates.borrow().is_empty());
}

#[test]
fn marks_control_keys() {
    assert_eq!(
        visible_keys("a\r\u{7f}\u{3}\u{15}"),
        "a\n⟨Backspace⟩⟨Ctrl-C⟩⟨Ctrl-U⟩"
    );
    assert_eq!(visible_keys("tus\t\u{1b}[A\n"), "tus⟨Tab⟩⟨Esc⟩[A\n");
    // A read-only line with control keys is not read-only any more.
    let host = default_host();
    let auto = AutoMode::new();
    let action = auto
        .action_for(&host, "background_task", &write("u", "ls\u{1b}[A\n"))
        .unwrap();
    let decision = auto.classify(&host, &action);
    assert_eq!(decision.classification.verdict, Verdict::Write);
    assert_eq!(decision.source, Source::Fallback);
}

#[tokio::test]
async fn bounds_the_pending_line() {
    let host = default_host();
    let auto = AutoMode::new();
    gate(
        &auto,
        &host,
        "background_task",
        write("t", &"x".repeat(10_000)),
    )
    .await;
    let action = auto
        .action_for(&host, "background_task", &write("t", "y"))
        .unwrap();
    assert!(js::len16(&action.text) < 4_200);
    assert!(action.text.starts_with("⟨earlier keystrokes truncated⟩"));
    assert!(
        auto.classify(&host, &action)
            .classification
            .reason
            .contains("model check disabled")
    );
}

#[tokio::test]
async fn leases_only_the_known_targets_of_a_command_else_its_working_directory() {
    for features in [
        json!({ "autoMode": { "useModel": false } }),
        json!({ "autoMode": { "enabled": false } }),
    ] {
        let host = host(features, false);
        let auto = AutoMode::new();
        let bash = |command: &str| args(json!({ "command": command }));
        gate(&auto, &host, "bash", bash("cd /tmp && mkdir -p ghpirc")).await;
        assert_eq!(
            *host.leases.borrow(),
            vec![format!("{}/ghpirc", real_resolve("/tmp"))]
        );
        host.leases.borrow_mut().clear();
        gate(
            &auto,
            &host,
            "bash",
            bash("mkdir -p /tmp/a && git commit -m x"),
        )
        .await;
        assert_eq!(*host.leases.borrow(), vec![WORKSPACE.to_owned()]);
        host.leases.borrow_mut().clear();
        gate(&auto, &host, "bash", bash("ls")).await;
        assert!(host.leases.borrow().is_empty());
    }
}

#[tokio::test]
async fn leases_the_working_directory_for_tty_input() {
    let host = default_host();
    let auto = AutoMode::new();
    gate(
        &auto,
        &host,
        "background_task",
        write("t", "mkdir /tmp/x\n"),
    )
    .await;
    assert_eq!(*host.leases.borrow(), vec![WORKSPACE.to_owned()]);
}

#[tokio::test]
async fn applies_the_deny_list_with_auto_mode_off_and_broken_settings() {
    let host = host(json!({ "autoMode": { "useModel": true } }), false);
    let auto = AutoMode::new();
    let action = auto
        .action_for(
            &host,
            "bash",
            &args(json!({ "command": "sh -c \"echo deploy-prod\"" })),
        )
        .unwrap();
    assert_eq!(
        auto.classify(&host, &action).classification.verdict,
        Verdict::Write
    );
    host.set_features(json!({ "autoMode": { "useModel": true, "deny": ["deploy-prod"] } }));
    let denied = auto.classify(&host, &action).classification;
    assert_eq!(denied.verdict, Verdict::Danger);
    assert!(denied.reason.contains("deny-list"));
    host.set_features(json!({ "autoMode": { "enabled": false, "deny": "deploy-prod" } }));
    assert_eq!(
        auto.classify(&host, &action).classification.verdict,
        Verdict::Danger
    );
    // A broken setting elsewhere does not drop the deny-list.
    host.set_features(json!({ "autoMode": { "timeoutMs": "soon", "deny": ["deploy-prod"] } }));
    assert_eq!(
        auto.classify(&host, &action).classification.verdict,
        Verdict::Danger
    );
}

#[tokio::test]
async fn applies_the_deny_list_to_tty_input_and_ptc_scripts() {
    let host = host(
        json!({ "autoMode": { "useModel": false, "deny": ["just\\s+switch"] } }),
        false,
    );
    let auto = AutoMode::new();
    gate(&auto, &host, "background_task", write("t", "just sw")).await;
    assert!(
        gate(&auto, &host, "background_task", write("t", "itch\n"))
            .await
            .unwrap()
            .contains("deny-list")
    );
    let script = "return await tools.bash({ command: \"just switch\" });";
    assert!(
        gate(&auto, &host, "ptc", args(json!({ "code": script })))
            .await
            .unwrap()
            .contains("deny-list")
    );
}

#[tokio::test]
async fn runs_scripts_without_a_prompt_lease_or_classifier() {
    let host = host(json!({ "autoMode": { "useModel": true } }), true);
    let auto = AutoMode::new();
    for code in ["return await tools.ls({});", "await Bun.$`rm -rf ~`;"] {
        assert_eq!(
            gate(&auto, &host, "ptc", args(json!({ "code": code }))).await,
            None
        );
    }
    assert!(host.leases.borrow().is_empty());
    assert!(host.ui.confirms.borrow().is_empty());
}

#[test]
fn no_longer_gates_the_retired_code_tool() {
    let host = default_host();
    let auto = AutoMode::new();
    assert_eq!(
        auto.action_for(&host, "code", &args(json!({ "code": "await Bun.$`x`;" }))),
        None
    );
}

#[tokio::test]
async fn asks_a_human_about_danger_when_there_is_one() {
    let host = Rc::new(host(json!({}), true));
    let auto = AutoMode::new();
    let command = args(json!({ "command": "rm -rf ~" }));
    host.ui.answer.set(Some(false));
    let refused = gate(&auto, &host, "bash", command.clone()).await.unwrap();
    assert!(refused.ends_with(
        "The user declined it. Do not try to reach the same effect another way; explain what you intended and ask the user to run or approve it."
    ));
    let asked = host.ui.confirms.borrow()[0].clone();
    assert_eq!(
        asked,
        format!(
            "Command (bash, in {WORKSPACE}):\n\nrm -rf ~\n\nReason: deletes {}, outside the workspace",
            real_resolve(&std::env::var("HOME").unwrap())
        )
    );
    host.ui.answer.set(None);
    assert!(
        gate(&auto, &host, "bash", command.clone())
            .await
            .unwrap()
            .contains("The user did not approve it.")
    );
    host.ui.answer.set(Some(true));
    assert_eq!(gate(&auto, &host, "bash", command).await, None);
    // An approved danger still takes the lease.
    assert_eq!(*host.leases.borrow(), vec![WORKSPACE.to_owned()]);
}

#[tokio::test]
async fn warns_once_about_invalid_deny_patterns() {
    let host = host(json!({ "autoMode": { "deny": ["rm -rf ("] } }), false);
    let auto = AutoMode::new();
    let bash = args(json!({ "command": "ls" }));
    gate(&auto, &host, "bash", bash.clone()).await;
    gate(&auto, &host, "bash", bash).await;
    assert_eq!(
        *host.ui.notes.borrow(),
        vec![
            "Auto mode: deny-list pattern(s) are not valid regular expressions and are matched as plain text: rm -rf ("
                .to_owned()
        ]
    );
}

#[test]
fn reads_the_settings_like_zod() {
    let enabled = |value: Value| auto_mode_enabled(value.as_object().unwrap());
    assert!(enabled(json!({})));
    assert!(!enabled(json!({ "autoMode": { "enabled": false } })));
    // Any invalid setting restores every default.
    assert!(enabled(
        json!({ "autoMode": { "enabled": false, "timeoutMs": "soon" } })
    ));
    assert!(enabled(
        json!({ "autoMode": { "enabled": false, "model": { "provider": "p" } } })
    ));
    assert!(!enabled(json!({ "autoMode": {
        "enabled": false,
        "model": { "provider": "p", "id": "m", "thinking": "low" },
        "fallbackModels": [],
        "timeoutMs": 1000,
        "deny": ["x"],
    } })));
    assert_eq!(
        auto_mode_deny(
            json!({ "autoMode": { "deny": ["a", 1, "b"] } })
                .as_object()
                .unwrap()
        ),
        vec!["a", "b"]
    );
}

#[tokio::test]
async fn without_the_model_classifier_unclear_actions_write_and_warn_once() {
    // `useModel` defaults to true; the classifier is M5's, so TS's
    // classifier-failure path applies: one warning, then plain writes.
    let host = host(json!({}), false);
    let auto = AutoMode::new();
    for _ in 0..2 {
        let action = auto
            .action_for(&host, "bash", &args(json!({ "command": "python3 x.py" })))
            .unwrap();
        let decision = auto.classify(&host, &action);
        assert_eq!(decision.source, Source::Fallback);
        assert_eq!(decision.classification.verdict, Verdict::Write);
        assert!(
            decision
                .classification
                .reason
                .ends_with("; classifier unavailable")
        );
    }
    assert_eq!(
        *host.ui.notes.borrow(),
        vec![format!(
            "Auto mode: classifier unavailable ({CLASSIFIER_MISSING}); treating unclear shell actions as writes"
        )]
    );
}
