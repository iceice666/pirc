//! The brain (plans/rewrite/02-brain-host.md): the gateway answers in the
//! rooms with its own model calls. Three short messages make one turn, a
//! message sent while it answers is steered into the same turn, a new
//! `SOUL.md` applies to the next turn, and a turn that runs too long is
//! stopped. No node: the brain needs none.

use std::sync::Arc;
use std::time::Duration;

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Reply, Transcript, WebSocket, browser_headers,
};
use serde_json::{Value, json};

/// The brain's turn limit here (the default is 10 minutes).
const TURN_TIMEOUT_MS: u64 = 3_000;

/// Room frames until the host face went idle `count` times, as
/// `(type, what matters of it)`; a streaming reply's repeated updates
/// count once.
async fn until_idle(socket: &mut WebSocket, count: usize) -> Value {
    let mut idle = 0;
    let frames = socket
        .until(|frame| {
            idle +=
                usize::from(frame["type"] == "brain_presence" && frame["data"]["state"] == "idle");
            idle == count
        })
        .await;
    let mut out: Vec<Value> = Vec::new();
    for frame in frames {
        let kind = frame["type"].as_str().unwrap_or_default().to_owned();
        let summary = match kind.as_str() {
            "brain_presence" => frame["data"]["state"].clone(),
            "room_message" | "room_message_updated" => {
                let message = &frame["data"]["message"];
                json!({ "speaker": message["speaker"], "kind": message["kind"],
                    "body": message["body"], "edited": !message["editedAt"].is_null() })
            }
            _ => continue,
        };
        let entry = json!([kind, summary]);
        let repeat = kind == "room_message_updated"
            && out
                .last()
                .is_some_and(|last| last[0] == "room_message_updated")
            && summary["body"]["streaming"] == json!(true);
        if !repeat {
            out.push(entry);
        }
    }
    json!(out)
}

async fn send(api: &Api, text: &str, immediate: bool) {
    let sent = api
        .send(
            "POST",
            "/api/rooms/general/messages",
            &browser_headers(),
            Some(json!({ "text": text, "immediate": immediate })),
        )
        .await;
    assert_eq!(sent.status, 201, "{:?}", sent.body);
}

async fn turns(api: &Api) -> Vec<Value> {
    api.send(
        "GET",
        "/api/brain/turns?room=general",
        &browser_headers(),
        None,
    )
    .await
    .body["turns"]
        .as_array()
        .unwrap()
        .clone()
}

/// What the brain's latest model call was given: the start of its system
/// prompt and its last user message.
fn asked(request: &Value) -> Value {
    let messages = request["messages"].as_array().unwrap();
    let system = messages
        .iter()
        .find(|message| message["role"] == "system" || message["role"] == "developer")
        .map(|message| match &message["content"] {
            Value::String(text) => text.clone(),
            content => content[0]["text"].as_str().unwrap_or_default().to_owned(),
        })
        .unwrap_or_default();
    let user = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .map(|message| message["content"].clone())
        .unwrap_or_default();
    let tools: Vec<Value> = request
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|tool| tool["function"]["name"].clone())
        .collect();
    json!({ "systemStart": system.lines().next(), "lastUser": user, "tools": tools })
}

async fn poll(what: &str, mut done: impl AsyncFnMut() -> bool) {
    for _ in 0..200 {
        if done().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn brain() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        without_node: true,
        env: vec![("PIRC_BRAIN_TURN_TIMEOUT_MS", TURN_TIMEOUT_MS.to_string())],
        ..Default::default()
    })
    .await
    else {
        return;
    };
    let config = cluster.dir.path().join("gateway-config");
    // Short enough for a test, long enough for three sends in a row.
    std::fs::write(config.join("brain.json"), r#"{ "debounceSeconds": 0.5 }"#).unwrap();
    let api = cluster.api();
    let me = browser_headers();
    let mut t = Transcript::new(cluster.volatile());
    let mut socket = api.connect("/api/events?rooms=1", &me).await.open();
    let ready = socket.next_json().await.expect("ready");
    t.note("no face is thinking yet", ready["presence"].clone());

    let prompts = api.send("GET", "/api/brain/prompts", &me, None).await;
    t.response(
        "the prompts start empty",
        "GET /api/brain/prompts",
        &prompts,
    );
    let soul = api
        .send(
            "PUT",
            "/api/brain/prompts/soul",
            &me,
            Some(json!({ "text": "You are Mo, the house's helper.\r\n" })),
        )
        .await;
    t.response("a persona", "PUT /api/brain/prompts/soul", &soul);
    let unknown = api
        .send(
            "PUT",
            "/api/brain/prompts/other",
            &me,
            Some(json!({ "text": "x" })),
        )
        .await;
    t.response(
        "only soul and chat",
        "PUT /api/brain/prompts/other",
        &unknown,
    );

    // Three short messages in a row: one turn.
    cluster
        .llm
        .push([Reply::Text("Three things, one answer.".to_owned())]);
    for text in ["SlimeOS", "PR#123", "怎樣了？"] {
        send(&api, text, false).await;
    }
    t.note(
        "one reply, streamed, between thinking and idle",
        until_idle(&mut socket, 1).await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "one model call with all three, as the new persona",
        json!({ "calls": requests.len(), "asked": asked(&requests[0]) }),
    );

    // A message sent while it answers joins the same turn.
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    cluster.llm.push([
        Reply::Held(gate.clone(), "First answer.".to_owned()),
        Reply::Text("And the second.".to_owned()),
    ]);
    send(&api, "first", true).await;
    poll("the model call", async || cluster.llm.requests().len() == 2).await;
    send(&api, "second", false).await;
    poll("the steer", async || {
        turns(&api).await[0]["messageIds"].as_array().unwrap().len() == 2
    })
    .await;
    gate.add_permits(1);
    t.note("two replies in one turn", until_idle(&mut socket, 1).await);
    let requests = cluster.llm.requests();
    t.note(
        "the steer's model call",
        json!({ "calls": requests.len(), "asked": asked(&requests[2]) }),
    );

    // Too long: stopped, with a line.
    cluster.llm.push([Reply::Held(
        Arc::new(tokio::sync::Semaphore::new(0)),
        "never".to_owned(),
    )]);
    send(&api, "think hard", true).await;
    t.note("stopped after the limit", until_idle(&mut socket, 1).await);

    let listed = api
        .send("GET", "/api/brain/turns?room=general", &me, None)
        .await;
    t.response(
        "the turns, newest first",
        "GET /api/brain/turns?room=general",
        &listed,
    );
    let context = api
        .send("GET", "/api/brain/context?room=general", &me, None)
        .await;
    let snapshot = &context.body["context"];
    t.note(
        "the latest call's context",
        json!({
            "status": context.status,
            "model": snapshot["model"],
            "sections": snapshot["sections"].as_array().unwrap().iter()
                .map(|section| json!([section["id"], section["source"]])).collect::<Vec<_>>(),
            "tools": snapshot["tools"].as_array().unwrap().iter()
                .map(|tool| tool["name"].clone()).collect::<Vec<_>>(),
        }),
    );
    for (step, path) in [
        ("turns need a room", "/api/brain/turns"),
        ("of a room that is there", "/api/brain/turns?room=nope"),
        ("so does the context", "/api/brain/context"),
    ] {
        let refused = api.send("GET", path, &me, None).await;
        t.response(step, &format!("GET {path}"), &refused);
    }

    insta::assert_json_snapshot!("brain", t.into_value());
}
