//! Faces (plans/rewrite/10-faces.md): the host and a project's face, made
//! from the API; `@PM` is answered by PM; without `@`, the face that spoke
//! last answers, and in its own room the project's face; one turn speaks
//! as two faces (the host hands over, PM reports back); a wake wears the
//! face that scheduled it; a topic is suggested to move at 15 messages,
//! not at 14, once a day, and moves with its open loops when someone says
//! yes; the brain makes a face when asked; an archived face answers
//! nowhere and can be hidden. The test plays `work`, a directory node.

use std::time::{SystemTime, UNIX_EPOCH};

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Reply, Transcript, WebSocket, assert_node_frame, browser_headers,
};
use serde_json::{Value, json};

const WORK_TOKEN: &str = "conformance-work-token-0123456789abcdef";

/// The faces' names by id, for what the frames say.
type Names = Vec<(String, String)>;

fn speaker(names: &Names, speaker: &Value) -> Value {
    let speaker = speaker.as_str().unwrap_or_default();
    match speaker.strip_prefix("face:") {
        Some(id) => names
            .iter()
            .find(|(known, _)| known == id)
            .map_or_else(|| json!(speaker), |(_, name)| json!(format!("face:{name}"))),
        None => json!(speaker),
    }
}

/// What a frame says, if anything this scenario records: who wrote what
/// (streaming updates and people's messages left out), loops and wakes.
fn said(names: &Names, frame: &Value) -> Option<Value> {
    let message = &frame["data"]["message"];
    match frame["type"].as_str()? {
        "room_message" | "room_message_updated"
            if message["body"]["streaming"] != json!(true) && message["speaker"] != "user" =>
        {
            Some(json!({
                "room": frame["roomId"],
                "speaker": speaker(names, &message["speaker"]),
                "kind": message["kind"],
                "text": message["body"]["text"],
            }))
        }
        "loop_changed" => {
            let changed = &frame["data"]["loop"];
            Some(json!({ "loop_changed": [changed["what"], changed["status"], changed["roomId"]] }))
        }
        "face_changed" => {
            let face = &frame["data"]["face"];
            Some(json!({ "face_changed": [face["name"], face["archivedAt"].is_number()] }))
        }
        _ => None,
    }
}

/// Room frames until the brain stops thinking as `face`.
async fn until_idle(socket: &mut WebSocket, names: &Names, face: &str) -> Value {
    let frames = socket
        .until(|frame| {
            frame["type"] == "brain_presence"
                && frame["data"]["state"] == "idle"
                && frame["data"]["face"] == face
        })
        .await;
    json!(
        frames
            .iter()
            .filter_map(|frame| said(names, frame))
            .collect::<Vec<_>>()
    )
}

