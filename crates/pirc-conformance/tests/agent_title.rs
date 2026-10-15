//! Automatic session titles (`agent/features/title.ts`, feature
//! `session-title`), with the test playing the agent's node: the side
//! request that names a session from its first real message, greetings
//! skipped, failed and declined attempts retried, the settings, and the
//! sessions it leaves alone (named by the user, headless, disabled). The
//! M5 target of the agent port (docs/history/rust-rewrite.md).
//!
//! The title request runs next to the run's own model call. Its reply is
//! routed by the `<user-message>` marker and held by a gate until the run
//! settled, so the name change lands at the same place on every run.

use pirc_conformance::{AgentOptions, AgentRun, Gate, ModelReply, Recorder};
use serde_json::{Value, json};

const MARKER: &str = "<user-message>";

fn is_title(request: &Value) -> bool {
    request["messages"].to_string().contains(MARKER)
}

fn text(value: &str) -> ModelReply {
    ModelReply::Text(value.to_owned())
}

fn options(config: Value) -> AgentOptions {
    AgentOptions {
        config,
        ..AgentOptions::default()
    }
    .features("session-title")
}

/// The requests since the last call: the run's own (system prompt and
/// tools shown when they change), then the title requests apart.
fn requests(agent: &AgentRun, r: &mut Recorder, step: &str) {
    let (titles, others): (Vec<Value>, Vec<Value>) =
        agent.take_requests().into_iter().partition(is_title);
    r.requests(&format!("{step}: model requests"), others);
    r.note(&format!("{step}: title requests"), json!(titles));
}

/// A prompt and everything until the run settles; a gated title reply is
/// let go afterwards and its name change awaited.
async fn turn(
    agent: &mut AgentRun,
    r: &mut Recorder,
    step: &str,
    message: &str,
    title: Option<&Gate>,
) {
    let response = agent
        .call(json!({ "type": "prompt", "message": message }))
        .await;
    r.note(&format!("{step}: response"), response);
    let mut events = agent.settle().await;
    if let Some(gate) = title {
        gate.open();
        events.extend(
            agent
                .until(|line| line["type"] == "session_name_changed")
                .await,
        );
    }
    r.note(&format!("{step}: events"), json!(events));
    requests(agent, r, step);
}

/// Long enough for an ungated (failed) title request to have ended.
async fn pause() {
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_session_title() {
    let Some(mut agent) = AgentRun::start(options(
        json!({ "features": { "sessionTitle": { "enabled": true } } }),
    ))
    .await
    else {
        return;
    };
    let mut r = Recorder::new(&agent);
    // Greetings, numbers and emoji name nothing: no title request.
    agent.push([text("Hello there."), text("Fine."), text("Yes.")]);
    turn(&mut agent, &mut r, "greeting", "hi", None).await;
    turn(&mut agent, &mut r, "a number", "  42. ", None).await;
    turn(&mut agent, &mut r, "emoji", "👍🎉!", None).await;
    let gate = Gate::new();
    agent.route(
        MARKER,
        [ModelReply::gated(
            &gate,
            text("<think>scratch</think>\n<title> \"Refactor the runner.\" </title>"),
        )],
    );
    agent.push([text("On it.")]);
    turn(
        &mut agent,
        &mut r,
        "first real message",
        "please refactor the runner module",
        Some(&gate),
    )
    .await;
    let state = agent.call(json!({ "type": "get_state" })).await;
    r.note("state", state);
    // Named once: later messages make no title request.
    agent.push([text("Tests added.")]);
    turn(
        &mut agent,
        &mut r,
        "later message",
        "now add tests for it",
        None,
    )
    .await;
    r.session(&agent);
    r.note("exit code", json!(agent.finish().await));
    insta::assert_json_snapshot!("agent_session_title", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_title_retry() {
    // Settings that do not fit the schema count as the defaults.
    let Some(mut agent) = AgentRun::start(options(
        json!({ "features": { "sessionTitle": { "enabled": "yes", "maxAttempts": 0 } } }),
    ))
    .await
    else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.route(
        MARKER,
        [ModelReply::Failed(
            "Model provider request failed (HTTP 400).".to_owned(),
        )],
    );
    agent.push([text("Upgrading.")]);
    turn(
        &mut agent,
        &mut r,
        "failed attempt",
        "upgrade the dependencies",
        None,
    )
    .await;
    pause().await;
    let gate = Gate::new();
    agent.route(
        MARKER,
        [ModelReply::gated(
            &gate,
            text("```json\n{\"title\": \"Upgrade dependencies\"}\n```"),
        )],
    );
    agent.push([text("Again.")]);
    turn(
        &mut agent,
        &mut r,
        "retry",
        "upgrade the dependencies, again",
        Some(&gate),
    )
    .await;
    r.session(&agent);
    insta::assert_json_snapshot!("agent_title_retry", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_title_settings() {
    // Another model, a custom prompt, and two attempts: one fails, one
    // declines, then no more requests.
    let Some(mut agent) = AgentRun::start(options(json!({ "features": { "sessionTitle": {
        "model": { "provider": "fake", "id": "small-model" },
        "prompt": "  Name chats in French.  ",
        "maxAttempts": 2,
    } } })))
    .await
    else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.route(MARKER, [ModelReply::Error("inference_failed".to_owned())]);
    agent.push([text("One.")]);
    let long = format!("explain {}", "the build system ".repeat(150));
    turn(&mut agent, &mut r, "failed attempt", &long, None).await;
    pause().await;
    agent.route(MARKER, [text("<title>none</title>")]);
    agent.push([text("Two.")]);
    turn(
        &mut agent,
        &mut r,
        "declined",
        "write the release notes",
        None,
    )
    .await;
    pause().await;
    agent.push([text("Three.")]);
    turn(
        &mut agent,
        &mut r,
        "no attempts left",
        "fix the flaky test",
        None,
    )
    .await;
    let state = agent.call(json!({ "type": "get_state" })).await;
    r.note("state", state);
    insta::assert_json_snapshot!("agent_title_settings", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_title_named_by_user() {
    let Some(mut agent) = AgentRun::start(options(json!({}))).await else {
        return;
    };
    let mut r = Recorder::new(&agent);
    let named = agent
        .call(json!({ "type": "set_session_name", "name": "Mine" }))
        .await;
    r.note("name the session", named);
    agent.push([text("Fixing.")]);
    turn(
        &mut agent,
        &mut r,
        "prompt",
        "fix the flaky upload test",
        None,
    )
    .await;
    r.session(&agent);
    insta::assert_json_snapshot!("agent_title_named_by_user", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_title_headless() {
    // Team sub-agents run headless and are never shown in the session list.
    let Some(mut agent) = AgentRun::start(AgentOptions {
        args: vec!["--headless".to_owned()],
        ..options(json!({}))
    })
    .await
    else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.push([text("Written.")]);
    turn(
        &mut agent,
        &mut r,
        "prompt",
        "write the release notes",
        None,
    )
    .await;
    pause().await;
    requests(&agent, &mut r, "afterwards");
    insta::assert_json_snapshot!("agent_title_headless", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_title_disabled() {
    let Some(mut agent) = AgentRun::start(options(
        json!({ "features": { "sessionTitle": { "enabled": false } } }),
    ))
    .await
    else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.push([text("Written.")]);
    turn(
        &mut agent,
        &mut r,
        "prompt",
        "write the release notes",
        None,
    )
    .await;
    pause().await;
    requests(&agent, &mut r, "afterwards");
    insta::assert_json_snapshot!("agent_title_disabled", r.into_value());
}
