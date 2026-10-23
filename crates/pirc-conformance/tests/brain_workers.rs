//! Workers (plans/rewrite/06-workers.md): the brain calls a worker without
//! asking; the room gets its message with a thread under it, and the node
//! the session and the task (with the person's verified words). What the
//! worker does, its team (one level down) and its question go to the
//! thread; the question is answered there and the thread's words reach the
//! running session. A fifth worker waits its turn and starts when one ends.
//! The brain reads its report at once (a report turn, nobody having spoken)
//! and tells the room in its own words, linked to the thread: a fact it
//! keeps from it is `tool:delegation`. Stop ends a worker; a wake's worker works read-only
//! and a wake cannot stop one. The test plays `work`, a directory node.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Reply, Transcript, WebSocket, assert_node_frame, browser_headers,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const WORK_TOKEN: &str = "conformance-work-token-0123456789abcdef";
const WAIT: Duration = Duration::from_secs(15);

/// What the fake node knows of its sessions: each one's snapshot, and the
/// worker each was given (`details.delegationId` of its task).
#[derive(Default)]
struct NodeState {
    next: u32,
    snapshots: HashMap<String, Value>,
    workers: HashMap<String, String>,
}

type Shared = Arc<Mutex<NodeState>>;

fn ok(body: Value) -> Value {
    json!({ "status": 200, "body": body })
}

/// The session's snapshot with the task taken and its run `status`; more
/// history and its pending dialogs after it.
fn snapshot(worker: &str, status: &str, more: &[Value], dialogs: &[Value]) -> Value {
    let mut history = vec![
        json!({ "role": "custom", "customType": "assistant-delegation",
        "content": "task", "details": { "delegationId": worker } }),
    ];
    history.extend(more.iter().cloned());
    json!({ "history": history, "run": { "status": status, "createdAt": 0 },
        "interactions": dialogs })
}

