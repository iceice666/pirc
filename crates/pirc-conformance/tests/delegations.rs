//! What node agents may still ask the gateway for, now that only the brain
//! calls workers (plans/rewrite/06-workers.md): the `delegation.*`
//! operations are gone, web search answers without a key, and the routes
//! that act on workers (Stop, a thread's words and answers) find none. The
//! brain's own workers are `brain_workers.rs`. The test plays `work`, a
//! directory node.

use std::sync::Arc;
use std::time::{Duration, Instant};

use pirc_conformance::{
    Api, Cluster, GatewayOptions, Transcript, WebSocket, assert_node_frame, browser_headers,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const WORK_TOKEN: &str = "conformance-work-token-0123456789abcdef";
const WAIT: Duration = Duration::from_secs(15);

/// How a fake node answers a relayed request (`{method,url,payload,...}`):
/// `{status, body}`.
type Answerer = Arc<dyn Fn(&Value) -> Value + Send + Sync>;

/// A node played by the test: relayed requests are answered by its
/// [`Answerer`] and queued for the test to look at; agent operations are
/// sent on behalf of its sessions.
struct FakeNode {
    outbox: mpsc::UnboundedSender<Value>,
    requests: mpsc::UnboundedReceiver<Value>,
    agent: mpsc::UnboundedReceiver<Value>,
    next_request: u32,
}

impl FakeNode {
    async fn connect(
        api: &Api,
        node_id: &str,
        token: &str,
        register: Value,
        answer: Answerer,
    ) -> Self {
        let headers = vec![
            ("x-pirc-node-id", node_id.to_owned()),
            ("authorization", format!("Bearer {token}")),
        ];
        let mut socket: WebSocket = api.connect("/node/connect", &headers).await.open();
        assert_node_frame(&register);
        socket.send_json(&register).await;
        let registered = socket.next_json().await.expect("registered");
        assert_eq!(registered["type"], "registered", "{registered}");
        let (outbox, mut outgoing) = mpsc::unbounded_channel::<Value>();
        let (request_log, requests) = mpsc::unbounded_channel();
        let (agent_log, agent) = mpsc::unbounded_channel();
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
                        match frame["type"].as_str() {
                            Some("request") => {
                                let data = frame["data"].clone();
                                let reply = json!({ "type": "response",
                                    "requestId": frame["requestId"], "data": answer(&data) });
                                assert_node_frame(&reply);
                                socket.send_json(&reply).await;
                                let _ = request_log.send(data);
                            }
                            Some("agent_response") => {
                                let _ = agent_log.send(frame);
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
        Self {
            outbox,
            requests,
            agent,
            next_request: 0,
        }
    }

    fn send(&self, frame: Value) {
        assert_node_frame(&frame);
        self.outbox.send(frame).unwrap();
    }

    fn close(&self) {
        self.outbox.send(Value::Null).unwrap();
    }

    /// The next request the gateway relayed to this node.
    async fn request(&mut self) -> Value {
        tokio::time::timeout(WAIT, self.requests.recv())
            .await
            .expect("timed out waiting for a relayed request")
            .expect("node task ended")
    }

    /// Run an agent operation for the node's session `session`: `{status, body}`.
    async fn op(&mut self, session: &str, op: &str, args: Value) -> Value {
        self.next_request += 1;
        let request_id = format!("op-{}", self.next_request);
        self.send(json!({ "type": "agent_request", "requestId": request_id,
            "sessionId": session, "op": op, "args": args }));
        let response = tokio::time::timeout(WAIT, self.agent.recv())
            .await
            .expect("timed out waiting for an agent response")
            .expect("node task ended");
        assert_eq!(response["requestId"], request_id);
        json!({ "status": response["status"], "body": response["body"] })
    }
}

fn ok(body: Value) -> Value {
    json!({ "status": 200, "body": body })
}

fn missing() -> Value {
    json!({ "status": 404, "body": { "error": { "code": "not_found", "message": "Not here" } } })
}

/// The directory node: its one session is `task-1`.
fn work_answers() -> Answerer {
    Arc::new(move |request: &Value| {
        let method = request["method"].as_str().unwrap_or_default();
        let url = request["url"].as_str().unwrap_or_default();
        match (method, url) {
            ("POST", "/api/sessions") => {
                json!({ "status": 201, "body": { "session": { "id": "task-1" } } })
            }
            ("POST", "/api/sessions/task-1/control/acquire") => ok(json!({ "lease": {
                "clientId": request["payload"]["clientId"], "generation": 1,
                "expiresAt": 4_000_000_000_000u64 } })),
            _ => missing(),
        }
    })
}

fn work_registration() -> Value {
    json!({ "type": "register", "role": "node", "protocol": pirc_protocol::NODE_PROTOCOL_VERSION, "modes": ["directory"],
        "workspaces": [
            { "id": "repo", "displayName": "Repo", "mode": "directory",
                "roles": [{ "name": "general", "description": "General work" }] },
        ] })
}

async fn wait_for_nodes(api: &Api, count: u64) {
    let deadline = Instant::now() + WAIT;
    loop {
        let health = api
            .send("GET", "/api/health", &browser_headers(), None)
            .await;
        if health.body["nodes"] == count {
            return;
        }
        assert!(Instant::now() < deadline, "nodes did not become {count}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn delegations() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        env: vec![(
            "PIRC_NODE_TOKENS",
            json!({ "work": WORK_TOKEN }).to_string(),
        )],
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
    let mut work = FakeNode::connect(
        &api,
        "work",
        WORK_TOKEN,
        work_registration(),
        work_answers(),
    )
    .await;
    wait_for_nodes(&api, 1).await;
    let created = api
        .send(
            "POST",
            "/api/sessions",
            &browser,
            Some(json!({ "workspaceId": "work:repo" })),
        )
        .await;
    assert_eq!(created.status, 201, "{}", created.body);
    work.request().await;
    let session = created.body["session"]["id"].as_str().unwrap().to_owned();

    // Agents no longer delegate: the brain calls workers itself.
    for (step, op, args) in [
        (
            "delegation.create is gone",
            "delegation.create",
            json!({ "workspace": "Repo", "task": "Fix the flaky test." }),
        ),
        ("delegation.status is gone", "delegation.status", json!({})),
    ] {
        let answer = work.op("task-1", op, args.clone()).await;
        t.note(step, json!({ "op": op, "args": args, "answer": answer }));
    }

    // Web search: no key on this gateway.
    for (step, args) in [
        ("web search without a key", json!({ "query": " bun test " })),
        ("web search with a blank query", json!({ "query": "  " })),
        (
            "web search with both domain lists",
            json!({ "query": "x", "includeDomains": ["a.com"], "excludeDomains": ["b.com"] }),
        ),
        (
            "web search with a bad date",
            json!({ "query": "x", "publishedAfter": "yesterday" }),
        ),
        (
            "web search with unknown arguments",
            json!({ "query": "x", "extra": 1 }),
        ),
    ] {
        let answer = work.op("task-1", "web.search", args.clone()).await;
        t.note(step, json!({ "args": args, "answer": answer }));
    }

    // Routes for workers that exist: there are none.
    let stopped = api
        .send("POST", "/api/delegations/dnope/stop", &browser, None)
        .await;
    t.response(
        "stop an unknown worker",
        "POST /api/delegations/dnope/stop",
        &stopped,
    );
    for (step, path, body) in [
        (
            "say something in an unknown thread",
            "/api/threads/thread_nope/messages",
            json!({ "text": "hello" }),
        ),
        (
            "answer in an unknown thread",
            "/api/threads/thread_nope/answer",
            json!({ "interactionId": "x", "answer": { "confirmed": true } }),
        ),
    ] {
        let refused = api.send("POST", path, &browser, Some(body)).await;
        t.response(step, &format!("POST {path}"), &refused);
    }
    let listed = api
        .send("GET", "/api/workers?status=all", &browser, None)
        .await;
    t.response("no workers", "GET /api/workers?status=all", &listed);
    let _ = session;

    work.close();
    insta::assert_json_snapshot!("delegations", t.into_value());
}
