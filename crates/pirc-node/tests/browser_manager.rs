//! `BrowserManager` against a real Chromium: the real-browser half of
//! `browser.test.ts`, and `browser.integration.test.ts`'s browser side (a
//! fetch, a handoff the user ends from the viewer after navigating, the
//! live view). The agent, its `ptc` scripts and the session lease around
//! them are the conformance scenarios' (`pirc-conformance`,
//! `node_browser.rs`).
//!
//! Skipped (with a message) when no Chromium is found the way the node
//! finds one (`PIRC_BROWSER_EXECUTABLE`, else `chromium`, … on `PATH`, else
//! the macOS application bundles); the recording test also needs `ffmpeg`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pirc_config::{Env, NodeConfig};
use pirc_node::browser::manager::BrowserManager;
use pirc_node::browser::{BrowserService, BrowserTarget, FrameSink};
use pirc_protocol::NodeRole;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

/// The node's configuration for a test: the process's `PATH`, `HOME` and
/// browser variables, state under `root`, loopback `127.0.0.1` allowed.
fn config(root: &Path, extra: &[(&str, &str)]) -> (NodeConfig, Env) {
    for dir in ["state", "config", "home"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let path = |name: &str| root.join(name).display().to_string();
    let (state, config, home) = (path("state"), path("config"), path("home"));
    let inherited: Vec<(String, String)> = ["PATH", "PIRC_BROWSER_EXECUTABLE", "LANG", "TZ"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    let mut vars: Vec<(&str, &str)> = inherited
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    vars.extend([
        ("PIRC_NODE_ID", "test-node"),
        ("PIRC_NODE_TOKEN", "0123456789abcdef0123456789abcdef"),
        ("PIRC_DAEMON_URL", "ws://127.0.0.1:8787"),
        ("PIRC_ALLOWED_USERS", "test-user"),
        ("PIRC_STATE_DIR", state.as_str()),
        ("PIRC_CONFIG_DIR", config.as_str()),
        ("HOME", home.as_str()),
        ("PIRC_BROWSER_VIEWPORT", "800x600"),
        // The test server is on loopback, which the browser refuses by default.
        ("PIRC_BROWSER_ALLOW_PRIVATE", "127.0.0.1"),
    ]);
    vars.extend_from_slice(extra);
    let env = Env::new(vars, root);
    (NodeConfig::load(&env, NodeRole::Node).unwrap(), env)
}

/// The manager, or `None` (and a message) without a Chromium.
fn chromium(root: &Path, extra: &[(&str, &str)]) -> Option<Arc<BrowserManager>> {
    let (config, env) = config(root, extra);
    match &config.browser.executable {
        Some(executable) if executable.is_file() => {}
        _ => {
            eprintln!("skipping: no Chromium found (set PIRC_BROWSER_EXECUTABLE)");
            return None;
        }
    }
    let manager = BrowserManager::new(&config, &env);
    assert!(manager.enabled());
    Some(Arc::new(manager))
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// `browser.test.ts`'s pages.
fn page(path: &str, query: &str, port: u16) -> Result<String, String> {
    let param = |name: &str| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
            .map(|value| {
                url::form_urlencoded::parse(format!("v={value}").as_bytes())
                    .next()
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    };
    Ok(match path {
        "/login" => "<!doctype html><title>Login</title><form><label>User <input name=u></label><label>Password <input type=password name=p value=\"hunter2\"></label></form>".to_owned(),
        "/toggled" => "<!doctype html><title>Toggled</title><label>Secret <input type=text name=password value=\"hunter2\"></label><input aria-label=Note name=note>".to_owned(),
        // To a host the guard blocks (only 127.0.0.1 is allowed).
        "/redirect" => return Err(format!("http://localhost:{port}/done?q=private")),
        "/done" => format!("<!doctype html><title>Done</title><h1>Thanks {}</h1>", param("q")),
        "/docs" => "<!doctype html><title>Docs</title><main><h1>Install</h1><p>Run <code>pirc node</code>.</p></main>".to_owned(),
        "/docs-login" => "<!doctype html><title>Login</title><input type=password aria-label=Password>".to_owned(),
        _ => "<!doctype html><title>Home</title><main><h1>Hello</h1><p>Some <b>bold</b> text and a <a href=\"/done?q=link\">link</a>.</p>\n<ul><li>one</li><li>two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>\n<form action=\"/done\"><input name=q aria-label=Query><select name=s aria-label=Size><option>S</option><option>M</option></select><button>Go</button></form>\n<script>document.querySelector('h1').insertAdjacentHTML('afterend','<p id=js>Rendered by JS</p>')</script></main>".to_owned(),
    })
}

/// A tiny HTTP/1.1 server for the pages on `127.0.0.1`.
async fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buffer[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let target = text.split(' ').nth(1).unwrap_or("/");
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                let response = match page(path, query, port) {
                    Ok(body) => format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    Err(location) => format!(
                        "HTTP/1.1 302 Found\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    ),
                };
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    port
}

struct Viewer {
    frames: Arc<Mutex<Vec<Value>>>,
}

impl Viewer {
    fn sink(&self) -> FrameSink {
        let frames = self.frames.clone();
        Arc::new(move |frame| frames.lock().unwrap().push(frame))
    }

    fn any(&self, test: impl Fn(&Value) -> bool) -> bool {
        self.frames.lock().unwrap().iter().any(test)
    }

    async fn wait_for(&self, what: &str, test: impl Fn(&Value) -> bool) {
        for _ in 0..200 {
            if self.any(&test) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no frame: {what}");
    }
}

fn viewer() -> Viewer {
    Viewer {
        frames: Arc::new(Mutex::new(Vec::new())),
    }
}

fn reference(snapshot: &Value, role_and_name: &str) -> String {
    let text = snapshot.as_str().unwrap();
    let start = text
        .find(&format!("{role_and_name} [ref="))
        .unwrap_or_else(|| panic!("no {role_and_name} in {text}"))
        + role_and_name.len()
        + " [ref=".len();
    text[start..].split(']').next().unwrap().to_owned()
}

async fn handle(manager: &BrowserManager, target: &BrowserTarget, op: &str, args: Value) -> Value {
    manager
        .handle(target.clone(), op.into(), args)
        .await
        .unwrap_or_else(|error| panic!("{op}: {error}"))
}

async fn refused(
    manager: &BrowserManager,
    target: &BrowserTarget,
    op: &str,
    args: Value,
) -> pirc_node::error::ApiError {
    manager
        .handle(target.clone(), op.into(), args)
        .await
        .expect_err(op)
}

#[test]
fn reports_no_browser_when_disabled() {
    let root = tempfile::tempdir().unwrap();
    let (config, env) = config(root.path(), &[("PIRC_BROWSER", "false")]);
    assert!(!BrowserManager::new(&config, &env).enabled());
    // An explicit executable counts, found or not (TS: `Boolean(executable)`).
    let (config, env) = config_with_executable(root.path());
    assert!(BrowserManager::new(&config, &env).enabled());
}

fn config_with_executable(root: &Path) -> (NodeConfig, Env) {
    config(
        root,
        &[("PIRC_BROWSER_EXECUTABLE", "/nonexistent/chromium")],
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drives_a_real_chromium() {
    let dir = tempfile::tempdir().unwrap();
    let Some(manager) = chromium(dir.path(), &[]) else {
        return;
    };
    let port = serve().await;
    let base = format!("http://127.0.0.1:{port}");
    let root = dir.path().join("root");
    std::fs::create_dir_all(&root).unwrap();
    let target = BrowserTarget {
        session_id: "s1".into(),
        workspace_id: "w1".into(),
        root: root.clone(),
    };

    // Fetches a JS-rendered page as markdown.
    let result = handle(
        &manager,
        &target,
        "fetch",
        json!({ "url": format!("{base}/") }),
    )
    .await;
    assert_eq!(result["title"], "Home");
    assert_eq!(result["status"], 200);
    let content = result["content"].as_str().unwrap();
    for expected in [
        "# Hello".to_owned(),
        "Rendered by JS".to_owned(),
        "**bold**".to_owned(),
        format!("[link]({base}/done?q=link)"),
        "- one".to_owned(),
        "| a | b |".to_owned(),
    ] {
        assert!(content.contains(&expected), "{expected} in {content}");
    }
    let clipped = handle(
        &manager,
        &target,
        "fetch",
        json!({ "url": format!("{base}/"), "maxChars": 1000, "offset": 5, "format": "text" }),
    )
    .await;
    assert_eq!(
        (&clipped["offset"], &clipped["format"]),
        (&json!(5), &json!("text"))
    );

    // Drives a form through snapshot refs.
    let snap = handle(&manager, &target, "snapshot", json!({})).await;
    let query = reference(&snap["snapshot"], "textbox \"Query\"");
    let size = reference(&snap["snapshot"], "combobox \"Size\"");
    handle(
        &manager,
        &target,
        "select",
        json!({ "ref": size, "values": ["M"], "snapshot": false }),
    )
    .await;
    let after = handle(
        &manager,
        &target,
        "type",
        json!({ "ref": query, "text": "你好", "submit": true }),
    )
    .await;
    assert!(
        after["url"]
            .as_str()
            .unwrap()
            .contains("/done?q=%E4%BD%A0%E5%A5%BD&s=M"),
        "{after}"
    );
    assert!(after["snapshot"].as_str().unwrap().contains("Thanks 你好"));
    let shot = handle(&manager, &target, "screenshot", json!({})).await;
    assert_eq!(shot["mimeType"], "image/jpeg");
    use base64::Engine as _;
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(shot["image"].as_str().unwrap())
        .unwrap();
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);

    // Masks passwords and refuses to type them.
    let login = handle(
        &manager,
        &target,
        "navigate",
        json!({ "url": format!("{base}/login") }),
    )
    .await;
    let snapshot = login["snapshot"].as_str().unwrap();
    assert!(
        !snapshot.contains("hunter2") && snapshot.contains("••••••"),
        "{snapshot}"
    );
    let pass = reference(&login["snapshot"], "textbox \"Password\"");
    let error = refused(
        &manager,
        &target,
        "type",
        json!({ "ref": pass, "text": "x" }),
    )
    .await;
    assert_eq!((error.status, &*error.code), (403, "password_field"));

    // Refuses keys on a focused secret field, and fields toggled to text.
    handle(
        &manager,
        &target,
        "click",
        json!({ "ref": pass, "snapshot": false }),
    )
    .await;
    let error = refused(&manager, &target, "press", json!({ "key": "a" })).await;
    assert_eq!(&*error.code, "password_field");
    handle(
        &manager,
        &target,
        "press",
        json!({ "key": "Tab", "snapshot": false }),
    )
    .await;
    let toggled = handle(
        &manager,
        &target,
        "navigate",
        json!({ "url": format!("{base}/toggled") }),
    )
    .await;
    let secret = reference(&toggled["snapshot"], "textbox \"Secret\"");
    let note = reference(&toggled["snapshot"], "textbox \"Note\"");
    let error = refused(
        &manager,
        &target,
        "type",
        json!({ "ref": secret, "text": "x" }),
    )
    .await;
    assert_eq!(&*error.code, "password_field");
    handle(
        &manager,
        &target,
        "type",
        json!({ "ref": note, "text": "fine", "snapshot": false }),
    )
    .await;
    handle(
        &manager,
        &target,
        "press",
        json!({ "key": "a", "snapshot": false }),
    )
    .await;

    // Refuses private hosts, before navigating and after a redirect.
    let error = refused(
        &manager,
        &target,
        "navigate",
        json!({ "url": format!("http://localhost:{port}/") }),
    )
    .await;
    assert_eq!(error.status, 403);
    assert!(error.message.contains("loopback"), "{}", error.message);
    let error = refused(
        &manager,
        &target,
        "fetch",
        json!({ "url": "http://169.254.169.254/latest/meta-data/" }),
    )
    .await;
    assert_eq!(error.status, 403);
    let error = refused(
        &manager,
        &target,
        "fetch",
        json!({ "url": format!("{base}/redirect") }),
    )
    .await;
    assert_eq!(error.status, 403);
    let status = handle(&manager, &target, "status", json!({})).await;
    assert!(!status["url"].as_str().unwrap().contains("private"));

    // Streams frames to viewers, and makes the agent wait while the user
    // has control.
    let watcher = viewer();
    let detach = manager.attach("s1", watcher.sink());
    assert_eq!(watcher.frames.lock().unwrap()[0]["state"]["active"], true);
    assert!(watcher.any(|frame| frame["type"] == "log"));
    let answer = manager
        .input(target.clone(), json!({ "type": "text", "text": "x" }))
        .await
        .unwrap();
    assert_eq!(answer.unwrap()["code"], "agent_in_control");
    manager
        .input(target.clone(), json!({ "type": "takeover" }))
        .await
        .unwrap();
    manager
        .input(
            target.clone(),
            json!({ "type": "navigate", "url": format!("{base}/") }),
        )
        .await
        .unwrap();
    let pending = {
        let manager = manager.clone();
        let target = target.clone();
        tokio::spawn(async move { manager.handle(target, "snapshot".into(), json!({})).await })
    };
    watcher
        .wait_for("agent waiting", |frame| {
            frame["type"] == "state"
                && frame["state"]["mode"] == "user"
                && frame["state"]["agentWaiting"] == true
        })
        .await;
    manager
        .input(target.clone(), json!({ "type": "release" }))
        .await
        .unwrap();
    let snap = pending.await.unwrap().unwrap();
    assert_eq!(snap["title"], "Home");
    watcher
        .wait_for("a screencast frame", |frame| {
            frame["type"] == "frame" && frame["width"] == 800
        })
        .await;
    let entry = watcher
        .frames
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|frame| frame["type"] == "log_entry" && frame["entry"]["image"] == true)
        .cloned()
        .expect("a log entry with an image");
    let image = manager
        .input(
            target.clone(),
            json!({ "type": "log_image", "index": entry["entry"]["index"] }),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(image["data"].as_str().is_some_and(|data| !data.is_empty()));
    detach();

    // Hands off to the user and resumes when control returns.
    handle(
        &manager,
        &target,
        "handoff",
        json!({ "reason": "Please log in" }),
    )
    .await;
    let waiting = {
        let manager = manager.clone();
        let target = target.clone();
        tokio::spawn(async move {
            manager
                .handle(target, "wait_control".into(), json!({}))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiting.is_finished());
    let status = handle(&manager, &target, "status", json!({})).await;
    assert_eq!(
        (&status["mode"], &status["handoff"]),
        (&json!("user"), &json!("Please log in"))
    );
    manager
        .input(target.clone(), json!({ "type": "release" }))
        .await
        .unwrap();
    waiting.await.unwrap().unwrap();
    // Timeouts give the agent a clear error.
    manager
        .input(target.clone(), json!({ "type": "takeover" }))
        .await
        .unwrap();
    let error = refused(&manager, &target, "snapshot", json!({ "waitMs": 50 })).await;
    assert_eq!(&*error.code, "user_in_control");
    manager
        .input(target.clone(), json!({ "type": "release" }))
        .await
        .unwrap();

    // Records a paced WebM into .pirc/recordings.
    if which("ffmpeg").is_some() {
        let started = handle(
            &manager,
            &target,
            "record",
            json!({ "action": "start", "name": "demo" }),
        )
        .await;
        let path = started["path"].as_str().unwrap().to_owned();
        assert!(
            path.starts_with(".pirc/recordings/demo-") && path.ends_with(".webm"),
            "{path}"
        );
        handle(
            &manager,
            &target,
            "navigate",
            json!({ "url": format!("{base}/done?q=rec") }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let stopped = handle(&manager, &target, "record", json!({ "action": "stop" })).await;
        assert!(stopped["bytes"].as_u64().unwrap() > 500, "{stopped}");
        assert!(stopped["durationMs"].as_i64().unwrap() > 1000);
        let file = root.join(stopped["path"].as_str().unwrap());
        assert!(file.is_file());
        if let Some(ffprobe) = which("ffprobe") {
            let probe = std::process::Command::new(ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&file)
                .output()
                .unwrap();
            if probe.status.success() {
                // Paced at a fixed rate: about as long as the wall-clock recording.
                let duration: f64 = String::from_utf8_lossy(&probe.stdout)
                    .trim()
                    .parse()
                    .unwrap_or(0.0);
                assert!(duration > 0.8, "{duration}");
            }
        }
    } else {
        eprintln!("skipping the recording: no ffmpeg on PATH");
    }

    // Shares one profile per workspace and closes cleanly.
    let other = BrowserTarget {
        session_id: "s2".into(),
        ..target.clone()
    };
    let result = handle(
        &manager,
        &other,
        "navigate",
        json!({ "url": format!("{base}/done?q=2") }),
    )
    .await;
    assert_eq!(result["title"], "Done");
    // Session 1's page is untouched.
    let status = handle(&manager, &target, "status", json!({})).await;
    assert!(!status["url"].as_str().unwrap().contains("q=2"));
    assert_eq!(
        handle(&manager, &other, "close", json!({})).await,
        json!({ "closed": true })
    );
    assert_eq!(
        handle(&manager, &other, "status", json!({})).await["active"],
        false
    );
    manager.shutdown().await;
}

/// `browser.integration.test.ts` at the manager: the agent fetches docs,
/// hands off; the viewer sees the handoff, navigates while in control and
/// returns control; the agent's wait resumes on the page the user left.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resumes_a_handoff_after_the_user_returns_control() {
    let dir = tempfile::tempdir().unwrap();
    let Some(manager) = chromium(dir.path(), &[]) else {
        return;
    };
    let port = serve().await;
    let url = format!("http://127.0.0.1:{port}");
    let target = BrowserTarget {
        session_id: "session".into(),
        workspace_id: "test".into(),
        root: dir.path().to_owned(),
    };
    let watcher = viewer();
    let detach = manager.attach("session", watcher.sink());
    assert_eq!(watcher.frames.lock().unwrap()[0]["state"]["active"], false);

    let docs = handle(
        &manager,
        &target,
        "fetch",
        json!({ "url": format!("{url}/docs") }),
    )
    .await;
    let content = docs["content"].as_str().unwrap();
    assert!(
        content.contains("# Install") && content.contains("`pirc node`"),
        "{content}"
    );
    handle(&manager, &target, "handoff", json!({ "reason": "請登入" })).await;
    let waiting = {
        let manager = manager.clone();
        let target = target.clone();
        tokio::spawn(async move {
            manager
                .handle(target, "wait_control".into(), json!({}))
                .await
        })
    };
    watcher
        .wait_for("the handoff", |frame| {
            frame["type"] == "state"
                && frame["state"]["mode"] == "user"
                && frame["state"]["handoff"] == "請登入"
        })
        .await;
    manager
        .input(
            target.clone(),
            json!({ "type": "navigate", "url": format!("{url}/docs-login") }),
        )
        .await
        .unwrap();
    watcher
        .wait_for("the user's page", |frame| {
            frame["type"] == "state"
                && frame["state"]["url"]
                    .as_str()
                    .is_some_and(|u| u.ends_with("/docs-login"))
        })
        .await;
    manager
        .input(target.clone(), json!({ "type": "release" }))
        .await
        .unwrap();
    let resumed = waiting.await.unwrap().unwrap();
    assert!(
        resumed["url"].as_str().unwrap().ends_with("/docs-login"),
        "{resumed}"
    );
    assert!(watcher.any(|frame| frame["type"] == "frame"));
    assert!(watcher.any(|frame| frame["type"] == "log_entry"
        && frame["entry"]["action"] == format!("Navigate to {url}/docs-login")
        && frame["entry"]["actor"] == "user"));
    detach();
    manager.shutdown().await;
}
