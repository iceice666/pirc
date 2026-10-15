//! The `recall` tool of observational memory (`agent/features/memory/`),
//! with the test playing the agent's node. `recall` is not a direct tool:
//! the model reaches it only from a `ptc` script, so these transcripts
//! replay only on an agent with the PTC runtime (docs/history/rust-rewrite.md,
//! M5). The rest of the feature is in `agent_memory.rs`.

mod memory_support;

use memory_support::*;
use pirc_conformance::{AgentOptions, AgentRun, Gate, ModelReply};
use regex::Regex;
use serde_json::{Value, json};

fn options(memory: Value) -> AgentOptions {
    AgentOptions {
        config: json!({ "features": { "observationalMemory": memory,
            "compaction": { "keepRecentTokens": 1 } } }),
        ..AgentOptions::default()
    }
    .features("observational-memory")
}

/// Recall the first memory id the request's messages show next to
/// `about`.
fn recall_shown(call: &str, about: &str) -> ModelReply {
    let pattern = Regex::new(&format!(
        r"\[([a-f0-9]{{12}})\][^\n]*{}",
        regex::escape(about)
    ))
    .unwrap();
    let call = call.to_owned();
    ModelReply::computed(move |body| {
        let shown = format!("{}{}", body["systemPrompt"], body["messages"]);
        let shown = shown.replace("\\n", "\n");
        let id = pattern
            .captures(&shown)
            .map_or("aaaaaaaaaaaa".to_owned(), |found| found[1].to_owned());
        ModelReply::Tools(vec![ptc(&call, "recall", json!({ "id": id }))])
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_recall() {
    let Some(mut agent) = AgentRun::start(options(json!({
        "observeAfterTokens": 5, "reflectAfterTokens": 1_000_000,
        "compactAfterTokens": 1_000_000, "showWorkerNotifications": false,
        "workspace": { "enabled": false },
    })))
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    let gate = Gate::new();
    agent.route(
        OBSERVER,
        [
            ModelReply::gated(
                &gate,
                observe(&[("User stated their name is Ada.", "high", "2026-09-25 10:00")]),
            ),
            text("Observed."),
        ],
    );
    agent.push([text("Nice to meet you, Ada.")]);
    log.turn(&mut agent, "first", "Hi, my name is Ada and I like tea.")
        .await;
    gate.open();
    log.background(&mut agent, "observer", "om.observations.recorded")
        .await;
    agent.push([text("Tea it is.")]);
    log.turn(&mut agent, "second", "What do I like?").await;
    let compacted = agent.call(json!({ "type": "compact" })).await;
    log.note("compact", compacted);
    let lines = agent.drain(QUIET).await;
    log.note("compact: lines", json!(lines));
    // The observer sees recall output only as an omission.
    let gate = Gate::new();
    agent.route(OBSERVER, [ModelReply::gated(&gate, text("Nothing new."))]);
    agent.push([
        recall_shown("r1", "Ada"),
        ModelReply::Tools(vec![ptc("r2", "recall", json!({ "id": "XYZ" }))]),
        ModelReply::Tools(vec![ptc("r3", "recall", json!({ "id": "aaaaaaaaaaaa" }))]),
        text("done"),
    ]);
    log.turn(&mut agent, "recall", "recall it").await;
    gate.open();
    log.background_quiet(&mut agent, "observer after recall")
        .await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_memory_recall", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_workspace_memory_recall() {
    let Some(mut agent) = AgentRun::start(AgentOptions {
        prepare: Some(git_repository),
        ..options(json!({
            "observeAfterTokens": 5, "reflectAfterTokens": 5,
            "compactAfterTokens": 1_000_000, "showWorkerNotifications": false,
        }))
    })
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    let gate = Gate::new();
    agent.route(
        OBSERVER,
        [
            ModelReply::gated(
                &gate,
                observe(&[(
                    "User decided to store uploads in S3, not on disk.",
                    "high",
                    "2026-09-27 10:00",
                )]),
            ),
            text("Observed."),
        ],
    );
    agent.route(
        REFLECTOR,
        [reflect("S3", "Uploads live in S3."), text("Done.")],
    );
    agent.route(
        PROMOTER,
        [
            promote("Uploads are stored in S3 (decided by the user), not on local disk."),
            text("Recorded."),
        ],
    );
    agent.push([text("Understood, S3 it is.")]);
    log.turn(
        &mut agent,
        "first session",
        "Store uploads in S3, not on disk.",
    )
    .await;
    gate.open();
    log.background(&mut agent, "promotion", "om.workspace.promoted")
        .await;
    let Some(mut agent) = agent
        .restart(AgentOptions {
            session: Some("session2"),
            ..options(json!({ "observeAfterTokens": 1_000_000,
                "reflectAfterTokens": 1_000_000, "showWorkerNotifications": false }))
        })
        .await
    else {
        return;
    };
    // The workspace id is recallable through its source session.
    agent.push([recall_shown("rc", "Uploads are stored in S3"), text("ok")]);
    log.turn(&mut agent, "recall", "recall it").await;
    let id = workspace_ledger(&agent)[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    log.slash(&mut agent, &format!("/om:workspace forget {id}"))
        .await;
    // Forgotten: recall refuses it without its content.
    agent.push([
        ModelReply::Tools(vec![ptc("rc2", "recall", json!({ "id": id }))]),
        text("gone"),
    ]);
    log.turn(&mut agent, "recall forgotten", "recall it again")
        .await;
    insta::assert_json_snapshot!("agent_workspace_memory_recall", log.into_value());
}
