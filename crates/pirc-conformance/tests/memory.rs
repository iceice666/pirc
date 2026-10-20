//! The gateway's memory as node sessions and the memory pages see it
//! (plans/rewrite/03-memory.md): the household's memory is the brain's,
//! so a session's memory operations (`memory.search`, `recall.remote`)
//! are refused once their arguments parse and the chat assistant's
//! (`assistant.context`, `memory.note`) are gone; a directory node still
//! mirrors its workspace-memory ledger, and the memory pages' routes answer
//! on an empty memory. The test plays the directory node. The brain's own
//! use of memory is `brain_memory.rs`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use pirc_conformance::{
    Api, Cluster, GatewayOptions, NODE_ID, NODE_TOKEN, Transcript, WebSocket, assert_node_frame,
    browser_headers,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const LEDGER: &str = "dddddddddddddddd";
// Workspace-memory note ids (hashes of their content on a real node).
const NOTE: &str = "b00000000001";
const RETIRED: &str = "b00000000002";

type Answer = Box<dyn Fn(&Value) -> Value + Send + Sync>;

/// A node the test plays: relayed requests are answered with `answer` (and
/// logged); every other frame is passed on.
struct FakeNode {
    out: Option<mpsc::UnboundedSender<Value>>,
    frames: mpsc::UnboundedReceiver<Value>,
    relayed: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    requests: usize,
}

enum Step {
    Out(Option<Value>),
    In(Result<Value, (u16, String)>),
}

impl FakeNode {
    /// Connect and register; returns the node and its `registered` frame.
    async fn connect(
        api: &Api,
        id: &str,
        token: &str,
        register: Value,
        answer: Answer,
    ) -> (Self, Value) {
        let headers = vec![
            ("x-pirc-node-id", id.to_owned()),
            ("authorization", format!("Bearer {token}")),
        ];
        let mut socket: WebSocket = api.connect("/node/connect", &headers).await.open();
        assert_node_frame(&register);
        socket.send_json(&register).await;
        let registered = socket.next_json().await.expect("registered");
        let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
        let (incoming, frames) = mpsc::unbounded_channel();
        let relayed = Arc::new(Mutex::new(Vec::new()));
        let log = relayed.clone();
        let task = tokio::spawn(async move {
            loop {
                let step = tokio::select! {
                    frame = outgoing.recv() => Step::Out(frame),
                    message = socket.next_json() => Step::In(message),
                };
                match step {
                    Step::Out(Some(frame)) => socket.send_json(&frame).await,
                    Step::Out(None) => {
                        socket.close().await;
                        return;
                    }
                    Step::In(Ok(frame)) if frame["type"] == "request" => {
                        log.lock().unwrap().push(frame["data"].clone());
                        let reply = json!({ "type": "response", "requestId": frame["requestId"],
                            "data": answer(&frame["data"]) });
                        socket.send_json(&reply).await;
                    }
                    Step::In(Ok(frame)) => {
                        let _ = incoming.send(frame);
                    }
                    Step::In(Err((code, reason))) => {
                        let _ = incoming
                            .send(json!({ "type": "closed", "code": code, "reason": reason }));
                        return;
                    }
                }
            }
        });
        let node = Self {
            out: Some(out),
            frames,
            relayed,
            task,
            requests: 0,
        };
        (node, registered)
    }

    fn send(&self, frame: Value) {
        assert_node_frame(&frame);
        self.out.as_ref().unwrap().send(frame).unwrap();
    }

