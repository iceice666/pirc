//! Waking up (plans/rewrite/05-self-wake.md): an open loop's time comes
//! and the brain wakes and says so with `speak`, then the loop closes
//! itself; a wake that finds nothing leaves nothing in the room; a person's
//! message takes over a running wake, which comes back after that turn,
//! once; the brain says it will come back and the room can cancel it; past
//! the day's wakes (2 here) one does not start. A wake's tools have
//! `speak`, a conversation's do not. No node.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Reply, Transcript, WebSocket, browser_headers,
};
use serde_json::{Value, json};

/// What a frame says, if anything this scenario records: what the host
/// wrote (streaming updates left out), loops and wakes that changed.
fn said(frame: &Value) -> Option<Value> {
    let message = &frame["data"]["message"];
    match frame["type"].as_str()? {
        "room_message" | "room_message_updated"
            if message["body"]["streaming"] != json!(true) && message["speaker"] != "user" =>
        {
            Some(json!({ "kind": message["kind"], "body": message["body"] }))
        }
        "loop_changed" => {
            let changed = &frame["data"]["loop"];
            Some(json!({ "loop_changed": [changed["what"], changed["status"]] }))
        }
        "wake_changed" => {
            let wake = &frame["data"]["wake"];
            Some(json!({ "wake_changed": {
                "kind": wake["kind"],
                "attempt": wake["attempt"],
                "started": !wake["startedAt"].is_null(),
                "outcome": wake["outcome"],
                "note": wake["note"],
            } }))
        }
        _ => None,
    }
}

/// Frames until `done`, as [`said`] tells them.
async fn until(socket: &mut WebSocket, done: impl FnMut(&Value) -> bool) -> Value {
    json!(
        socket
            .until(done)
            .await
            .iter()
            .filter_map(said)
            .collect::<Vec<_>>()
    )
}

/// A wake ended (with any outcome but `preempted`, when `final_only`).
fn wake_ended(frame: &Value, final_only: bool) -> bool {
    let outcome = &frame["data"]["wake"]["outcome"];
    frame["type"] == "wake_changed" && !outcome.is_null() && !(final_only && outcome == "preempted")
}

fn host_idle(frame: &Value) -> bool {
    frame["type"] == "brain_presence" && frame["data"]["state"] == "idle"
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

/// The tools of a model call, and its last user message.
fn asked(request: &Value) -> Value {
    let messages = request["messages"].as_array().unwrap();
    let user = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .map(|message| match &message["content"] {
            Value::String(text) => json!(text),
            content => content[0]["text"].clone(),
        })
        .unwrap_or_default();
    let tools: Vec<Value> = request
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|tool| tool["function"]["name"].clone())
        .collect();
    json!({ "lastUser": user, "tools": tools })
}

