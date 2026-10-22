//! Retired OM settings remain compatible; source lookup and Work blocks are independent.
use pirc_conformance::{AgentOptions, AgentRun, ModelReply};
use serde_json::{Value, json};
use std::time::Duration;
async fn turn(agent: &mut AgentRun, text: &str) {
    agent.push([ModelReply::Text("Done".into())]);
    assert_eq!(
        agent.call(json!({"type":"prompt","message":text})).await["success"],
        true
    );
    agent.settle().await;
    agent.drain(Duration::from_millis(50)).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn legacy_settings_do_not_restart_observer_reflector_or_promoter() {
    for settings in [
        json!({"observeAfterTokens":1,"reflectAfterTokens":1,"compactAfterTokens":10000000}),
        json!({"enabled":false,"fallbackModels":[{"provider":"invalid"}],"workspace":{"enabled":false}}),
    ] {
        let Some(mut agent) = AgentRun::start(
            AgentOptions {
                config: json!({"features":{"observationalMemory":settings}}),
                ..Default::default()
            }
            .features("observational-memory,workspace-memory"),
        )
        .await
        else {
            return;
        };
        turn(&mut agent, "Please inspect this repository").await;
        assert_eq!(agent.take_requests().len(), 1);
        let entries = agent.session_entries();
        assert!(!entries.iter().any(|e| {
            e["customType"]
                .as_str()
                .is_some_and(|s| s.starts_with("om."))
        }));
        let commands = agent.call(json!({"type":"get_commands"})).await.to_string();
        assert!(!commands.contains("om:observe"));
        assert!(commands.contains("om:workspace"));
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn work_notes_refresh_and_disappear_on_revocation_without_activating_a_ledger() {
    let options = AgentOptions {
        env: vec![("PIRC_GATEWAY".into(), "1".into())],
        ..Default::default()
    }
    .features("workspace-memory");
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    {
        let mut answers = agent.answers.lock().unwrap();
        answers.gateway_queue.insert("workspace.context".into(),[json!({"ok":true,"result":{"items":[{"id":"aaaaaaaaaaaa","content":"Legacy repository knowledge"}],"legacy":true}}),json!({"ok":false,"error":{"code":"forbidden","message":"Owner changed","status":403}})].into());
        answers.gateway.insert("workspace.next".into(),json!({"ok":false,"error":{"code":"workspace_cold_cutover_required","message":"Cold cutover required","status":409}}));
    }
    turn(&mut agent, "First").await;
    let first = agent.take_requests();
    assert!(
        first[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("Legacy repository knowledge")
    );
    turn(&mut agent, "After revocation").await;
    let second = agent.take_requests();
    assert!(
        !second[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("Legacy repository knowledge")
    );
    assert!(
        second[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("unavailable")
    );
    assert!(
        !agent
            .session_entries()
            .iter()
            .any(|e| e["customType"] == "om.workspace.snapshot")
    );
}
#[tokio::test(flavor = "multi_thread")]
async fn chat_cannot_load_repository_memory_even_with_explicit_enable() {
    let options = AgentOptions {
        env: vec![
            ("PIRC_GATEWAY".into(), "1".into()),
            (
                "PIRC_MODE".into(),
                serde_json::to_string(&pirc_protocol::mode::default_chat()).unwrap(),
            ),
        ],
        config: json!({"features":{"workspaceMemory":{"enabled":true}}}),
        ..Default::default()
    }
    .features("workspace-memory");
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    agent.answers.lock().unwrap().gateway.insert("workspace.context".into(),json!({"ok":true,"result":{"items":[{"id":"aaaaaaaaaaaa","content":"Forbidden Work note"}]}}));
    turn(&mut agent, "Hello").await;
    assert!(
        !agent.take_requests()[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("Forbidden Work note")
    );
}
// Keep type imports checked alongside the feature's wire fixture shape.
const _: fn(Value) -> Value = |v| v;
#[tokio::test(flavor = "multi_thread")]
async fn independent_extraction_uses_one_call_and_rate_limit_falls_back_on_the_next_sync() {
    let options=AgentOptions{env:vec![("PIRC_GATEWAY".into(),"1".into())],config:json!({"features":{"workspaceMemory":{"model":{"provider":"fake","id":"small-model"},"fallbackModels":[{"provider":"fake","id":"fake-model"}]}}}),..Default::default()}.features("workspace-memory");
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    let job = json!({"jobId":"job","control":{"epoch":"epoch","generation":"generation","revision":1},"sessionId":"original","fromEntryId":"evidence","throughEntryId":"end","sourceHash":"f".repeat(64),"sources":[{"sessionId":"original","entryId":"evidence","role":"user","text":"Use SQLite for this repository","derived":false}],"catchup":false});
    {
        let mut answers = agent.answers.lock().unwrap();
        answers.gateway.insert(
            "workspace.context".into(),
            json!({"ok":true,"result":{"legacy":false,"items":[]}}),
        );
        answers.gateway.insert(
            "workspace.commit".into(),
            json!({"ok":true,"result":{"committed":true}}),
        );
        answers.gateway_queue.insert(
            "workspace.next".into(),
            [
                json!({"ok":true,"result":job.clone()}),
                json!({"ok":true,"result":job}),
                json!({"ok":true,"result":null}),
            ]
            .into(),
        );
    }
    agent.push([
        ModelReply::Text("Main reply".into()),
        ModelReply::Failed("HTTP 429 rate limit".into()),
    ]);
    agent.call(json!({"type":"prompt","message":"First"})).await;
    agent.settle().await;
    agent.drain(Duration::from_millis(300)).await;
    let first = agent.take_requests();
    assert_eq!(first.len(), 2);
    assert_eq!(first[1]["modelId"], "small-model");
    agent.push([ModelReply::Text("Second reply".into()),ModelReply::Text(json!({"items":[{"content":"Use SQLite","sources":[{"sessionId":"original","entryId":"evidence"}]}],"retire":[]}).to_string())]);
    agent
        .call(json!({"type":"prompt","message":"Second"}))
        .await;
    agent.settle().await;
    let events = agent.drain(Duration::from_millis(300)).await;
    let requests = agent.take_requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["modelId"], "fake-model");
    assert!(
        events.iter().any(|e| e["op"] == "workspace.commit"),
        "{events:?}"
    );
    assert!(
        !agent
            .session_entries()
            .iter()
            .any(|e| e["type"] == "compaction" || e["customType"] == "om.observations.recorded")
    );
}