    async fn next(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(20), self.frames.recv())
                .await
                .expect("timed out waiting for a frame from the gateway")
                .expect("node task ended");
            if wanted(&frame) {
                return frame;
            }
        }
    }

    /// An agent operation of `session` (the node's id of it): `{status, body}`.
    async fn op(&mut self, session: &str, op: &str, args: Value) -> Value {
        self.requests += 1;
        let request_id = format!("r{}", self.requests);
        self.send(json!({ "type": "agent_request", "requestId": request_id,
            "sessionId": session, "op": op, "args": args }));
        let response = self
            .next(|frame| frame["type"] == "agent_response" && frame["requestId"] == request_id)
            .await;
        json!({ "status": response["status"], "body": response["body"] })
    }

    /// A `memory_mirror` chunk and the gateway's acknowledgement.
    async fn mirror(&mut self, frame: Value) -> Value {
        let mut frame = frame;
        frame["type"] = json!("memory_mirror");
        self.send(frame);
        self.next(|frame| frame["type"] == "memory_mirror_ack")
            .await
    }

    fn take_relayed(&self) -> Vec<Value> {
        std::mem::take(&mut *self.relayed.lock().unwrap())
    }

    /// Close the link (as the node going away).
    async fn disconnect(mut self) {
        self.out.take();
        let _ = self.task.await;
    }
}

/// The directory node's answers: its one session is `dev-1`.
fn dev_answer() -> Answer {
    Box::new(|request| match request["method"].as_str() {
        Some("POST") if request["url"] == "/api/sessions" => {
            json!({ "status": 201, "body": { "session": { "id": "dev-1" } } })
        }
        _ => json!({ "status": 200, "body": { "relayed": true } }),
    })
}

fn item(id: &str, content: &str, session: Option<&str>, timestamp: &str) -> Value {
    let mut item = json!({ "id": id, "content": content, "relevance": "high",
        "timestamp": timestamp, "sourceMemoryIds": [] });
    if let Some(session) = session {
        item["sessionId"] = json!(session);
    }
    item
}

