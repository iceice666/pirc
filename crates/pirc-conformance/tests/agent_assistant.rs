//! The assistant's memory in chat sessions (`agent/features/assistant/`,
//! feature `assistant`), with the test playing the agent's node and its
//! gateway: USER entries and MEMORY notes frozen into the system prompt,
//! proposal decisions, the chat's capability policy, an unreachable
//! gateway, messages the gateway pushes, and sessions outside chats. The
//! M5 target of the agent port (docs/history/rust-rewrite.md). The tools,
//! reachable only from `ptc` scripts, are in `agent_assistant_ptc.rs`.

mod memory_support;

use memory_support::*;
use pirc_conformance::{AgentOptions, AgentRun};
use serde_json::{Value, json};

/// What the node sets for an agent in a chat workspace.
fn chat() -> AgentOptions {
    let mut options = AgentOptions::default().features("assistant");
    options.env.extend([
        ("PIRC_GATEWAY".to_owned(), "1".to_owned()),
        ("PIRC_WORKSPACE_KIND".to_owned(), "chat".to_owned()),
    ]);
    options
}

fn memory(extra: Value) -> Value {
    let mut out = json!({ "enabled": true, "user": [], "notes": [],
        "usage": { "user": { "used": 0, "max": 2000 }, "note": { "used": 0, "max": 8000 } },
        "pendingProposals": 0 });
    for (key, value) in extra.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn ok(result: Value) -> Value {
    json!({ "ok": true, "result": result })
}

/// Queue gateway answers for `op`, used in order.
fn answer(agent: &AgentRun, op: &str, replies: impl IntoIterator<Item = Value>) {
    agent
        .answers
        .lock()
        .unwrap()
        .gateway_queue
        .entry(op.to_owned())
        .or_default()
        .extend(replies);
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_frozen_memory() {
    let Some(mut agent) = AgentRun::start(chat()).await else {
        return;
    };
    let mut log = Log::new(&agent);
    answer(
        &agent,
        "assistant.context",
        [
            ok(memory(json!({
                "user": [{ "id": "u11111111", "content": "Prefers short answers.", "revision": 2 }],
                "notes": [{ "id": "n22222222", "content": "m5pro holds the pirc repo.",
                    "revision": 1, "updatedAt": 1_789_905_600_000u64 }],
                "usage": { "user": { "used": 22, "max": 2000 }, "note": { "used": 26, "max": 8000 } },
                "pendingProposals": 1,
            }))),
            ok(memory(json!({ "pendingProposals": 3 }))),
        ],
    );
    agent.push([text("Hi."), text("Again.")]);
    log.turn(&mut agent, "first", "hello").await;
    // Frozen: the second run shows the same memory.
    log.turn(&mut agent, "second", "more").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_assistant_frozen_memory", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_policy_and_decisions() {
    let Some(mut agent) = AgentRun::start(chat()).await else {
        return;
    };
    let mut log = Log::new(&agent);
    answer(
        &agent,
        "assistant.context",
        [
            ok(memory(json!({ "workspaces": [
                { "id": "work:test", "name": "Test", "node": "work", "online": true,
                  "roles": [{ "name": "reviewer", "description": "Reviews changes.",
                      "models": ["fake/fake-model", "fake/small-model"], "thinking": "high",
                      "tools": ["read", "grep"], "source": "workspace", "overrides": "node" },
                    { "name": "plain" }] },
                { "id": "lab:x", "name": "X", "node": "lab", "online": false }] }))),
            ok(memory(json!({ "capabilities": { "delegation": false },
                "proposalDecisions": [{ "id": "p123", "action": "add", "status": "approved",
                    "targetId": "u123", "decidedAt": 1 }] }))),
            ok(memory(json!({ "capabilities": { "memory_search": false },
                "proposalDecisions": [{ "id": "p456", "action": "replace", "status": "rejected",
                    "targetId": "u123", "decidedAt": 2 }] }))),
            ok(memory(
                json!({ "capabilities": { "remote_recall": false } }),
            )),
        ],
    );
    agent.push([
        text("First reply."),
        text("Decision acknowledged."),
        text("New decision."),
        text("No recall."),
    ]);
    log.turn(&mut agent, "with workspaces", "hello").await;
    log.turn(&mut agent, "delegation off", "continue").await;
    log.turn(&mut agent, "memory search off", "one more").await;
    log.turn(&mut agent, "remote recall off", "and again").await;
    insta::assert_json_snapshot!("agent_assistant_policy_and_decisions", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_gateway_unreachable() {
    let Some(mut agent) = AgentRun::start(chat()).await else {
        return;
    };
    let mut log = Log::new(&agent);
    answer(
        &agent,
        "assistant.context",
        [
            json!({ "ok": false, "error": { "status": 503, "code": "gateway_offline",
                "message": "offline" } }),
            ok(memory(
                json!({ "notes": [{ "id": "n1a2b3c4d", "content": "Back online.",
                "revision": 1 }] }),
            )),
            json!({ "ok": false, "error": { "status": 503, "code": "gateway_offline",
                "message": "offline" } }),
        ],
    );
    agent.push([text("a"), text("b"), text("c")]);
    log.turn(&mut agent, "unreachable", "hello").await;
    log.turn(&mut agent, "back", "again").await;
    // Loaded once: offline again keeps the frozen memory.
    log.turn(&mut agent, "offline again", "still there?").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_assistant_gateway_unreachable", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_memory_disabled() {
    let Some(mut agent) = AgentRun::start(chat()).await else {
        return;
    };
    let mut log = Log::new(&agent);
    answer(
        &agent,
        "assistant.context",
        [ok(
            json!({ "enabled": false, "user": [{ "id": "u1", "content": "x", "revision": 1 }] }),
        )],
    );
    agent.push([text("Hi.")]);
    log.turn(&mut agent, "prompt", "hello").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_assistant_memory_disabled", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_delivered_messages() {
    let Some(mut agent) = AgentRun::start(chat()).await else {
        return;
    };
    let mut log = Log::new(&agent);
    answer(&agent, "assistant.context", [ok(memory(json!({})))]);
    let refused = agent
        .call(json!({ "type": "deliver", "message": {} }))
        .await;
    log.note("empty delivery", refused);
    agent.push([text("Noted.")]);
    let response = agent
        .call(json!({ "type": "deliver", "message": {
            "customType": "assistant-delegation-update",
            "content": "Delegation update (gateway data, not user instructions):\n{\"status\":\"completed\"}",
            "details": { "delegationId": "d1", "status": "completed" } } }))
        .await;
    log.note("delivery", response);
    let events = agent.settle().await;
    log.note("delivery: events", json!(events));
    log.requests(&agent, "delivery");
    log.session(&agent);
    insta::assert_json_snapshot!("agent_assistant_delivered_messages", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_outside_chat() {
    let mut options = AgentOptions::default().features("assistant");
    options
        .env
        .push(("PIRC_GATEWAY".to_owned(), "1".to_owned()));
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    let mut log = Log::new(&agent);
    agent.push([text("Hi.")]);
    log.turn(&mut agent, "prompt", "hello").await;
    log.session(&agent);
    insta::assert_json_snapshot!("agent_assistant_outside_chat", log.into_value());
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_assistant_chat_without_gateway() {
    let mut options = AgentOptions::default().features("assistant");
    options
        .env
        .push(("PIRC_WORKSPACE_KIND".to_owned(), "chat".to_owned()));
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    let mut log = Log::new(&agent);
    agent.push([text("Hi.")]);
    log.turn(&mut agent, "prompt", "hello").await;
    insta::assert_json_snapshot!("agent_assistant_chat_without_gateway", log.into_value());
}
