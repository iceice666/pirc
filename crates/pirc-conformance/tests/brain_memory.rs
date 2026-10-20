//! The brain's memory (plans/rewrite/03-memory.md): it remembers a fact
//! without asking and says so in the room, with what undoes it; the next
//! turn about it brings the fact back without a search ("You may
//! remember"); "don't keep this" forgets it for real (the record, the
//! search index and the room's line) and the same text is refused; a fact
//! written after the brain read a tool result carries that tool as its
//! origin; a preference needs the person's own words. No node.

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Reply, Transcript, WebSocket, browser_headers,
};
use serde_json::{Value, json};

/// Room frames until the host face went idle once, as `(type, what matters
/// of it)`; a streaming reply's updates are left out.
async fn until_idle(socket: &mut WebSocket) -> Value {
    let frames = socket
        .until(|frame| frame["type"] == "brain_presence" && frame["data"]["state"] == "idle")
        .await;
    let mut out: Vec<Value> = Vec::new();
    for frame in frames {
        let kind = frame["type"].as_str().unwrap_or_default().to_owned();
        let message = &frame["data"]["message"];
        match kind.as_str() {
            "room_message" | "room_message_updated" => {}
            _ => continue,
        }
        if message["body"]["streaming"] == json!(true) || message["speaker"] == "user" {
            continue;
        }
        // A reply's last write is a new message or an update, depending on
        // how fast it streamed: either is the reply.
        out.push(json!({ "kind": message["kind"], "body": message["body"] }));
    }
    json!(out)
}

async fn send(api: &Api, text: &str) {
    let sent = api
        .send(
            "POST",
            "/api/rooms/general/messages",
            &browser_headers(),
            Some(json!({ "text": text, "immediate": true })),
        )
        .await;
    assert_eq!(sent.status, 201, "{:?}", sent.body);
}

/// The system prompt of a model call.
fn system_prompt(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "system" || message["role"] == "developer")
        .map(|message| match &message["content"] {
            Value::String(text) => text.clone(),
            content => content[0]["text"].as_str().unwrap_or_default().to_owned(),
        })
        .unwrap_or_default()
}

/// The prompt's section that starts with `## <title>`, without the
/// ids (random) of what it lists.
fn section(prompt: &str, title: &str) -> Value {
    let start = format!("## {title}");
    let Some(at) = prompt.find(&start) else {
        return Value::Null;
    };
    let text = &prompt[at..];
    let end = text[start.len()..]
        .find("\n\n## ")
        .map_or(text.len(), |end| end + start.len());
    json!(
        text[..end]
            .lines()
            .map(|line| match line.strip_prefix("- [") {
                Some(rest) => format!("- [id]{}", &rest[rest.find(']').map_or(0, |at| at + 1)..]),
                None => line.to_owned(),
            })
            .collect::<Vec<_>>()
    )
}

/// The tool results the latest model call was given.
fn tool_results(request: &Value) -> Value {
    json!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "tool")
            .map(|message| message["content"].clone())
            .collect::<Vec<_>>()
    )
}