/// Wait until the gateway no longer lists `node`.
async fn offline(api: &Api, node: &str) {
    for _ in 0..400 {
        let nodes = api
            .send("GET", "/api/nodes", &browser_headers(), None)
            .await;
        if !nodes.body["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == node)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{node} stayed online");
}

#[tokio::test(flavor = "multi_thread")]
async fn memory() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        without_node: true,
        ..GatewayOptions::default()
    })
    .await
    else {
        return;
    };
    let api = cluster.api();
    let browser = browser_headers();
    let mut t = Transcript::new(cluster.volatile());
    let register = json!({
        "type": "register", "role": "node", "protocol": pirc_protocol::NODE_PROTOCOL_VERSION,
        "modes": ["directory"],
        "workspaces": [{ "id": "repo", "displayName": "Repo", "mode": "directory",
            "repo": "github.com/me/repo" }],
    });
    let (mut node, registered) =
        FakeNode::connect(&api, NODE_ID, NODE_TOKEN, register.clone(), dev_answer()).await;
    t.note("a directory node registers", registered);
    macro_rules! call {
        ($step:expr, $method:expr, $path:expr, $body:expr) => {{
            let target = String::from($path);
            let response = api.send($method, &target, &browser, $body).await;
            t.response($step, &format!("{} {}", $method, target), &response);
            let relayed = node.take_relayed();
            if !relayed.is_empty() {
                t.note(&format!("{}: relayed", $step), json!(relayed));
            }
            response
        }};
    }
    macro_rules! op {
        ($step:expr, $session:expr, $op:expr, $args:expr) => {{
            let answer = node.op($session, $op, $args).await;
            t.note(
                $step,
                json!({ "op": $op, "session": $session, "answer": answer }),
            );
            answer
        }};
    }
    call!(
        "a session in the repository",
        "POST",
        "/api/sessions",
        Some(json!({ "workspaceId": "test:repo" }))
    );

    // ---- the operations: refused, after their arguments ----
    op!(
        "the assistant's context is gone",
        "dev-1",
        "assistant.context",
        json!({})
    );
    op!(
        "so are its notes",
        "dev-1",
        "memory.note",
        json!({ "action": "add", "content": "The pirc repo lives on m5pro",
            "origins": ["assistant"] })
    );
    op!(
        "a search",
        "dev-1",
        "memory.search",
        json!({ "query": "staging" })
    );
    op!(
        "a search with a limit too high",
        "dev-1",
        "memory.search",
        json!({ "query": "staging", "limit": 21 })
    );
    op!("a recall", "dev-1", "recall.remote", json!({ "id": NOTE }));
    op!(
        "a recall of an id that is not one",
        "dev-1",
        "recall.remote",
        json!({ "id": "nope" })
    );
    op!(
        "an unknown session",
        "remote-z",
        "memory.search",
        json!({ "query": "staging" })
    );

    // ---- workspace memory mirrors ----
    let mut with_git = item(
        NOTE,
        "Staging deploys need the VPN",
        Some("dev-1"),
        "2026-09-28 09:00",
    );
    with_git["git"] = json!({ "head": "abcdef1234567890", "branch": "main", "dirty": true });
    let ack = node
        .mirror(
            json!({ "ledgerKey": LEDGER, "offset": 0, "end": 80, "lines": [
            { "type": "recorded", "items": [with_git,
                item(RETIRED, "A staging note that is retired", Some("dev-1"), "2026-09-28 10:00"),
                item("c00000000003", "A note without a session", None, "2026-09-28 11:00"),
                { "id": "not hex", "content": "staging" }] },
            { "type": "retired", "ids": [RETIRED], "reason": "superseded" },
            { "type": "bogus" },
        ] }),
        )
        .await;
    t.note("the node mirrors its ledger", ack);
    let ack = node
        .mirror(json!({ "ledgerKey": LEDGER, "offset": 60, "end": 200, "lines": [] }))
        .await;
    t.note("a chunk that does not continue it", ack);
    let ack = node
        .mirror(json!({ "ledgerKey": LEDGER, "offset": 10, "end": 20, "reset": true, "lines": [] }))
        .await;
    t.note("a reset that does not start at 0", ack);

    // ---- the memory pages ----
    call!("the preferences page", "GET", "/api/memory", None);
    call!("the same", "GET", "/api/memory/preferences", None);
    call!(
        "history of an unknown preference",
        "GET",
        "/api/memory/preferences/p00000000/history",
        None
    );
    call!(
        "an id that is too long",
        "GET",
        format!("/api/memory/preferences/{}/history", "x".repeat(41)),
        None
    );
    call!(
        "an id beyond the router's limit",
        "POST",
        format!("/api/memory/preferences/{}/forget", "x".repeat(101)),
        None
    );
    call!(
        "forget an unknown preference",
        "POST",
        "/api/memory/preferences/p00000000/forget",
        None
    );
    call!(
        "remove an unknown preference",
        "POST",
        "/api/memory/preferences/p00000000/remove",
        None
    );
    call!(
        "restore an unknown preference",
        "POST",
        "/api/memory/preferences/p00000000/restore",
        Some(json!({ "revision": 1 }))
    );
    call!(
        "restore with a body that is not an object",
        "POST",
        "/api/memory/preferences/p00000000/restore",
        Some(json!([1]))
    );
    call!("the household's facts", "GET", "/api/memory/records", None);
    call!(
        "the repositories' notes, newest first",
        "GET",
        "/api/memory/records?scope=repo",
        None
    );
    call!(
        "searched",
        "GET",
        "/api/memory/records?scope=all&q=staging%20VPN",
        None
    );
    call!(
        "a repository's note is not forgotten here",
        "DELETE",
        format!("/api/memory/records/{NOTE}"),
        None
    );

    // ---- registering again ----
    node.disconnect().await;
    offline(&api, NODE_ID).await;
    let (node, registered) =
        FakeNode::connect(&api, NODE_ID, NODE_TOKEN, register, dev_answer()).await;
    t.note(
        "the node registers again: its mirrored ledger's watermark",
        registered,
    );
    node.disconnect().await;
    insta::assert_json_snapshot!("memory", t.into_value());
}