async fn send(api: &Api, room: &str, text: &str, immediate: bool) {
    let sent = api
        .send(
            "POST",
            &format!("/api/rooms/{room}/messages"),
            &browser_headers(),
            Some(json!({ "text": text, "immediate": immediate })),
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

/// The transcript with what each run makes up replaced: loop ids, local
/// times and weekdays.
fn stable(value: Value) -> Value {
    let mut out = value.to_string();
    for (kind, pattern) in [
        ("loop", r#"\bl[0-9a-f]{8}\b"#),
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
                _ => format!("<{kind}:{}>", index + 1),
            };
            out = out.replace(found.as_str(), &placeholder);
        }
    }
    serde_json::from_str(&out).unwrap()
}

/// `work`, a directory node with one repository, connected for as long as
/// the test runs; relayed requests are answered 404.
async fn connect_work(api: &Api) {
    let headers = vec![
        ("x-pirc-node-id", "work".to_owned()),
        ("authorization", format!("Bearer {WORK_TOKEN}")),
    ];
    let mut socket: WebSocket = api.connect("/node/connect", &headers).await.open();
    let register = json!({ "type": "register",
        "protocol": pirc_protocol::NODE_PROTOCOL_VERSION, "modes": ["directory"],
        "workspaces": [{ "id": "repo", "displayName": "SlimeOS", "mode": "directory" }] });
    assert_node_frame(&register);
    socket.send_json(&register).await;
    let registered = socket.next_json().await.expect("registered");
    assert_eq!(registered["type"], "registered", "{registered}");
    tokio::spawn(async move {
        while let Ok(frame) = socket.next_json().await {
            if frame["type"] == "request" {
                let reply = json!({ "type": "response", "requestId": frame["requestId"],
                    "data": { "status": 404, "body": { "error": { "code": "not_found", "message": "Not here" } } } });
                socket.send_json(&reply).await;
            }
        }
    });
}

fn tool(id: &str, name: &str, args: Value) -> Reply {
    Reply::Tool {
        id: id.into(),
        name: name.into(),
        args,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn brain_faces() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        env: vec![(
            "PIRC_NODE_TOKENS",
            json!({ "work": WORK_TOKEN }).to_string(),
        )],
        without_node: true,
        ..Default::default()
    })
    .await
    else {
        return;
    };
    let config = cluster.dir.path().join("gateway-config");
    let debounce = |seconds: f64| {
        std::fs::write(
            config.join("brain.json"),
            json!({ "debounceSeconds": seconds }).to_string(),
        )
        .unwrap();
    };
    debounce(0.2);
    let api = cluster.api();
    let me = browser_headers();
    let mut t = Transcript::new(cluster.volatile());
    connect_work(&api).await;
    let mut socket = api.connect("/api/events?rooms=1", &me).await.open();
    let ready = socket.next_json().await.expect("ready");
    t.note("ready: what each face is doing", ready["faces"].clone());

    // The host, and a project's face made from the API.
    let listed = api.send("GET", "/api/faces", &me, None).await;
    t.response("only the host", "GET /api/faces", &listed);
    let room = api
        .send(
            "POST",
            "/api/rooms",
            &me,
            Some(json!({ "name": "slimeos" })),
        )
        .await;
    let slimeos = room.body["room"]["id"].as_str().unwrap().to_owned();
    let made = api
        .send(
            "POST",
            "/api/faces",
            &me,
            Some(json!({
                "name": "PM",
                "bio": "Runs the SlimeOS project.",
                "tone": "brief",
                "roleMd": "Track the PRs and the releases.",
                "color": "#3366CC",
                "territory": { "rooms": [slimeos], "workspaces": ["work:repo"] },
            })),
        )
        .await;
    t.response("PM, for SlimeOS", "POST /api/faces", &made);
    let pm = made.body["face"]["id"].as_str().unwrap().to_owned();
    let names: Names = vec![("host".into(), "pirc".into()), (pm.clone(), "PM".into())];
    for (step, body) in [
        ("a name taken, in another case", json!({ "name": "pm" })),
        ("a name with @", json!({ "name": "@ops" })),
        (
            "#general is the host's",
            json!({ "name": "Ops", "territory": { "rooms": ["general"] } }),
        ),
        (
            "a room that is PM's",
            json!({ "name": "Ops", "territory": { "rooms": [slimeos] } }),
        ),
        (
            "a workspace that is not there",
            json!({ "name": "Ops", "territory": { "workspaces": ["work:none"] } }),
        ),
        ("an unknown field", json!({ "name": "Ops", "boss": true })),
    ] {
        let refused = api.send("POST", "/api/faces", &me, Some(body)).await;
        t.response(step, "POST /api/faces", &refused);
    }
    for (step, face, body) in [
        (
            "the host is not archived",
            "host",
            json!({ "archived": true }),
        ),
        (
            "the host's territory is fixed",
            "host",
            json!({ "territory": { "rooms": [] } }),
        ),
        (
            "only an archived face is hidden",
            pm.as_str(),
            json!({ "hidden": true }),
        ),
        ("a change that changes nothing", pm.as_str(), json!({})),
    ] {
        let refused = api
            .send("PATCH", &format!("/api/faces/{face}"), &me, Some(body))
            .await;
        t.response(step, "PATCH /api/faces/:id", &refused);
    }

    // `@PM` is answered by PM, and told who it is.
    cluster
        .llm
        .push([Reply::Text("Two reviews left on the PR.".to_owned())]);
    send(&api, "general", "@PM how is the PR?", true).await;
    t.note(
        "@PM: PM answers",
        until_idle(&mut socket, &names, &pm).await,
    );
    let requests = cluster.llm.requests();
    let prompt = system_prompt(&requests[0]);
    t.note(
        "PM's prompt: who it is, the faces' rules, its workspaces first",
        json!({
            "you": section(&prompt, "You are now"),
            "rules": section(&prompt, "Faces"),
            "workers": section(&prompt, "Workers"),
            "tools": requests[0]["tools"].as_array().unwrap().iter()
                .map(|tool| tool["function"]["name"].clone()).collect::<Vec<_>>(),
        }),
    );

    // No `@`: who spoke last answers.
    cluster.llm.push([Reply::Text("CI is green.".to_owned())]);
    send(&api, "general", "and the CI?", true).await;
    t.note(
        "no @: the face that spoke last",
        until_idle(&mut socket, &names, &pm).await,
    );

    // One turn, two faces: the host hands over, PM reports back.
    cluster.llm.push([
        Reply::TextThenTool {
            text: "I'll ask PM.".to_owned(),
            id: "call_1".into(),
            name: "speak_as".into(),
            args: json!({ "face": "PM" }),
        },
        Reply::Text("The release is on Friday.".to_owned()),
    ]);
    send(&api, "general", "@pirc when is the release?", true).await;
    t.note(
        "one turn, the host then PM",
        until_idle(&mut socket, &names, &pm).await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "speak_as, as the model hears it",
        json!({
            "you": section(&system_prompt(&requests[2]), "You are now"),
            "switched": tool_results(&requests[3]),
        }),
    );

    // In its own room, the project's face answers; a wake it scheduled
    // wears it too.
    cluster.llm.push([
        tool(
            "call_2",
            "schedule_wake",
            json!({ "at": iso_in(2), "why": "look at the CI again" }),
        ),
        Reply::Text("I'll look again in a moment.".to_owned()),
        tool("call_3", "speak", json!({ "text": "CI is still green." })),
        Reply::Text("done".to_owned()),
    ]);
    send(&api, &slimeos, "keep an eye on the CI", true).await;
    t.note(
        "its own room: PM answers",
        until_idle(&mut socket, &names, &pm).await,
    );
    let frames = socket
        .until(|frame| {
            frame["type"] == "wake_changed" && !frame["data"]["wake"]["outcome"].is_null()
        })
        .await;
    t.note(
        "the wake wears PM",
        json!(
            frames
                .iter()
                .filter_map(|frame| said(&names, frame))
                .collect::<Vec<_>>()
        ),
    );

    // A topic in a room of its own: 14 messages, then more; the host is
    // asked to suggest #slimeos once, and it moves with its loop.
    let random = api
        .send("POST", "/api/rooms", &me, Some(json!({ "name": "random" })))
        .await;
    let random = random.body["room"]["id"].as_str().unwrap().to_owned();
    let about = json!({ "name": "SlimeOS release", "workspace": "work:repo" });
    cluster.llm.push([
        tool("call_4", "topic", about.clone()),
        tool(
            "call_5",
            "open_loop",
            json!({ "what": "Ship the SlimeOS release" }),
        ),
        Reply::Text("Noted, all of it.".to_owned()),
    ]);
    debounce(5.0);
    for n in 1..13 {
        send(&api, &random, &format!("release note {n}"), false).await;
    }
    send(&api, &random, "release note 13", true).await;
    t.note(
        "13 messages and a reply on the topic",
        until_idle(&mut socket, &names, "host").await,
    );
    debounce(0.2);
    cluster.llm.push([
        tool("call_6", "topic", about.clone()),
        Reply::Text("Fourteen so far.".to_owned()),
    ]);
    send(&api, &random, "one more note", true).await;
    until_idle(&mut socket, &names, "host").await;
    let requests = cluster.llm.requests();
    let at_14 = requests.len() - 2;
    t.note(
        "the turn after 14: nothing to suggest yet",
        section(&system_prompt(&requests[at_14]), "Maybe move"),
    );
    cluster.llm.push([
        tool("call_7", "topic", about.clone()),
        Reply::Text("Shall we continue in #slimeos?".to_owned()),
    ]);
    send(&api, &random, "anything else?", true).await;
    t.note(
        "after 16: the host is asked to suggest it",
        until_idle(&mut socket, &names, "host").await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "the hint",
        section(&system_prompt(&requests[requests.len() - 2]), "Maybe move"),
    );
    cluster.llm.push([
        tool(
            "call_8",
            "move_room",
            json!({ "to": "#slimeos", "quote": "ok, let's go there" }),
        ),
        Reply::Text("See you there.".to_owned()),
    ]);
    send(&api, &random, "ok, let's go there", true).await;
    t.note(
        "yes: it moves, with its loop",
        until_idle(&mut socket, &names, "host").await,
    );
    let requests = cluster.llm.requests();
    t.note(
        "suggested once a day",
        json!({
            "hint": section(&system_prompt(&requests[requests.len() - 2]), "Maybe move"),
            "moved": tool_results(&requests[requests.len() - 1]),
        }),
    );

    // The brain makes a face when asked, with words that ask for it.
    cluster.llm.push([
        tool(
            "call_9",
            "create_face",
            json!({ "name": "Gardener", "new_room": "garden", "quote": "nobody asked" }),
        ),
        tool(
            "call_10",
            "create_face",
            json!({ "name": "Gardener", "bio": "Looks after the plants.", "new_room": "garden",
                "quote": "make a face for the garden" }),
        ),
        Reply::Text("Gardener is here.".to_owned()),
    ]);
    send(&api, "general", "@pirc make a face for the garden", true).await;
    let frames = until_idle(&mut socket, &names, "host").await;
    let requests = cluster.llm.requests();
    t.note(
        "a face made in the room",
        json!({ "frames": frames, "results": tool_results(&requests[requests.len() - 1]) }),
    );

    // Archived: answers nowhere, greyed out, then hidden.
    let archived = api
        .send(
            "PATCH",
            &format!("/api/faces/{pm}"),
            &me,
            Some(json!({ "archived": true })),
        )
        .await;
    t.response("PM archived", "PATCH /api/faces/:id", &archived);
    cluster
        .llm
        .push([Reply::Text("PM is archived; I can help.".to_owned())]);
    send(&api, &slimeos, "@PM still there?", true).await;
    t.note(
        "an archived face answers nowhere: the host does",
        until_idle(&mut socket, &names, "host").await,
    );
    let hidden = api
        .send(
            "PATCH",
            &format!("/api/faces/{pm}"),
            &me,
            Some(json!({ "hidden": true })),
        )
        .await;
    t.response("hidden", "PATCH /api/faces/:id", &hidden);
    let listed = api.send("GET", "/api/faces", &me, None).await;
    t.response("the list without it", "GET /api/faces", &listed);
    let listed = api.send("GET", "/api/faces?hidden=1", &me, None).await;
    t.response("with the hidden ones", "GET /api/faces?hidden=1", &listed);
    let activity = api
        .send("GET", &format!("/api/faces/{pm}/activity"), &me, None)
        .await;
    t.response("what PM did", "GET /api/faces/:id/activity", &activity);
    let missing = api.send("GET", "/api/faces/face_none", &me, None).await;
    t.response("a face that is not there", "GET /api/faces/:id", &missing);

    insta::assert_json_snapshot!("brain_faces", stable(t.into_value()));
}
