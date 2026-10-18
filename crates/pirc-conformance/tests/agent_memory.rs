//! Observational memory (`agent/features/memory/`, feature
//! `observational-memory`), with the test playing the agent's node: the
//! observer, reflector and promoter side requests, memory as the
//! compaction summary, automatic compaction, the rate-limit fallback, the
//! settings, the `om:*` commands, the panel, and workspace memory handed
//! from one session to the next. The historical feature baseline
//! (docs/development/historical-records.md). `recall`, reachable only from `ptc` scripts,
//! is in `agent_memory_ptc.rs`.
//!
//! Memory workers run next to the session's own run. Their first reply is
//! held by a gate until the run settled, so their lines land at the same
//! place on every run; their requests are recorded apart from the run's.

mod memory_support;

use memory_support::*;
use pirc_conformance::{AgentOptions, AgentRun, Gate, ModelReply};
use serde_json::{Value, json};

fn options(memory: Value) -> AgentOptions {
    AgentOptions {
        config: json!({ "features": { "observationalMemory": memory,
            "compaction": { "keepRecentTokens": 1 } } }),
        ..AgentOptions::default()
    }
    .features("observational-memory")
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_observe_and_compact() {
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
    let commands = agent.call(json!({ "type": "get_commands" })).await;
    log.note("commands", commands);
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
    let panel = agent.call(json!({ "type": "get_panel_state" })).await;
    log.note("panel after the observer", panel);
    agent.push([text("Tea it is.")]);
    log.turn(&mut agent, "second", "What do I like?").await;
    // The summary comes from memory: no summarizer request.
    let compacted = agent.call(json!({ "type": "compact" })).await;
    log.note("compact: response", compacted);
    let lines = agent.drain(QUIET).await;
    log.note("compact: lines", json!(lines));
    log.requests(&agent, "compact");
    for command in [
        "/om:status",
        "/om:view",
        "/om:view full",
        "/om:view everything",
    ] {
        log.slash(&mut agent, command).await;
    }
    let panel = agent.call(json!({ "type": "get_panel_state" })).await;
    log.note("panel after compaction", panel);
    let gate = Gate::new();
    agent.route(OBSERVER, [ModelReply::gated(&gate, text("Nothing new."))]);
    agent.push([text("You like tea.")]);
    log.turn(&mut agent, "after compaction", "What do I like again?")
        .await;
    gate.open();
    log.background_quiet(&mut agent, "observer after compaction")
        .await;
    // The context counts the memory the summary shows.
    let context = agent.call(json!({ "type": "get_context" })).await;
    log.note("context after compaction", context);
    log.session(&agent);
    insta::assert_json_snapshot!("agent_memory_observe_and_compact", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_reflect_and_drop() {
    // A pool target of 1 token: the reflection is followed by a dropper.
    let Some(mut agent) = AgentRun::start(options(json!({
        "observeAfterTokens": 5, "reflectAfterTokens": 5,
        "compactAfterTokens": 1_000_000, "observationsPoolTargetTokens": 1,
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
                observe(&[
                    (
                        "User asked to store uploads in S3.",
                        "high",
                        "2026-09-25 10:00",
                    ),
                    ("Assistant agreed to use S3.", "low", "2026-09-25 10:01"),
                    ("Bad source.", "medium", "not a time"),
                ]),
            ),
            text("Observed."),
        ],
    );
    agent.route(
        REFLECTOR,
        [
            reflect("S3", "Uploads live in S3."),
            ModelReply::tool("r2", "unknown_tool", json!({})),
            text("Done."),
        ],
    );
    agent.route(DROPPER, [drop_observations("agreed"), text("Dropped.")]);
    agent.push([text("Understood, S3 it is.")]);
    log.turn(&mut agent, "first", "Store uploads in S3, not on disk.")
        .await;
    gate.open();
    log.background(&mut agent, "consolidation", "om.observations.dropped")
        .await;
    log.slash(&mut agent, "/om:status").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_memory_reflect_and_drop", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_rate_limit_fallback() {
    let mut models = pirc_conformance::fake_models();
    models["providers"]["slow"] = json!({ "api": "openai-completions",
        "baseUrl": "https://gateway.invalid", "headers": {}, "compat": {},
        "models": [{ "id": "claude-x", "contextWindow": 100000, "maxTokens": 1000,
            "reasoning": false, "input": ["text"], "compat": {} }] });
    let Some(mut agent) = AgentRun::start(AgentOptions {
        models: Some(models),
        ..options(json!({
            "observeAfterTokens": 5, "showWorkerNotifications": false,
            "model": { "provider": "slow", "id": "claude-x" },
            "fallbackModels": [{ "provider": "fake", "id": "fake-model" }],
            "workspace": { "enabled": false },
        }))
    })
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    let by_model = || {
        ModelReply::computed(|body| {
            if body["modelId"] == "claude-x" {
                ModelReply::Failed("429 rate limit exceeded".to_owned())
            } else {
                text("Nothing new.")
            }
        })
    };
    let gate = Gate::new();
    agent.route(OBSERVER, [ModelReply::gated(&gate, by_model())]);
    agent.push([text("First.")]);
    log.turn(&mut agent, "first", "first message with content")
        .await;
    gate.open();
    log.background_quiet(&mut agent, "rate limited").await;
    let gate = Gate::new();
    agent.route(OBSERVER, [ModelReply::gated(&gate, by_model())]);
    agent.push([text("Second.")]);
    log.turn(&mut agent, "second", "second message").await;
    gate.open();
    log.background_quiet(&mut agent, "fallback").await;
    log.slash(&mut agent, "/om:status").await;
    let panel = agent.call(json!({ "type": "get_panel_state" })).await;
    log.note("panel", panel);
    insta::assert_json_snapshot!("agent_memory_rate_limit_fallback", log.into_value());
}

/// A preferred memory model the gateway does not have: by default the
/// observer runs on the session model, as before; with
/// `missingModelPolicy: "error"` no memory inference runs at all, and the
/// failure is an error in the status, not a rate limit.
async fn missing_model(policy: Option<&str>) -> Option<(Log, Vec<Value>)> {
    let mut memory = json!({
        "observeAfterTokens": 5, "showWorkerNotifications": false,
        "model": { "provider": "fake", "id": "not-on-the-gateway" },
        "workspace": { "enabled": false },
    });
    if let Some(policy) = policy {
        memory["missingModelPolicy"] = json!(policy);
    }
    let mut agent = AgentRun::start(options(memory)).await?;
    let mut log = Log::new(&agent);
    let gate = Gate::new();
    agent.route(OBSERVER, [ModelReply::gated(&gate, text("Nothing new."))]);
    agent.push([text("First.")]);
    let response = agent
        .call(json!({ "type": "prompt", "message": "first message with content" }))
        .await;
    log.note("first: response", response);
    let events = agent.settle().await;
    log.note("first: events", json!(events));
    gate.open();
    let lines = agent.drain(QUIET).await;
    log.note("background: lines", json!(lines));
    let requests = agent.take_requests();
    log.slash(&mut agent, "/om:status").await;
    Some((log, requests))
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_missing_model_falls_back() {
    let Some((log, requests)) = missing_model(None).await else {
        return;
    };
    let workers: Vec<&Value> = requests.iter().filter(|r| is_worker(r)).collect();
    assert_eq!(workers.len(), 1, "{requests:#?}");
    assert_eq!(workers[0]["modelId"], "fake-model");
    insta::assert_json_snapshot!("agent_memory_missing_model_falls_back", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_missing_model_is_an_error() {
    let Some((log, requests)) = missing_model(Some("error")).await else {
        return;
    };
    assert!(
        !requests.iter().any(is_worker),
        "no memory inference: {requests:#?}"
    );
    insta::assert_json_snapshot!("agent_memory_missing_model_is_an_error", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_auto_compaction() {
    let Some(mut agent) = AgentRun::start(options(json!({
        "compactAfterTokens": 10, "workspace": { "enabled": false },
    })))
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    // No memory worker to wait for.
    log.worker_pause = std::time::Duration::ZERO;
    // Below the threshold after one turn, above it after two. No memory
    // yet: the session's model summarizes, at once after the second run.
    agent.push([
        text("Done."),
        text("Done again."),
        text("## Goal\nSummary."),
    ]);
    log.turn(&mut agent, "first", "please do the thing").await;
    let lines = agent.drain(QUIET).await;
    log.note("below the threshold", json!(lines));
    log.turn_then_compaction(&mut agent, "second", "and the other thing")
        .await;
    let lines = agent.drain(QUIET).await;
    log.note("automatic compaction: lines", json!(lines));
    log.requests(&agent, "automatic compaction");
    log.session(&agent);
    insta::assert_json_snapshot!("agent_memory_auto_compaction", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_disabled() {
    let Some(mut agent) = AgentRun::start(options(json!({
        "enabled": false, "compactAfterTokens": 5, "observeAfterTokens": 5,
    })))
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    agent.push([text("Plain.")]);
    log.turn(&mut agent, "prompt", "no memory here").await;
    let lines = agent.drain(QUIET).await;
    log.note("afterwards", json!(lines));
    for command in ["/om:status", "/om:workspace"] {
        log.slash(&mut agent, command).await;
    }
    log.session(&agent);
    insta::assert_json_snapshot!("agent_memory_disabled", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_passive_settings() {
    // One malformed fallback resets the whole configuration to the
    // defaults (memory on); PIRC_MEMORY_PASSIVE still applies.
    let mut options = options(json!({
        "enabled": false, "showWorkerNotifications": false,
        "workspace": { "enabled": false }, "fallbackModels": [{ "provider": "fake" }],
    }));
    options
        .env
        .push(("PIRC_MEMORY_PASSIVE".to_owned(), "true".to_owned()));
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    let mut log = Log::new(&agent);
    let state = agent.call(json!({ "type": "get_state" })).await;
    log.note("state", state);
    let lines = agent.drain(QUIET).await;
    log.note("startup lines", json!(lines));
    for round in 0..2 {
        agent.push([text("Checked.")]);
        log.turn(
            &mut agent,
            &format!("round {round}"),
            &format!("configuration check {round}"),
        )
        .await;
        let panel = agent.call(json!({ "type": "get_panel_state" })).await;
        log.note(&format!("round {round}: panel"), panel);
        log.slash(&mut agent, "/om:status").await;
    }
    log.session(&agent);
    insta::assert_json_snapshot!("agent_memory_passive_settings", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_memory_unknown_settings() {
    let Some(mut agent) = AgentRun::start(options(json!({
        "enabled": false, "showWorkerNotifications": false, "oldOption": "private-value",
    })))
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    let state = agent.call(json!({ "type": "get_state" })).await;
    log.note("state", state);
    let lines = agent.drain(QUIET).await;
    log.note("startup lines", json!(lines));
    log.slash(&mut agent, "/om:status").await;
    insta::assert_json_snapshot!("agent_memory_unknown_settings", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_workspace_memory_handoff() {
    let config = json!({
        "observeAfterTokens": 5, "reflectAfterTokens": 5,
        "compactAfterTokens": 1_000_000, "showWorkerNotifications": false,
    });
    let Some(mut agent) = AgentRun::start(AgentOptions {
        prepare: Some(git_repository),
        ..options(config)
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
    log.slash(&mut agent, "/om:workspace").await;
    log.session(&agent);
    log.note("workspace ledger", json!(workspace_ledger(&agent)));
    // A new session in the same repository: the note is frozen into its
    // system prompt. It records no memory of its own.
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
    agent.push([text("Hello."), text("Again.")]);
    log.turn(&mut agent, "second session", "hi").await;
    log.turn(&mut agent, "second session again", "hi again")
        .await;
    let id = workspace_ledger(&agent)[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for command in [
        "/om:workspace view".to_owned(),
        "/om:workspace sync".to_owned(),
        format!("/om:workspace forget {id}"),
        format!("/om:workspace forget {id}"),
        "/om:workspace forget ffffffffffff".to_owned(),
        "/om:workspace forget".to_owned(),
        "/om:workspace nonsense".to_owned(),
        "/om:workspace clear".to_owned(),
        "/om:workspace".to_owned(),
    ] {
        log.slash(&mut agent, &command).await;
    }
    log.note(
        "workspace ledger at the end",
        json!(workspace_ledger(&agent)),
    );
    log.session(&agent);
    insta::assert_json_snapshot!("agent_workspace_memory_handoff", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_workspace_memory_in_directory() {
    let Some(mut agent) = AgentRun::start(AgentOptions {
        prepare: Some(seed_workspace_note),
        ..options(json!({ "showWorkerNotifications": false }))
    })
    .await
    else {
        return;
    };
    let mut log = Log::new(&agent);
    agent.push([text("Hi.")]);
    log.turn(&mut agent, "prompt", "hello").await;
    log.slash(&mut agent, "/om:workspace").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_workspace_memory_in_directory", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_workspace_memory_in_chat() {
    // Chats have no repository to hand over: the gateway's memory serves them.
    let mut options = AgentOptions {
        prepare: Some(seed_workspace_note),
        ..options(json!({ "showWorkerNotifications": false }))
    };
    options
        .env
        .push(("PIRC_WORKSPACE_KIND".to_owned(), "chat".to_owned()));
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    let mut log = Log::new(&agent);
    agent.push([text("Hi.")]);
    log.turn(&mut agent, "prompt", "hello").await;
    log.slash(&mut agent, "/om:workspace").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_workspace_memory_in_chat", log.into_value());
}
