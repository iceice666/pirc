//! Compaction in the agent alone (features off): manual, threshold and
//! overflow compactions, and their failures (`agent/compaction.ts`).

use pirc_conformance::{AgentOptions, AgentRun, ModelReply, Recorder};
use serde_json::json;

async fn turn(agent: &mut AgentRun, r: &mut Recorder, step: &str, message: &str) {
    let response = agent
        .call(json!({ "type": "prompt", "message": message }))
        .await;
    r.note(&format!("{step}: response"), response);
    let events = agent.settle().await;
    r.turn(step, agent, events);
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_manual_compaction() {
    let Some(mut agent) = AgentRun::start(AgentOptions::default()).await else {
        return;
    };
    let mut r = Recorder::new(&agent);
    let nothing = agent.call(json!({ "type": "compact" })).await;
    r.note("compact a new session", nothing);
    for (step, text) in [("first", "One"), ("second", "Two"), ("third", "Three")] {
        agent.push([ModelReply::Text(format!("Reply to {text}."))]);
        turn(&mut agent, &mut r, step, text).await;
    }
    agent.push([ModelReply::Text("## Goal\nCount to three.".to_owned())]);
    let compacted = agent
        .call(json!({ "type": "compact", "customInstructions": "Keep the numbers" }))
        .await;
    r.note("compact", compacted);
    let events = agent.until(|line| line["type"] == "compaction_end").await;
    r.note("compaction events", json!(events));
    r.requests("summary request", agent.take_requests());
    agent.push([ModelReply::Text("Four.".to_owned())]);
    turn(&mut agent, &mut r, "after compaction", "Four").await;
    let messages = agent.call(json!({ "type": "get_messages" })).await;
    r.note("messages", messages);
    // A summarizer that fails leaves the session as it was.
    agent.push([ModelReply::Failed(
        "Model provider request failed (HTTP 500).".to_owned(),
    )]);
    let failed = agent.call(json!({ "type": "compact" })).await;
    r.note("a failing summary", failed);
    let events = agent.until(|line| line["type"] == "compaction_end").await;
    r.note("failed compaction events", json!(events));
    r.requests("failed summary request", agent.take_requests());
    r.session(&agent);
    insta::assert_json_snapshot!("agent_manual_compaction", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_threshold_compaction() {
    let Some(mut agent) = AgentRun::start(AgentOptions {
        config: json!({ "features": { "compaction": { "reserveTokens": 1900,
            "keepRecentTokens": 50 } } }),
        args: vec!["--model".to_owned(), "fake/small-model".to_owned()],
        ..AgentOptions::default()
    })
    .await
    else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.push([ModelReply::Text("A first answer.".to_owned())]);
    turn(&mut agent, &mut r, "first", "Start").await;
    agent.push([
        ModelReply::Text("## Goal\nKeep going.".to_owned()),
        ModelReply::Text("A second answer.".to_owned()),
    ]);
    turn(&mut agent, &mut r, "second (compacts first)", "Continue").await;
    r.session(&agent);
    insta::assert_json_snapshot!("agent_threshold_compaction", r.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_overflow_compaction() {
    let Some(mut agent) = AgentRun::start(AgentOptions::default()).await else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.push([ModelReply::Text("Fine so far.".to_owned())]);
    turn(&mut agent, &mut r, "first", "Hello").await;
    agent.push([
        ModelReply::Failed("prompt is too long: 250000 tokens > 200000 maximum".to_owned()),
        ModelReply::Text("## Goal\nSay hello.".to_owned()),
        ModelReply::Text("Answered after compacting.".to_owned()),
    ]);
    turn(&mut agent, &mut r, "overflow", "A very long question").await;
    // A second overflow in the same run is not compacted again.
    agent.push([
        ModelReply::Failed("context length exceeded".to_owned()),
        ModelReply::Text("## Goal\nAgain.".to_owned()),
        ModelReply::Failed("context length exceeded".to_owned()),
    ]);
    turn(&mut agent, &mut r, "overflow twice", "Another long one").await;
    r.session(&agent);
    insta::assert_json_snapshot!("agent_overflow_compaction", r.into_value());
}