/// The transcript with what each run makes up replaced: fact ids (12 hex),
/// preference ids (`p` and 8 hex), the brain's session entry ids and local
/// times, numbered in order of appearance.
fn stable(value: Value) -> Value {
    let text = value.to_string();
    let mut out = text.clone();
    for (kind, pattern) in [
        ("fact", r#"\b[0-9a-f]{12}\b"#),
        ("preference", r#"\bp[0-9a-f]{8}\b"#),
        ("entry", r#""[0-9a-f]{8}""#),
        ("local-time", r#"\d{4}-\d{2}-\d{2} \d{2}:\d{2}"#),
    ] {
        let regex = regex::Regex::new(pattern).unwrap();
        let mut seen: Vec<String> = Vec::new();
        for found in regex.find_iter(&text) {
            if !seen.iter().any(|known| known == found.as_str()) {
                seen.push(found.as_str().to_owned());
            }
        }
        for (index, found) in seen.iter().enumerate() {
            let placeholder = match kind {
                "local-time" => "<local-time>".to_owned(),
                "entry" => format!("\"<entry:{}>\"", index + 1),
                _ => format!("<{kind}:{}>", index + 1),
            };
            out = out.replace(found.as_str(), &placeholder);
        }
    }
    serde_json::from_str(&out).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn brain_memory() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        without_node: true,
        ..Default::default()
    })
    .await
    else {
        return;
    };
    let config = cluster.dir.path().join("gateway-config");
    std::fs::write(config.join("brain.json"), r#"{ "debounceSeconds": 0.2 }"#).unwrap();
    let api = cluster.api();
    let me = browser_headers();
    let mut t = Transcript::new(cluster.volatile());
    let mut socket = api.connect("/api/events?rooms=1", &me).await.open();
    socket.next_json().await.expect("ready");

    // Remembered without asking, said in the room.
    cluster.llm.push([
        Reply::Tool {
            id: "call_1".into(),
            name: "remember".into(),
            args: json!({ "fact": "Uses TLP for power management" }),
        },
        Reply::Text("Noted.".to_owned()),
    ]);
    send(
        &api,
        "I use TLP for power management, not power-profiles-daemon",
    )
    .await;
    t.note(
        "a fact, and the line that says so",
        until_idle(&mut socket).await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "the first call's tools and preferences",
        json!({
            "tools": requests[0]["tools"].as_array().unwrap().iter()
                .map(|tool| tool["function"]["name"].clone()).collect::<Vec<_>>(),
            "preferences": section(&system_prompt(&requests[0]), "Preferences"),
            "toolResult": tool_results(&requests[1]),
        }),
    );
    let facts = api.send("GET", "/api/memory/records", &me, None).await;
    t.response("the facts", "GET /api/memory/records", &facts);
    let id = facts.body["records"][0]["id"].as_str().unwrap().to_owned();
    let searched = api
        .send(
            "GET",
            "/api/memory/records?q=%E9%9B%BB%E6%BA%90%20tlp",
            &me,
            None,
        )
        .await;
    t.response(
        "found by its words",
        "GET /api/memory/records?q=電源 tlp",
        &searched,
    );

    // The next turn about it has it in the prompt.
    cluster.llm.push([Reply::Text("You use TLP.".to_owned())]);
    send(&api, "what do I use on the laptop for power?").await;
    until_idle(&mut socket).await;
    let requests = cluster.llm.requests();
    t.note(
        "recalled before the turn",
        section(&system_prompt(&requests[2]), "You may remember"),
    );
    let context = api
        .send("GET", "/api/brain/context?room=general", &me, None)
        .await;
    t.note(
        "the context's sections",
        json!(
            context.body["context"]["sections"]
                .as_array()
                .unwrap()
                .iter()
                .map(|section| json!([section["id"], section["source"]]))
                .collect::<Vec<_>>()
        ),
    );

    // "Don't keep this": forgotten everywhere, and refused from then on.
    let forgotten = api
        .send("DELETE", &format!("/api/memory/records/{id}"), &me, None)
        .await;
    t.response(
        "don't keep this",
        "DELETE /api/memory/records/:id",
        &forgotten,
    );
    let updated = socket
        .until(|frame| frame["type"] == "room_message_updated")
        .await;
    t.note(
        "the line no longer says it",
        updated.last().unwrap()["data"]["message"]["body"].clone(),
    );
    let gone = api
        .send("GET", "/api/memory/records?q=tlp", &me, None)
        .await;
    t.response("not found any more", "GET /api/memory/records?q=tlp", &gone);
    cluster.llm.push([
        Reply::Tool {
            id: "call_2".into(),
            name: "remember".into(),
            args: json!({ "fact": "uses TLP for  power management" }),
        },
        Reply::Text("Understood.".to_owned()),
    ]);
    send(&api, "remember that I use TLP").await;
    t.note("remembering it again", until_idle(&mut socket).await);
    let requests = cluster.llm.requests();
    t.note("is refused", tool_results(requests.last().unwrap()));

    // Read from a tool: the fact says so.
    cluster.llm.push([
        Reply::Tool {
            id: "call_3".into(),
            name: "memory_search".into(),
            args: json!({ "query": "laptop", "scope": "all" }),
        },
        Reply::Tool {
            id: "call_4".into(),
            name: "remember".into(),
            args: json!({ "fact": "The laptop is a ThinkPad X1 Carbon" }),
        },
        Reply::Text("Done.".to_owned()),
    ]);
    send(&api, "look up what you know about my laptop").await;
    t.note("a fact after a tool result", until_idle(&mut socket).await);

    // A preference needs the person's words.
    cluster.llm.push([
        Reply::Tool {
            id: "call_5".into(),
            name: "save_preference".into(),
            args: json!({ "preference": "Prefers short answers", "quote": "short answers always" }),
        },
        Reply::Tool {
            id: "call_6".into(),
            name: "save_preference".into(),
            args: json!({ "preference": "Prefers short answers", "quote": "keep it short" }),
        },
        Reply::Text("Will do.".to_owned()),
    ]);
    send(&api, "please keep it short from now on").await;
    t.note("a preference", until_idle(&mut socket).await);
    let requests = cluster.llm.requests();
    t.note(
        "a made-up quote is refused, theirs is not",
        tool_results(requests.last().unwrap()),
    );
    let page = api.send("GET", "/api/memory/preferences", &me, None).await;
    t.response("the preferences", "GET /api/memory/preferences", &page);
    let preference = page.body["preferences"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let history = api
        .send(
            "GET",
            &format!("/api/memory/preferences/{preference}/history"),
            &me,
            None,
        )
        .await;
    t.response(
        "its history",
        "GET /api/memory/preferences/:id/history",
        &history,
    );
    let removed = api
        .send(
            "POST",
            &format!("/api/memory/preferences/{preference}/remove"),
            &me,
            None,
        )
        .await;
    t.response(
        "removed from the prompt",
        "POST /api/memory/preferences/:id/remove",
        &removed,
    );
    for (step, method, path) in [
        (
            "an unknown fact",
            "DELETE",
            "/api/memory/records/000000000000",
        ),
        (
            "a scope that is not one",
            "GET",
            "/api/memory/records?scope=nope",
        ),
        ("a limit too high", "GET", "/api/memory/records?limit=101"),
    ] {
        let refused = api.send(method, path, &me, None).await;
        t.response(step, &format!("{method} {path}"), &refused);
    }

    insta::assert_json_snapshot!("brain_memory", stable(t.into_value()));
}