fn answer(state: &Shared, request: &Value) -> Value {
    let method = request["method"].as_str().unwrap_or_default();
    let url = request["url"].as_str().unwrap_or_default();
    let mut state = state.lock().unwrap();
    let parts: Vec<&str> = url.trim_start_matches("/api/sessions").split('/').collect();
    match (method, parts.as_slice()) {
        ("POST", [""]) => {
            state.next += 1;
            let id = format!("task-{}", state.next);
            state.snapshots.insert(
                id.clone(),
                json!({ "history": [], "run": null, "interactions": [] }),
            );
            json!({ "status": 201, "body": { "session": { "id": id } } })
        }
        ("PATCH", ["", _]) => ok(json!({})),
        ("POST", ["", id, "deliver"]) => {
            let worker = request["payload"]["details"]["delegationId"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            state
                .snapshots
                .insert((*id).to_owned(), snapshot(&worker, "running", &[], &[]));
            state.workers.insert((*id).to_owned(), worker);
            json!({ "status": 202, "body": { "delivered": true } })
        }
        ("GET", ["", id, "snapshot"]) => match state.snapshots.get(*id) {
            Some(snapshot) => ok(snapshot.clone()),
            None => {
                json!({ "status": 404, "body": { "error": { "code": "not_found", "message": "Session not found" } } })
            }
        },
        ("POST", ["", _, "control", "acquire"]) => ok(json!({ "lease": {
            "clientId": request["payload"]["clientId"], "generation": 1,
            "expiresAt": 4_000_000_000_000u64 } })),
        ("POST", ["", _, "commands"]) => {
            json!({ "status": 202, "body": { "command": { "status": "accepted" } } })
        }
        ("POST", ["", _, "control", "release"]) => json!({ "status": 204, "body": null }),
        ("POST", ["", _, "interactions", interaction, "relayed-answer"]) => {
            ok(json!({ "interactionId": interaction, "status": "answered" }))
        }
        _ => {
            json!({ "status": 404, "body": { "error": { "code": "not_found", "message": "Not here" } } })
        }
    }
}

/// A node played by the test: relayed requests are answered from its
/// [`NodeState`] and queued for the test to look at.
struct FakeNode {
    outbox: mpsc::UnboundedSender<Value>,
    requests: mpsc::UnboundedReceiver<Value>,
    state: Shared,
}

impl FakeNode {
    async fn connect(api: &Api) -> Self {
        let headers = vec![
            ("x-pirc-node-id", "work".to_owned()),
            ("authorization", format!("Bearer {WORK_TOKEN}")),
        ];
        let mut socket: WebSocket = api.connect("/node/connect", &headers).await.open();
        let register = json!({ "type": "register",
            "protocol": pirc_protocol::NODE_PROTOCOL_VERSION, "modes": ["directory", "scratch"],
            "workspaces": [
                { "id": "repo", "displayName": "Repo", "mode": "directory",
                    "roles": [{ "name": "general", "description": "General work" }] },
                { "id": "scratch", "displayName": "Scratch", "mode": "scratch" },
            ],
            "capabilities": { "os": "linux", "arch": "x86_64", "gpus": [], "browser": false,
                "terminals": true, "sandbox": { "backend": "srt", "status": "active", "gpu": false },
                "maxRunning": 4 } });
        assert_node_frame(&register);
        socket.send_json(&register).await;
        let registered = socket.next_json().await.expect("registered");
        assert_eq!(registered["type"], "registered", "{registered}");
        let state = Shared::default();
        let answering = state.clone();
        let (outbox, mut outgoing) = mpsc::unbounded_channel::<Value>();
        let (request_log, requests) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    frame = outgoing.recv() => match frame {
                        Some(Value::Null) | None => {
                            socket.close().await;
                            return;
                        }
                        Some(frame) => socket.send_json(&frame).await,
                    },
                    frame = socket.next_json() => {
                        let Ok(frame) = frame else { return };
                        if frame["type"] == "request" {
                            let data = frame["data"].clone();
                            let reply = json!({ "type": "response",
                                "requestId": frame["requestId"], "data": answer(&answering, &data) });
                            assert_node_frame(&reply);
                            socket.send_json(&reply).await;
                            let _ = request_log.send(data);
                        }
                    }
                }
            }
        });
        Self {
            outbox,
            requests,
            state,
        }
    }

    /// An event of the node's session `remote`.
    fn event(&self, remote: &str, kind: &str, data: Value) {
        let frame = json!({ "type": "event", "sessionId": remote,
            "event": { "type": kind, "data": data } });
        assert_node_frame(&frame);
        self.outbox.send(frame).unwrap();
    }

    fn agent(&self, remote: &str, data: Value) {
        self.event(remote, "pi_event", data);
    }

    fn close(&self) {
        self.outbox.send(Value::Null).unwrap();
    }

    fn set(&self, remote: &str, snapshot: Value) {
        self.state
            .lock()
            .unwrap()
            .snapshots
            .insert(remote.to_owned(), snapshot);
    }

    /// The node's session of a worker.
    fn session_of(&self, worker: &str) -> String {
        self.state
            .lock()
            .unwrap()
            .workers
            .iter()
            .find(|(_, given)| given.as_str() == worker)
            .map(|(remote, _)| remote.clone())
            .expect("the worker has a session")
    }

    /// Relayed requests until one `done` takes (that one last), as
    /// `METHOD url` lines with their payloads.
    async fn until(&mut self, mut done: impl FnMut(&Value) -> bool) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let request = tokio::time::timeout(WAIT, self.requests.recv())
                .await
                .expect("timed out waiting for a relayed request")
                .expect("node task ended");
            let stop = done(&request);
            seen.push(request);
            if stop {
                return seen;
            }
        }
    }
}

/// A relayed request as the snapshot shows it.
fn shown(request: &Value) -> Value {
    let line = format!(
        "{} {}",
        request["method"].as_str().unwrap_or_default(),
        request["url"].as_str().unwrap_or_default()
    );
    match &request["payload"] {
        Value::Null => json!(line),
        payload => json!({ "request": line, "payload": payload }),
    }
}

