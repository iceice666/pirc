//! The files people send into a room reach the worker the brain calls for
//! them, through every hop: the room's upload, the message's attachment, the
//! brain's prompt, `call_worker`, the gateway's copy into the worker's node
//! session, and the node's copy into the agent's workspace under
//! `.pirc/uploads` (which the task names). A file from an earlier message
//! travels when the brain names its upload id. An image stays in the room, as
//! before: a worker is handed files.

use std::time::{Duration, Instant};

use pirc_conformance::{Api, Cluster, GatewayOptions, Reply, WORKSPACE_ID, browser_headers};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(30);
/// The page a person attached: a non-image file, which is what a worker can read.
const HTML: &str = "<!doctype html>\n<html>\n<head><title>pirc rooms — Discord-shaped UI</title></head>\n<body><h1>Rooms</h1></body>\n</html>\n";
/// A valid 1x1 PNG.
const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FILE_NAME: &str = "pirc rooms — Discord-shaped UI.html";

fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Until `check` answers, at most [`WAIT`].
async fn wait_for<T>(what: &str, mut check: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(value) = check().await {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The files the node keeps for a session's agent, as listed.
async fn workspace_files(api: &Api, session: &str) -> Vec<String> {
    let headers = browser_headers();
    let listed = api
        .send(
            "GET",
            &format!("/api/sessions/{session}/files?path=.pirc/uploads"),
            &headers,
            None,
        )
        .await;
    listed.body["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["name"].as_str().map(str::to_owned))
        .collect()
}

/// A worker's task (the custom message the gateway delivered), from its history.
async fn task_of(api: &Api, session: &str) -> String {
    let headers = browser_headers();
    let snapshot = api
        .send(
            "GET",
            &format!("/api/sessions/{session}/snapshot"),
            &headers,
            None,
        )
        .await;
    snapshot.body["history"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|message| message["customType"] == "assistant-delegation")
        .and_then(|message| message["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// The worker called `title`, once it has a session.
async fn worker(api: &Api, title: &str) -> Value {
    let headers = browser_headers();
    wait_for("a worker", || async {
        let listed = api
            .send("GET", "/api/workers?status=all", &headers, None)
            .await;
        listed.body["workers"]
            .as_array()?
            .iter()
            .find(|worker| worker["title"] == title && !worker["targetSessionId"].is_null())
            .cloned()
    })
    .await
}

/// Wait until the room's latest brain turn ended.
async fn brain_idle(api: &Api) {
    let headers = browser_headers();
    wait_for("the brain's turn to end", || async {
        let turns = api
            .send(
                "GET",
                "/api/brain/turns?room=general&limit=1",
                &headers,
                None,
            )
            .await;
        let turn = turns.body["turns"].as_array()?.first()?;
        (!turn["endedAt"].is_null()).then_some(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_room_file_reaches_the_worker() {
    use base64::Engine as _;
    let Some(cluster) = Cluster::start_with(GatewayOptions::default()).await else {
        return;
    };
    let config = cluster.dir.path().join("gateway-config");
    std::fs::write(config.join("brain.json"), r#"{ "debounceSeconds": 0.2 }"#).unwrap();
    let api = cluster.api();
    let me = browser_headers();

    // A person attaches an HTML file (and an image) to their request.
    let uploaded = api
        .send_bytes(
            "POST",
            &format!("/api/rooms/general/uploads?filename={}", encode(FILE_NAME)),
            &me,
            Some("text/html"),
            HTML.as_bytes().to_vec(),
        )
        .await;
    assert_eq!(uploaded.status, 201, "{:?}", uploaded.body);
    assert_eq!(uploaded.body["upload"]["filename"], FILE_NAME);
    let file = uploaded.body["upload"]["id"].as_str().unwrap().to_owned();
    let png = base64::engine::general_purpose::STANDARD
        .decode(PNG_1X1)
        .unwrap();
    let image = api
        .send_bytes(
            "POST",
            "/api/rooms/general/uploads",
            &me,
            Some("image/png"),
            png,
        )
        .await;
    assert_eq!(image.status, 201, "{:?}", image.body);
    let image = image.body["upload"]["id"].as_str().unwrap().to_owned();

    // The brain calls a worker for it without naming the file: what the
    // request carried goes with the task.
    cluster.llm.push([
        Reply::Tool {
            id: "call_1".into(),
            name: "call_worker".into(),
            args: json!({
                "workspace": WORKSPACE_ID,
                "task": "Rework the rooms UI from the HTML file sent with this request; read it first.",
                "title": "Rework the rooms UI",
                "quote": "rework the rooms UI from the file I sent",
            }),
        },
        Reply::Text("I asked a worker to rework it.".to_owned()),
    ]);
    let sent = api
        .send(
            "POST",
            "/api/rooms/general/messages",
            &me,
            Some(json!({
                "text": "rework the rooms UI from the file I sent",
                "attachments": [file.clone(), image.clone()],
                "immediate": true,
            })),
        )
        .await;
    assert_eq!(sent.status, 201, "{:?}", sent.body);

    // The brain saw the file and its upload id in what the person said.
    let prompted = wait_for("the brain's first model call", || async {
        cluster.llm.requests().first().map(Value::to_string)
    })
    .await;
    assert!(
        prompted.contains(&format!("(upload {file})")),
        "the brain's input names the upload: {prompted}"
    );

    let first = worker(&api, "Rework the rooms UI").await;
    let session = first["targetSessionId"].as_str().unwrap().to_owned();
    let name = wait_for("the file in the worker's workspace", || async {
        workspace_files(&api, &session).await.first().cloned()
    })
    .await;
    // The node names its copy after its own upload, and keeps the file's name.
    assert!(
        name.ends_with(&format!("-{FILE_NAME}")),
        "the copy keeps the file's name: {name}"
    );
    assert!(
        !name.contains(&image),
        "the image stays in the room: {name}"
    );
    assert_eq!(workspace_files(&api, &session).await.len(), 1);
    let content = api
        .send(
            "GET",
            &format!(
                "/api/sessions/{session}/files/content?path={}",
                encode(&format!(".pirc/uploads/{name}"))
            ),
            &me,
            None,
        )
        .await;
    assert_eq!(content.status, 200, "{:?}", content.body);
    assert_eq!(content.body["content"], HTML, "the copy is the file");
    assert_eq!(content.body["size"], HTML.len());
    assert_eq!(content.body["binary"], false);

    // The task says what came with it and where the node put it.
    let task = task_of(&api, &session).await;
    for expected in [
        "## Files sent with the request".to_owned(),
        format!("- {FILE_NAME} (text/html)"),
        format!("- .pirc/uploads/{name}"),
    ] {
        assert!(
            task.contains(&expected),
            "{expected:?} is in the task: {task}"
        );
    }
    // And the brain was told the file goes with the task, though it named none.
    wait_for("the brain to hear what the worker got", || async {
        cluster
            .llm
            .requests()
            .iter()
            .any(|request| request.to_string().contains("1 file goes with it."))
            .then_some(())
    })
    .await;

    // A file from an earlier message travels when the brain names its upload id.
    brain_idle(&api).await;
    cluster.llm.push([
        Reply::Tool {
            id: "call_2".into(),
            name: "call_worker".into(),
            args: json!({
                "workspace": WORKSPACE_ID,
                "task": "Use the file from the earlier message again; it is handed over with this task.",
                "title": "The same file again",
                "quote": "use the same file again",
                "attachments": [file.clone()],
            }),
        },
        Reply::Text("Asked again.".to_owned()),
    ]);
    let sent = api
        .send(
            "POST",
            "/api/rooms/general/messages",
            &me,
            Some(json!({ "text": "use the same file again", "immediate": true })),
        )
        .await;
    assert_eq!(sent.status, 201, "{:?}", sent.body);
    let again = worker(&api, "The same file again").await;
    let session = again["targetSessionId"].as_str().unwrap().to_owned();
    let name = wait_for(
        "the named file in the second worker's workspace",
        || async { workspace_files(&api, &session).await.first().cloned() },
    )
    .await;
    assert!(name.ends_with(&format!("-{FILE_NAME}")), "{name}");
    assert!(
        task_of(&api, &session)
            .await
            .contains(&format!("- .pirc/uploads/{name}")),
        "the second task names its copy"
    );
}
