//! The order of everything the agent writes, responses included: a command
//! that starts a run is answered after the run's synchronous start
//! (`agent_start` and the admitted messages), as the TS event loop ordered
//! them. The other agent transcripts leave responses out of event streams.

use pirc_conformance::{AgentOptions, AgentRun, ModelReply, Recorder};
use serde_json::{Value, json};

/// A line reduced to what identifies it in the order.
fn label(line: &Value) -> Value {
    match line["type"].as_str() {
        Some("response") => json!(format!(
            "response {} {}",
            line["command"].as_str().unwrap_or_default(),
            line["success"]
        )),
        Some("message_start" | "message_end") => json!(format!(
            "{} {}",
            line["type"].as_str().unwrap_or_default(),
            line["message"]["role"].as_str().unwrap_or_default()
        )),
        Some("message_update") => json!(format!(
            "message_update {}",
            line["assistantMessageEvent"]["type"]
                .as_str()
                .unwrap_or_default()
        )),
        Some(kind) => json!(kind),
        None => line.clone(),
    }
}

async fn lines_until_settled(agent: &mut AgentRun) -> Vec<Value> {
    agent
        .until(|line| line["type"] == "agent_settled")
        .await
        .iter()
        .map(label)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_line_order() {
    let Some(mut agent) = AgentRun::start(AgentOptions::default()).await else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.push([ModelReply::Text("Hi.".to_owned())]);
    agent
        .command(json!({ "type": "prompt", "message": "Hello" }))
        .await;
    let order = lines_until_settled(&mut agent).await;
    r.note("prompt while idle", json!(order));
    agent.push([ModelReply::Text("Steered.".to_owned())]);
    agent
        .command(json!({ "type": "steer", "message": "Now" }))
        .await;
    let order = lines_until_settled(&mut agent).await;
    r.note("steer while idle", json!(order));
    agent.push([ModelReply::Text("Delivered.".to_owned())]);
    agent
        .command(
            json!({ "type": "deliver", "message": { "customType": "note",
            "content": "From the gateway" } }),
        )
        .await;
    let order = lines_until_settled(&mut agent).await;
    r.note("deliver while idle", json!(order));
    agent.push([ModelReply::Hang("Partial".to_owned())]);
    agent
        .command(json!({ "type": "prompt", "message": "Long" }))
        .await;
    let mut order: Vec<Value> = agent
        .until(|line| line["type"] == "message_update")
        .await
        .iter()
        .map(label)
        .collect();
    agent.command(json!({ "type": "abort" })).await;
    let mut rest: Vec<Value> = agent
        .until(|line| line["type"] == "response" && line["command"] == "abort")
        .await
        .iter()
        .map(label)
        .collect();
    order.append(&mut rest);
    r.note("abort while streaming", json!(order));
    insta::assert_json_snapshot!("agent_line_order", r.into_value());
}

/// With a `beforePrompt` hook only a user message waits for the hook: a
/// delivered custom message is still admitted before the response.
#[tokio::test(flavor = "multi_thread")]
async fn agent_line_order_with_hooks() {
    let options = AgentOptions {
        config: json!({
            "hooks": { "beforePrompt": [{ "command": "echo PROMPT-HOOK-CONTEXT" }] },
        }),
        ..AgentOptions::default()
    };
    let Some(mut agent) = AgentRun::start(options).await else {
        return;
    };
    let mut r = Recorder::new(&agent);
    agent.push([ModelReply::Text("Delivered.".to_owned())]);
    agent
        .command(
            json!({ "type": "deliver", "message": { "customType": "note",
            "content": "From the gateway" } }),
        )
        .await;
    let order = lines_until_settled(&mut agent).await;
    r.note("deliver while idle", json!(order));
    agent.push([ModelReply::Text("Hi.".to_owned())]);
    agent
        .command(json!({ "type": "prompt", "message": "Hello" }))
        .await;
    let order = lines_until_settled(&mut agent).await;
    r.note("prompt while idle", json!(order));
    insta::assert_json_snapshot!("agent_line_order_with_hooks", r.into_value());
}