fn is(request: &Value, method: &str, suffix: &str) -> bool {
    request["method"] == method
        && request["url"]
            .as_str()
            .is_some_and(|url| url.ends_with(suffix))
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

fn host_idle(frame: &Value) -> bool {
    frame["type"] == "brain_presence" && frame["data"]["state"] == "idle"
}

/// The room's messages after `after` (a seq), as `[kind, body]`, streamed
/// replies only as they ended.
async fn room_since(api: &Api, after: i64) -> (Value, i64) {
    let listed = api
        .send(
            "GET",
            "/api/rooms/general/messages?limit=200",
            &browser_headers(),
            None,
        )
        .await;
    let mut last = after;
    let mut out = Vec::new();
    for message in listed.body["messages"].as_array().unwrap() {
        let seq = message["seq"].as_i64().unwrap();
        last = last.max(seq);
        if seq <= after || message["speaker"] == "user" {
            continue;
        }
        let mut entry = json!({ "kind": message["kind"], "body": message["body"] });
        if !message["threadId"].is_null() {
            entry["threadId"] = message["threadId"].clone();
        }
        out.push(entry);
    }
    (json!(out), last)
}

/// The thread's messages, once `done` holds of them.
async fn thread_when(api: &Api, thread: &str, done: impl Fn(&[Value]) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let got = api
            .send(
                "GET",
                &format!("/api/threads/{thread}"),
                &browser_headers(),
                None,
            )
            .await;
        assert_eq!(got.status, 200, "{:?}", got.body);
        if done(got.body["messages"].as_array().unwrap()) {
            return got.body;
        }
        assert!(
            Instant::now() < deadline,
            "the thread did not get there: {}",
            got.body
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// The workers, as `[title, status, readOnly]`, by title.
async fn workers(api: &Api, status: &str) -> Value {
    let listed = api
        .send(
            "GET",
            &format!("/api/workers?status={status}"),
            &browser_headers(),
            None,
        )
        .await;
    assert_eq!(listed.status, 200, "{:?}", listed.body);
    let mut list: Vec<Value> = listed.body["workers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|worker| json!([worker["title"], worker["status"], worker["readOnly"]]))
        .collect();
    list.sort_by_key(|item| item[0].as_str().unwrap_or_default().to_owned());
    json!(list)
}

async fn workers_when(api: &Api, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let list = workers(api, "all").await;
        if done(&list) {
            return list;
        }
        assert!(
            Instant::now() < deadline,
            "the workers did not get there: {list}"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// The tools of a model call.
fn tools(request: &Value) -> Value {
    json!(
        request
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|tool| tool["function"]["name"].clone())
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

/// The transcript with what each run makes up replaced: worker ids (`d`
/// and 8 hex), fact and loop ids, the node's session numbers (the order
/// workers start in is the scheduler's), local times.
fn stable(value: Value) -> Value {
    let mut out = value.to_string();
    for (kind, pattern) in [
        ("worker", r"\bd[0-9a-f]{8}\b"),
        ("fact", r"\b[0-9a-f]{12}\b"),
        ("task", r"\btask-[0-9]+\b"),
        ("local-time", r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}"),
        ("weekday", r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) <"),
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

#[tokio::test(flavor = "multi_thread")]
async fn brain_workers() {
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
    std::fs::write(config.join("brain.json"), r#"{ "debounceSeconds": 0.2 }"#).unwrap();
    let api = cluster.api();
    let me = browser_headers();
    let mut t = Transcript::new(cluster.volatile());
    let mut socket = api.connect("/api/events?rooms=1", &me).await.open();
    socket.next_json().await.expect("ready");
    let mut work = FakeNode::connect(&api).await;

    // The brain calls a worker: no card, a message with a thread, and the
    // task (with the person's words) delivered to a new session.
    cluster.llm.push([
        Reply::Tool {
            id: "call_1".into(),
            name: "call_worker".into(),
            args: json!({
                "workspace": "work:repo",
                "task": "Run the test suite of the repository and report what fails.",
                "title": "Run the tests",
                "quote": "run the tests in Repo",
            }),
        },
        Reply::Text("I asked a worker.".to_owned()),
    ]);
    send(&api, "please run the tests in Repo").await;
    socket.until(host_idle).await;
    let started = work.until(|request| is(request, "POST", "/deliver")).await;
    t.note(
        "the node: a session, named, then the task",
        json!(started.iter().map(shown).collect::<Vec<_>>()),
    );
    let (room, mut seen) = room_since(&api, 0).await;
    t.note(
        "the room: the call, with a thread, then the reply",
        room.clone(),
    );
    let thread = room[0]["threadId"].as_str().expect("a thread").to_owned();
    let first = &cluster.llm.requests()[0];
    t.note("a conversation's tools", tools(first));
    let w1 = work
        .state
        .lock()
        .unwrap()
        .workers
        .values()
        .next()
        .unwrap()
        .clone();
    let task1 = work.session_of(&w1);

    // What the worker does, and its team one level down, in the thread.
    work.agent(&task1, json!({ "type": "agent_start" }));
    work.agent(
        &task1,
        json!({ "type": "tool_execution_start", "toolCallId": "c1",
        "toolName": "bash", "args": { "command": "cargo test --workspace" } }),
    );
    work.agent(
        &task1,
        json!({ "type": "tool_execution_start", "toolCallId": "c2",
        "toolName": "ptc", "args": { "code": "return 1" } }),
    );
    work.agent(
        &task1,
        json!({ "type": "team_event", "event": { "kind": "spawn", "name": "checker" } }),
    );
    work.agent(
        &task1,
        json!({ "type": "team_event", "event": { "kind": "message",
        "from": "checker", "to": "parent", "body": "clippy is clean" } }),
    );
    work.agent(
        &task1,
        json!({ "type": "message_end", "message": { "role": "assistant",
        "content": [{ "type": "text", "text": "Running the tests now." }] } }),
    );
    let body = thread_when(&api, &thread, |messages| messages.len() >= 6).await;
    t.note(
        "the thread: the task, the start, what it did, its team",
        body["messages"].clone(),
    );

    // It asks something: a question in the thread, a line in the room;
    // answered in the thread, without the session's control.
    let dialog = json!({ "id": "interaction-1", "kind": "select", "createdAt": 0,
        "request": { "method": "select", "title": "Which suite?", "options": ["unit", "all"] } });
    work.set(
        &task1,
        snapshot(&w1, "waiting_input", &[], std::slice::from_ref(&dialog)),
    );
    work.event(&task1, "interaction_created", dialog);
    socket
        .until(|frame| frame["data"]["message"]["body"]["worker"]["event"] == "question")
        .await;
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("the room is told", room);
    let answered = api
        .send(
            "POST",
            &format!("/api/threads/{thread}/answer"),
            &me,
            Some(json!({ "interactionId": "interaction-1", "answer": { "value": "all" } })),
        )
        .await;
    t.response(
        "answer it in the thread",
        "POST /api/threads/:id/answer",
        &answered,
    );
    let relayed = work
        .until(|request| is(request, "POST", "/relayed-answer"))
        .await;
    t.note("relayed to the node", shown(relayed.last().unwrap()));
    work.set(&task1, snapshot(&w1, "running", &[], &[]));
    let again = api
        .send(
            "POST",
            &format!("/api/threads/{thread}/answer"),
            &me,
            Some(json!({ "interactionId": "interaction-1", "answer": { "value": "unit" } })),
        )
        .await;
    t.response("answered already", "POST /api/threads/:id/answer", &again);

    // A red line (plans/rewrite/07-red-lines.md): asked in the room itself;
    // the person's words answer it through the brain, quoted.
    let push = json!({ "id": "interaction-2", "kind": "confirm", "createdAt": 0,
        "expiresAt": 4_000_000_000_000u64,
        "request": { "method": "confirm", "title": "Auto mode: allow sending this out?",
            "message": "Command (bash, in /repo):\n\ngit push origin main\n\nReason: git push sends commits to a remote",
            "allowAgain": true } });
    work.set(
        &task1,
        snapshot(&w1, "waiting_input", &[], std::slice::from_ref(&push)),
    );
    work.event(&task1, "interaction_created", push);
    socket
        .until(|frame| {
            frame["type"] == "room_message" && frame["data"]["message"]["kind"] == "question"
        })
        .await;
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("a red line is asked in the room", room);
    cluster.llm.push([
        Reply::Tool {
            id: "call_r1".into(),
            name: "answer_worker_question".into(),
            args: json!({ "id": "interaction-2", "yes": true, "again": true,
                "quote": "yes, push it, and again later" }),
        },
        Reply::Text("Told it yes.".to_owned()),
    ]);
    let before = cluster.llm.requests().len();
    send(&api, "yes, push it, and again later").await;
    socket.until(host_idle).await;
    t.note(
        "the brain sees what waits",
        json!(
            cluster.llm.requests()[before]
                .to_string()
                .contains("[interaction-2] Run the tests")
        ),
    );
    let relayed = work
        .until(|request| is(request, "POST", "/relayed-answer"))
        .await;
    t.note(
        "the person's yes, relayed to the node",
        shown(relayed.last().unwrap()),
    );
    work.set(&task1, snapshot(&w1, "running", &[], &[]));
    let listed = api
        .send("GET", "/api/rooms/general/messages?limit=200", &me, None)
        .await;
    let asked: Vec<Value> = listed.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["kind"] == "question")
        .map(|message| message["body"]["question"].clone())
        .collect();
    t.note("the room's question, answered", json!(asked));
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("the brain's reply", room);

    // Unanswered in time: the node withdraws it, the room says so.
    let soon = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 300;
    let domains = json!({ "id": "interaction-3", "kind": "confirm", "createdAt": 0,
        "expiresAt": soon,
        "request": { "method": "confirm", "title": "Allow network access?",
            "message": "The agent asks to reach registry.example.com from its sandbox." } });
    work.set(
        &task1,
        snapshot(&w1, "waiting_input", &[], std::slice::from_ref(&domains)),
    );
    work.event(&task1, "interaction_created", domains);
    socket
        .until(|frame| {
            frame["type"] == "room_message"
                && frame["data"]["message"]["body"]["question"]["interactionId"] == "interaction-3"
        })
        .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    work.set(&task1, snapshot(&w1, "running", &[], &[]));
    work.event(
        &task1,
        "interaction_answered",
        json!({ "interactionId": "interaction-3", "cancelled": true }),
    );
    socket
        .until(|frame| frame["data"]["message"]["body"]["worker"]["event"] == "question_expired")
        .await;
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("nobody answered in time", room);

    // Words in the thread reach the running session as a follow-up.
    let added = api
        .send(
            "POST",
            &format!("/api/threads/{thread}/messages"),
            &me,
            Some(json!({ "text": "also run clippy" })),
        )
        .await;
    t.response(
        "say something in the thread",
        "POST /api/threads/:id/messages",
        &added,
    );
    let commanded = work
        .until(|request| is(request, "POST", "/control/release"))
        .await;
    t.note(
        "the node: control taken, the follow-up, control released",
        json!(commanded.iter().map(shown).collect::<Vec<_>>()),
    );

    // Four more: three run, the fifth waits its turn.
    let mut replies = Vec::new();
    for (index, suite) in ["A", "B", "C", "D"].iter().enumerate() {
        replies.push(Reply::Tool {
            id: format!("call_{}", index + 2),
            name: "call_worker".into(),
            args: json!({ "workspace": "Repo", "task": format!("Run suite {suite}."),
                "title": format!("Suite {suite}") }),
        });
    }
    replies.push(Reply::Text("Four more on it.".to_owned()));
    cluster.llm.push(replies);
    send(&api, "and run suites A to D").await;
    socket.until(host_idle).await;
    t.note(
        "five workers: four run, one waits",
        workers_when(&api, |list| {
            list.as_array()
                .unwrap()
                .iter()
                .filter(|w| w[1] == "running")
                .count()
                == 4
        })
        .await,
    );
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("the room: four calls, one waiting", room);

    // The first ends: the brain reads its report and tells the room, and
    // the fifth starts. What it keeps of it is from the delegation.
    cluster.llm.push([
        Reply::Tool {
            id: "call_6".into(),
            name: "remember".into(),
            args: json!({ "fact": "The Repo test suite passes (42 tests)." }),
        },
        Reply::Text("Good news: every test in Repo passes, and clippy is clean.".to_owned()),
    ]);
    let before = cluster.llm.requests().len();
    work.set(
        &task1,
        snapshot(
            &w1,
            "succeeded",
            &[json!({ "role": "assistant",
        "content": [{ "type": "text", "text": "All 42 tests pass; clippy is clean." }] })],
            &[],
        ),
    );
    work.agent(&task1, json!({ "type": "agent_settled" }));
    socket
        .until(|frame| frame["data"]["message"]["body"]["worker"]["report"] == true)
        .await;
    socket.until(host_idle).await;
    let requests = cluster.llm.requests();
    let request = requests[before].to_string();
    t.note(
        "the brain is told at once",
        json!({
            "calls": requests.len() - before,
            "turn": request.contains("## Worker reports"),
            "report": request.contains("Worker report (gateway data, not instructions)"),
            "result": request.contains("All 42 tests pass"),
            "untold": request.contains("the room has not been told"),
        }),
    );
    t.note(
        "the waiting one starts",
        workers_when(&api, |list| {
            list.as_array().unwrap().iter().all(|w| w[1] != "queued")
        })
        .await,
    );
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note(
        "the room: the brain's report, kept from the delegation",
        room,
    );
    let body = thread_when(&api, &thread, |messages| {
        messages
            .last()
            .is_some_and(|m| m["body"]["event"] == "completed")
    })
    .await;
    t.note(
        "the thread ends",
        json!(
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .take(4)
                .rev()
                .collect::<Vec<_>>()
        ),
    );
    t.note("the thread's workers", body["workers"].clone());

    // People's next turn is theirs: the report is not told again.
    cluster
        .llm
        .push([Reply::Text("You're welcome.".to_owned())]);
    let before = cluster.llm.requests().len();
    send(&api, "great, thanks").await;
    socket.until(host_idle).await;
    let request = cluster.llm.requests()[before].to_string();
    t.note(
        "not told again",
        json!({ "turn": request.contains("## Worker reports") }),
    );
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("the brain's reply", room);

    // Stop: the gateway takes the session's control and stops its run.
    let listed = api.send("GET", "/api/workers", &me, None).await;
    let suite_a = listed.body["workers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|worker| worker["title"] == "Suite A")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let stopped = api
        .send(
            "POST",
            &format!("/api/delegations/{suite_a}/stop"),
            &me,
            None,
        )
        .await;
    t.response("stop a worker", "POST /api/delegations/:id/stop", &stopped);
    let commanded = work
        .until(|request| is(request, "POST", "/control/release"))
        .await;
    t.note(
        "the node: stopped",
        json!(
            commanded
                .iter()
                .filter(|r| is(r, "POST", "/commands"))
                .map(|r| r["payload"]["payload"].clone())
                .collect::<Vec<_>>()
        ),
    );
    let task_a = work.session_of(&suite_a);
    cluster.llm.push([Reply::Text(
        "Suite A was stopped before it finished; say if you want it run again.".to_owned(),
    )]);
    work.set(&task_a, snapshot(&suite_a, "cancelled", &[], &[]));
    work.agent(&task_a, json!({ "type": "agent_settled" }));
    socket
        .until(|frame| {
            frame["data"]["message"]["body"]["worker"]["status"] == "failed"
                && frame["data"]["message"]["body"]["worker"]["report"] == true
        })
        .await;
    socket.until(host_idle).await;
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("the room: it ended", room);

    // Awake, the brain may call a worker, read-only, and may not stop one.
    cluster.llm.push([
        Reply::Tool {
            id: "call_7".into(),
            name: "schedule_wake".into(),
            args: json!({ "at": iso_in(3), "why": "look at the CI" }),
        },
        Reply::Text("Later.".to_owned()),
        Reply::Tool {
            id: "call_8".into(),
            name: "call_worker".into(),
            args: json!({ "workspace": "work:repo", "task": "Read the CI logs and say what failed.",
                "title": "CI logs" }),
        },
        Reply::Text("Asked.".to_owned()),
    ]);
    let before = cluster.llm.requests().len();
    send(&api, "look at the CI in a bit").await;
    socket.until(host_idle).await;
    let delivered = work.until(|request| is(request, "POST", "/deliver")).await;
    let task = delivered.last().unwrap();
    t.note(
        "a wake's worker: read-only",
        json!({
            "approvalMode": task["payload"]["approvalMode"],
            "readOnly": task["payload"]["content"].as_str().unwrap().contains("change nothing"),
            "userRequests": task["payload"]["details"].get("userRequests"),
        }),
    );
    let requests = cluster.llm.requests();
    t.note(
        "a wake's tools have no stop_worker",
        json!({ "conversation": tools(&requests[before]), "wake": tools(&requests[before + 2]) }),
    );
    t.note(
        "the workers",
        workers_when(&api, |list| {
            list.as_array()
                .unwrap()
                .iter()
                .any(|w| w[0] == "CI logs" && w[1] == "running")
        })
        .await,
    );
    let (room, last) = room_since(&api, seen).await;
    seen = last;
    t.note("the room", room);

    // No repository: a machine's scratch (plans/rewrite/08-nodes.md); a GPU
    // nobody's sandbox reaches: no machine fits.
    cluster.llm.push([
        Reply::Tool {
            id: "call_9".into(),
            name: "call_worker".into(),
            args: json!({ "task": "Plot last month's numbers.", "title": "A plot",
                "node_hint": "linux" }),
        },
        Reply::Tool {
            id: "call_10".into(),
            name: "call_worker".into(),
            args: json!({ "task": "Train a small model.", "gpu": true }),
        },
        Reply::Text("On it.".to_owned()),
    ]);
    let before = cluster.llm.requests().len();
    send(&api, "plot last month's numbers, and train a small model").await;
    socket.until(host_idle).await;
    let listed = api.send("GET", "/api/workers?status=all", &me, None).await;
    t.note(
        "scratch, on a machine that fits",
        json!(
            listed.body["workers"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|w| w["title"] == "A plot")
                .map(|w| json!([w["workspace"], w["workspaceId"]]))
                .collect::<Vec<_>>()
        ),
    );
    let results: Vec<Value> = cluster.llm.requests()[before + 2]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool" && m["tool_call_id"] == "call_10")
        .map(|m| m["content"].clone())
        .collect();
    t.note("no machine fits", json!(results));
    let (room, _) = room_since(&api, seen).await;
    t.note("the room", room);

    for (step, method, path, body) in [
        (
            "an unknown thread",
            "GET",
            "/api/threads/thread_none".to_owned(),
            None,
        ),
        (
            "an empty message",
            "POST",
            format!("/api/threads/{thread}/messages"),
            Some(json!({ "text": "  " })),
        ),
        (
            "an unknown question",
            "POST",
            format!("/api/threads/{thread}/answer"),
            Some(json!({ "interactionId": "interaction-9", "answer": { "value": "x" } })),
        ),
        (
            "a status that is not one",
            "GET",
            "/api/workers?status=nope".to_owned(),
            None,
        ),
        (
            "stop a worker that ended",
            "POST",
            format!("/api/delegations/{suite_a}/stop"),
            None,
        ),
    ] {
        let refused = api.send(method, &path, &me, body).await;
        t.response(step, &format!("{method} {path}"), &refused);
    }

    work.close();
    insta::assert_json_snapshot!("brain_workers", stable(t.into_value()));
}