/// UTC `YYYY-MM-DDTHH:MM:SSZ`, `seconds` from now.
fn iso_in(seconds: u64) -> String {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + seconds;
    let (days, rest) = ((unix / 86_400) as i64, unix % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

/// The transcript with what each run makes up replaced: loop ids (`l` and
/// 8 hex), fact ids (12 hex), the brain's session entry ids, local times
/// and weekdays.
fn stable(value: Value) -> Value {
    let text = value.to_string();
    let mut out = text.clone();
    for (kind, pattern) in [
        ("loop", r#"\bl[0-9a-f]{8}\b"#),
        ("fact", r#"\b[0-9a-f]{12}\b"#),
        ("entry", r#""[0-9a-f]{8}""#),
        ("local-time", r#"\d{4}-\d{2}-\d{2} \d{2}:\d{2}"#),
        ("weekday", r#"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) <"#),
    ] {
        let regex = regex::Regex::new(pattern).unwrap();
        let mut seen: Vec<String> = Vec::new();
        for found in regex.find_iter(&out.clone()) {
            if !seen.iter().any(|known| known == found.as_str()) {
                seen.push(found.as_str().to_owned());
            }
        }
        for (index, found) in seen.iter().enumerate() {
            let placeholder = match kind {
                "local-time" => "<local-time>".to_owned(),
                "weekday" => "<weekday> <".to_owned(),
                "entry" => format!("\"<entry:{}>\"", index + 1),
                _ => format!("<{kind}:{}>", index + 1),
            };
            out = out.replace(found.as_str(), &placeholder);
        }
    }
    serde_json::from_str(&out).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn brain_wake() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        without_node: true,
        env: vec![("PIRC_WAKES_PER_DAY", "2".to_owned())],
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

    // A time that is the thing itself: the brain wakes, says it, and the
    // loop closes once the wake is over.
    cluster.llm.push([
        Reply::Tool {
            id: "call_1".into(),
            name: "open_loop".into(),
            args: json!({
                "what": "Drink water",
                "anchor": { "at": iso_in(3), "autoClose": true },
            }),
        },
        Reply::Text("I'll remind you.".to_owned()),
        Reply::Tool {
            id: "call_2".into(),
            name: "speak".into(),
            args: json!({ "text": "Time to drink water." }),
        },
        Reply::Text("Said it.".to_owned()),
    ]);
    send(&api, "remind me to drink water in a few seconds").await;
    t.note("a loop with a time", until(&mut socket, host_idle).await);
    t.note(
        "the time comes: the brain wakes and speaks, then the loop closes",
        until(&mut socket, |frame| {
            frame["data"]["message"]["body"]["loop"]["event"] == "closed"
        })
        .await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "a conversation has no speak; a wake has, and is told what woke it",
        json!({ "conversation": asked(&requests[0]), "wake": asked(&requests[2]) }),
    );

    // The brain will come back; a message takes over when it does, and it
    // comes back once more, finding nothing to say.
    let held = Arc::new(tokio::sync::Semaphore::new(0));
    cluster.llm.push([
        Reply::Tool {
            id: "call_3".into(),
            name: "schedule_wake".into(),
            args: json!({ "at": iso_in(3), "why": "look at the dotfiles" }),
        },
        Reply::Text("Later, then.".to_owned()),
        Reply::Held(held.clone(), "never said".to_owned()),
        Reply::Text("Yes, here.".to_owned()),
        Reply::Text("Nothing new in them.".to_owned()),
    ]);
    send(&api, "look at my dotfiles in a bit").await;
    t.note("coming back, said", until(&mut socket, host_idle).await);
    t.note(
        "it wakes",
        until(&mut socket, |frame| {
            frame["type"] == "wake_changed" && frame["data"]["wake"]["startedAt"].is_number()
        })
        .await,
    );
    send(&api, "are you there?").await;
    t.note(
        "people take over, and it comes back silent",
        until(&mut socket, |frame| wake_ended(frame, true)).await,
    );

    // Coming back, cancelled from the room.
    cluster.llm.push([
        Reply::Tool {
            id: "call_4".into(),
            name: "schedule_wake".into(),
            args: json!({ "at": iso_in(3600), "why": "check the build" }),
        },
        Reply::Text("I'll check.".to_owned()),
    ]);
    send(&api, "check the build later").await;
    let frames = socket.until(host_idle).await;
    let line = frames
        .iter()
        .find(|frame| frame["data"]["message"]["body"]["wake"]["event"] == "scheduled")
        .expect("the line");
    let build = line["data"]["message"]["body"]["wake"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancelled = api
        .send("DELETE", &format!("/api/wakes/{build}"), &me, None)
        .await;
    t.response("cancel", "DELETE /api/wakes/:id", &cancelled);
    t.note(
        "said in the room",
        until(&mut socket, |frame| {
            frame["data"]["message"]["body"]["wake"]["event"] == "cancelled"
        })
        .await,
    );
    let again = api
        .send("DELETE", &format!("/api/wakes/{build}"), &me, None)
        .await;
    t.response("cancelled already", "DELETE /api/wakes/:id", &again);

    // Two wakes started today: the next does not.
    cluster.llm.push([
        Reply::Tool {
            id: "call_5".into(),
            name: "schedule_wake".into(),
            args: json!({ "at": iso_in(2), "why": "see if the backup ran" }),
        },
        Reply::Text("Will do.".to_owned()),
    ]);
    send(&api, "see if the backup ran in a moment").await;
    socket.until(host_idle).await;
    let before = cluster.llm.requests().len();
    t.note(
        "past the day's wakes",
        until(&mut socket, |frame| wake_ended(frame, true)).await,
    );
    assert_eq!(cluster.llm.requests().len(), before, "no model call");

    let listed = api.send("GET", "/api/wakes?status=all", &me, None).await;
    t.response("the wakes", "GET /api/wakes?status=all", &listed);
    let turns = api
        .send("GET", "/api/brain/turns?room=general", &me, None)
        .await;
    t.note(
        "the turns",
        json!(
            turns.body["turns"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .map(|turn| json!([turn["kind"], turn["outcome"]]))
                .collect::<Vec<_>>()
        ),
    );
    for (step, method, path) in [
        (
            "an unknown wake",
            "DELETE",
            "/api/wakes/wake_none".to_owned(),
        ),
        (
            "a status that is not one",
            "GET",
            "/api/wakes?status=nope".to_owned(),
        ),
        (
            "an unknown room",
            "GET",
            "/api/wakes?room=room_none".to_owned(),
        ),
    ] {
        let refused = api.send(method, &path, &me, None).await;
        t.response(step, &format!("{method} {path}"), &refused);
    }

    insta::assert_json_snapshot!("brain_wake", stable(t.into_value()));
}
