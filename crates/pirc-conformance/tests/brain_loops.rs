//! Open loops (plans/rewrite/04-open-loops.md): the brain opens one and
//! the room is told; it is in every later prompt; one opened after a tool
//! result carries that tool as its origin, through demotion; past 40 open,
//! the oldest without a time becomes a searchable fact and comes back when
//! reopened; a recurrence moves on to its next time and closes at its
//! `until`; the person closes one from the web. No node.

use std::time::{SystemTime, UNIX_EPOCH};

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Reply, Transcript, WebSocket, browser_headers,
};
use serde_json::{Value, json};

/// Room frames until the host face went idle once: the messages it wrote
/// (`(kind, body)`, streaming updates left out) and the loops that changed.
async fn until_idle(socket: &mut WebSocket) -> Value {
    let frames = socket
        .until(|frame| frame["type"] == "brain_presence" && frame["data"]["state"] == "idle")
        .await;
    json!(frames.iter().filter_map(said).collect::<Vec<_>>())
}

/// What a frame says, if anything this scenario records.
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
        _ => None,
    }
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

/// The prompt's section that starts with `## <title>`, line by line.
fn section(prompt: &str, title: &str) -> Value {
    let start = format!("## {title}");
    let Some(at) = prompt.find(&start) else {
        return Value::Null;
    };
    let text = &prompt[at..];
    let end = text[start.len()..]
        .find("\n\n## ")
        .map_or(text.len(), |end| end + start.len());
    json!(text[..end].lines().collect::<Vec<_>>())
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
async fn brain_loops() {
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

    // Opened without asking, said in the room.
    cluster.llm.push([
        Reply::Tool {
            id: "call_1".into(),
            name: "open_loop".into(),
            args: json!({
                "what": "Team meeting",
                "why": "they meet every week",
                "anchor": { "cron": "0 18 * * 3" },
            }),
        },
        Reply::Text("I'll keep it in mind.".to_owned()),
    ]);
    send(
        &api,
        "remind me about the team meeting, every Wednesday at 18:00",
    )
    .await;
    t.note(
        "a loop, and the line that says so",
        until_idle(&mut socket).await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "the first call: no loops yet, and the tools",
        json!({
            "loops": section(&system_prompt(&requests[0]), "Open loops"),
            "tools": requests[0]["tools"].as_array().unwrap().iter()
                .map(|tool| tool["function"]["name"].clone()).collect::<Vec<_>>(),
            "toolResult": tool_results(&requests[1]),
        }),
    );
    let listed = api.send("GET", "/api/loops", &me, None).await;
    t.response("the open loops", "GET /api/loops", &listed);
    let meeting = listed.body["loops"][0]["id"].as_str().unwrap().to_owned();

    // Read from a tool, then opened: the loop says so.
    cluster.llm.push([
        Reply::Tool {
            id: "call_2".into(),
            name: "memory_search".into(),
            args: json!({ "query": "networking book" }),
        },
        Reply::Tool {
            id: "call_3".into(),
            name: "open_loop".into(),
            args: json!({ "what": "Read chapter 7 of the networking book" }),
        },
        Reply::Text("Noted.".to_owned()),
    ]);
    send(&api, "what was I supposed to read?").await;
    t.note("a loop after a tool result", until_idle(&mut socket).await);
    let requests = cluster.llm.requests();
    t.note(
        "in front of it in the next turn",
        section(&system_prompt(&requests[2]), "Open loops"),
    );

    // Forty-one open: the oldest without a time goes to memory.
    let mut replies: Vec<Reply> = (0..39)
        .map(|n| Reply::Tool {
            id: format!("call_many_{n}"),
            name: "open_loop".into(),
            args: json!({ "what": format!("Small thing number {n}") }),
        })
        .collect();
    replies.push(Reply::Text("That is a lot.".to_owned()));
    cluster.llm.push(replies);
    send(&api, "and thirty-nine small things").await;
    until_idle(&mut socket).await;
    let listed = api.send("GET", "/api/loops", &me, None).await;
    t.note(
        "forty-one open",
        json!(listed.body["loops"].as_array().unwrap().len()),
    );
    cluster.llm.push([Reply::Text("Sure.".to_owned())]);
    send(&api, "anything else?").await;
    let frames = until_idle(&mut socket).await;
    t.note("the next turn demotes one", frames);
    let listed = api.send("GET", "/api/loops", &me, None).await;
    t.note(
        "forty open",
        json!(listed.body["loops"].as_array().unwrap().len()),
    );
    let found = api
        .send(
            "GET",
            "/api/memory/records?q=networking%20chapter",
            &me,
            None,
        )
        .await;
    t.response(
        "a fact now, with its origin",
        "GET /api/memory/records?q=networking chapter",
        &found,
    );
    let demoted = found.body["records"][0]["openLoopId"]
        .as_str()
        .unwrap()
        .to_owned();
    let reopened = api
        .send(
            "PATCH",
            &format!("/api/loops/{demoted}"),
            &me,
            Some(json!({ "status": "open" })),
        )
        .await;
    t.response("not done yet", "PATCH /api/loops/:id", &reopened);
    t.note(
        "said in the room",
        json!(
            socket
                .until(|frame| frame["data"]["message"]["body"]["loop"]["event"] == "reopened")
                .await
                .iter()
                .filter_map(said)
                .collect::<Vec<_>>()
        ),
    );
    let gone = api
        .send(
            "GET",
            "/api/memory/records?q=networking%20chapter",
            &me,
            None,
        )
        .await;
    t.response(
        "and no longer a fact",
        "GET /api/memory/records?q=networking chapter",
        &gone,
    );

    // A recurrence moves on, and ends at its `until`.
    cluster.llm.push([
        Reply::Tool {
            id: "call_4".into(),
            name: "open_loop".into(),
            args: json!({
                "what": "Stretch",
                "anchor": { "cron": "* * * * * *", "until": iso_in(3) },
            }),
        },
        Reply::Text("Every second, for a few.".to_owned()),
    ]);
    send(&api, "remind me to stretch every second for a few seconds").await;
    let frames = socket
        .until(|frame| {
            frame["data"]["message"]["body"]["loop"]["event"] == "closed"
                && frame["data"]["message"]["body"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Stretch"))
        })
        .await;
    let stretch: Vec<&Value> = frames
        .iter()
        .filter(|frame| {
            frame["type"] == "loop_changed" && frame["data"]["loop"]["what"] == "Stretch"
        })
        .collect();
    let mut times: Vec<Value> = stretch
        .iter()
        .map(|frame| frame["data"]["loop"]["dueAt"].clone())
        .collect();
    times.dedup();
    let lines: Vec<Value> = frames
        .iter()
        .filter(|frame| {
            frame["data"]["message"]["kind"] == "line"
                && frame["data"]["message"]["body"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Stretch"))
        })
        .filter_map(said)
        .collect();
    t.note(
        "it moves on, then ends",
        json!({
            "lines": lines,
            "movedOn": times.iter().filter(|time| time.is_number()).count() >= 2,
        }),
    );

    // The person closes one from the web.
    let closed = api
        .send(
            "PATCH",
            &format!("/api/loops/{meeting}"),
            &me,
            Some(json!({ "status": "closed" })),
        )
        .await;
    t.response("not needed", "PATCH /api/loops/:id", &closed);
    let line = socket
        .until(|frame| frame["data"]["message"]["body"]["loop"]["event"] == "closed")
        .await;
    t.note(
        "said in the room",
        json!(line.iter().filter_map(said).collect::<Vec<_>>()),
    );
    let page = api
        .send("GET", "/api/loops?status=closed&limit=2", &me, None)
        .await;
    t.response(
        "the latest closed",
        "GET /api/loops?status=closed&limit=2",
        &page,
    );
    for (step, method, path, body) in [
        (
            "an unknown loop",
            "PATCH",
            "/api/loops/l00000000".to_owned(),
            json!({ "status": "closed" }),
        ),
        (
            "nothing to change",
            "PATCH",
            format!("/api/loops/{meeting}"),
            json!({}),
        ),
        (
            "an unknown field",
            "PATCH",
            format!("/api/loops/{meeting}"),
            json!({ "what": "x" }),
        ),
        (
            "a time that has passed",
            "PATCH",
            format!("/api/loops/{demoted}"),
            json!({ "anchor": { "at": "2001-01-01T10:00" } }),
        ),
        (
            "a closed loop's time",
            "PATCH",
            format!("/api/loops/{meeting}"),
            json!({ "anchor": { "at": "2099-01-01T10:00" } }),
        ),
        (
            "a status that is not one",
            "GET",
            "/api/loops?status=nope".to_owned(),
            Value::Null,
        ),
    ] {
        let body = (!body.is_null()).then_some(body);
        let refused = api.send(method, &path, &me, body).await;
        let request = format!(
            "{method} {}",
            path.replace(&meeting, ":id").replace(&demoted, ":id")
        );
        t.response(step, &request, &refused);
    }

    insta::assert_json_snapshot!("brain_loops", stable(t.into_value()));
}
