//! The golden browser corpus (`tests/fixtures/browser/`, recorded from
//! Playwright 1.63.0 by `scripts/browser-reference.ts`) replayed against
//! the Rust engine: every case of `cases/` runs in a new page of one
//! context launched as `browser.ts` launches it (viewport 1280x800, the
//! host guard with loopback allowed, the action overlay with 600 ms), the
//! pages served as the fixtures' README says, and what each step returns
//! must equal `expected/` (only `{{HOST_A}}`/`{{HOST_B}}` are normalized).
//! The goldens are Linux recordings; on macOS, the steps that Playwright
//! itself does differently there (the mac editing commands of `Control+a`)
//! are taken from `expected/<case>.macos.json` (see the fixtures' README).
//!
//! Skipped, with a message, when no Chromium is found (`chromium`,
//! `chromium-browser`, `google-chrome-stable`, `google-chrome`,
//! `microsoft-edge` on PATH, the macOS application bundles, or
//! `PIRC_BROWSER_EXECUTABLE`). `PIRC_BROWSER_CORPUS=form,oopif` runs some
//! cases only.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use pirc_node::browser::assets::{PAGE_MARKDOWN, PASSWORD_VALUES, SENSITIVE_FIELD};
use pirc_node::browser::engine::LoadState;
use pirc_node::browser::engine::MouseButton;
use pirc_node::browser::engine::context::{Context, LaunchOptions};
use pirc_node::browser::engine::frame::Frame;
use pirc_node::browser::engine::locator::{Locator, WaitState};
use pirc_node::browser::engine::page::Page;
use pirc_node::browser::engine::screencast::{self, ShowActions};
use pirc_node::browser::engine::snapshot;
use pirc_node::browser::hosts::{HostGuard, system_resolver};
use pirc_node::browser::util::{clean_error, mask_passwords};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// `browser.ts`'s action timeout.
const ACTION_TIMEOUT: u64 = 10_000;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/browser")
}

fn chromium() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PIRC_BROWSER_EXECUTABLE") {
        return Some(explicit.into());
    }
    let path = std::env::var_os("PATH")?;
    for name in [
        "chromium",
        "chromium-browser",
        "google-chrome-stable",
        "google-chrome",
        "microsoft-edge",
    ] {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    [
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|candidate| candidate.is_file())
}

// ---- fixture server -------------------------------------------------------------

/// One response: status, content type (none for a redirect), extra
/// headers, body.
struct Reply {
    status: u16,
    content_type: Option<&'static str>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn text(status: u16, content_type: &'static str, body: impl Into<Vec<u8>>) -> Reply {
    Reply {
        status,
        content_type: Some(content_type),
        headers: Vec::new(),
        body: body.into(),
    }
}

async fn route(target: &str, port: u16) -> Reply {
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1:{port}{target}")) else {
        return text(404, "text/plain; charset=utf-8", "Not found");
    };
    let query = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let path = url.path();
    if path == "/slow" {
        let ms = query("ms")
            .and_then(|ms| ms.parse::<f64>().ok())
            .filter(|ms| ms.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, 10_000.0);
        tokio::time::sleep(Duration::from_millis(ms as u64)).await;
        let mut reply = text(
            200,
            "text/plain; charset=utf-8",
            query("text").unwrap_or_default(),
        );
        reply
            .headers
            .push(("cache-control".into(), "no-store".into()));
        return reply;
    }
    if path == "/redirect" {
        return Reply {
            status: 302,
            content_type: None,
            headers: vec![("location".into(), query("to").unwrap_or("/".into()))],
            body: Vec::new(),
        };
    }
    if let Some(code) = path.strip_prefix("/status/")
        && code.len() == 3
        && code.bytes().all(|b| b.is_ascii_digit())
    {
        let code: u16 = code.parse().unwrap();
        return text(
            code,
            "text/html; charset=utf-8",
            format!("<!doctype html><title>Status {code}</title><p>Status {code}</p>"),
        );
    }
    let name = &path[1..];
    let valid = name.strip_suffix(".html").is_some_and(|stem| {
        !stem.is_empty()
            && stem
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    if valid && let Ok(html) = std::fs::read_to_string(fixtures().join("pages").join(name)) {
        let html = html
            .replace("{{HOST_A}}", &format!("127.0.0.1:{port}"))
            .replace("{{HOST_B}}", &format!("localhost:{port}"))
            .replace("{{PORT}}", &port.to_string());
        let mut reply = text(200, "text/html; charset=utf-8", html);
        reply
            .headers
            .push(("cache-control".into(), "no-store".into()));
        return reply;
    }
    text(404, "text/plain; charset=utf-8", "Not found")
}

async fn respond(mut stream: TcpStream, port: u16) {
    let mut head = Vec::new();
    let mut buffer = [0u8; 4096];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&buffer[..n]),
        }
    }
    let head = String::from_utf8_lossy(&head);
    let target = head.split(' ').nth(1).unwrap_or("/").to_owned();
    let reply = route(&target, port).await;
    let mut out = format!(
        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reply.body.len()
    );
    if let Some(content_type) = reply.content_type {
        out.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    for (name, value) in &reply.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(&reply.body);
    let _ = stream.write_all(&bytes).await;
    let _ = stream.shutdown().await;
}

async fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(respond(stream, port));
        }
    });
    port
}

// ---- runner ------------------------------------------------------------------------

struct Runner {
    page: Arc<Page>,
    host_a: String,
    host_b: String,
    latest: String,
    snapshots: std::collections::HashMap<String, String>,
}

fn str_of<'a>(step: &'a Value, name: &str) -> Option<&'a str> {
    step.get(name).and_then(Value::as_str)
}

/// The manager's `without_argument`: `evaluate(fn)` passes `undefined`.
fn without_argument(function: &str) -> String {
    format!("() => (\n{function}\n)()")
}

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

impl Runner {
    fn expand(&self, text: &str) -> String {
        text.replace("{{HOST_A}}", &self.host_a)
            .replace("{{HOST_B}}", &self.host_b)
    }

    fn normalize(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(
                text.replace(&self.host_a, "{{HOST_A}}")
                    .replace(&self.host_b, "{{HOST_B}}"),
            ),
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|v| self.normalize(v)).collect())
            }
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| (k, self.normalize(v)))
                    .collect(),
            ),
            other => other,
        }
    }

    /// The step's ref: literal, or the first line of the (named) snapshot
    /// matching `target` that has one.
    fn reference(&self, step: &Value) -> Result<String, String> {
        if let Some(reference) = str_of(step, "ref") {
            return Ok(reference.to_owned());
        }
        let target = str_of(step, "target").ok_or("step needs target or ref")?;
        let snapshot = match str_of(step, "in") {
            Some(name) => self
                .snapshots
                .get(name)
                .ok_or_else(|| format!("no snapshot named {name}"))?,
            None => &self.latest,
        };
        let pattern = regex_lite::Regex::new(target).map_err(|e| e.to_string())?;
        let reference = regex_lite::Regex::new(r"\[ref=([a-z0-9]+)\]").unwrap();
        for line in snapshot.split('\n') {
            if !pattern.is_match(line) {
                continue;
            }
            if let Some(found) = reference.captures(line) {
                return Ok(found[1].to_owned());
            }
        }
        Err(format!("no snapshot line with a ref matches /{target}/"))
    }

    fn locator(&self, reference: &str) -> Locator {
        Locator::aria_ref(&self.page, reference)
    }

    async fn settle(&self) {
        let _ = self
            .page
            .wait_for_load_state(LoadState::DomContentLoaded, ms(5_000))
            .await;
        tokio::time::sleep(ms(250)).await;
    }

    /// Run a step: what it recorded, or the engine's error (`Err(Ok)`), or
    /// a runner failure (`Err(Err)`).
    async fn run(
        &mut self,
        step: &Value,
        out: &mut Map<String, Value>,
    ) -> Result<(), Result<String, String>> {
        let engine = |error: pirc_node::browser::engine::Error| Ok(error.message);
        let op = str_of(step, "op").unwrap_or_default();
        let timeout = ms(step["timeout"].as_u64().unwrap_or(ACTION_TIMEOUT));
        let page = self.page.clone();
        match op {
            "goto" => {
                let url = self.expand(str_of(step, "url").unwrap_or_default());
                let response = page
                    .goto(
                        &url,
                        LoadState::DomContentLoaded,
                        ms(step["timeout"].as_u64().unwrap_or(30_000)),
                    )
                    .await
                    .map_err(engine)?;
                let _ = page
                    .wait_for_load_state(LoadState::NetworkIdle, ms(3_000))
                    .await;
                out.insert("status".into(), json!(response.map(|r| r.status)));
                out.insert("title".into(), json!(page.title().await.map_err(engine)?));
            }
            "back" => {
                let response = page
                    .go_back_response(LoadState::DomContentLoaded, ms(15_000))
                    .await
                    .map_err(engine)?;
                out.insert("response".into(), json!(response.map(|r| r.status)));
            }
            "snapshot" => {
                let mut snapshot = snapshot::aria_snapshot(&page, timeout)
                    .await
                    .map_err(engine)?;
                if step["mask"] == true {
                    let mut values = Vec::new();
                    for frame in page.frames() {
                        values.extend(strings(
                            frame
                                .evaluate(&without_argument(PASSWORD_VALUES), Value::Null)
                                .await
                                .unwrap_or_default(),
                        ));
                    }
                    snapshot = mask_passwords(&snapshot, &values);
                }
                self.latest = snapshot.clone();
                if let Some(name) = str_of(step, "name") {
                    self.snapshots.insert(name.to_owned(), snapshot.clone());
                }
                out.insert("snapshot".into(), json!(snapshot));
            }
            "click" => {
                let reference = self.reference(step).map_err(Err)?;
                out.insert("ref".into(), json!(reference));
                let button = MouseButton::parse(str_of(step, "button"));
                let count = if step["double"] == true { 2 } else { 1 };
                self.locator(&reference)
                    .click(button, count, timeout)
                    .await
                    .map_err(engine)?;
                self.settle().await;
            }
            "hover" => {
                let reference = self.reference(step).map_err(Err)?;
                out.insert("ref".into(), json!(reference));
                self.locator(&reference)
                    .hover(timeout)
                    .await
                    .map_err(engine)?;
            }
            "fill" => {
                let reference = self.reference(step).map_err(Err)?;
                out.insert("ref".into(), json!(reference));
                self.locator(&reference)
                    .fill(str_of(step, "text").unwrap_or_default(), timeout)
                    .await
                    .map_err(engine)?;
                self.settle().await;
            }
            "type" => {
                let reference = self.reference(step).map_err(Err)?;
                out.insert("ref".into(), json!(reference));
                let locator = self.locator(&reference);
                locator.fill("", timeout).await.map_err(engine)?;
                locator
                    .press_sequentially(
                        str_of(step, "text").unwrap_or_default(),
                        ms(20),
                        ms(step["timeout"].as_u64().unwrap_or(30_000)),
                    )
                    .await
                    .map_err(engine)?;
                self.settle().await;
            }
            "press" => {
                let reference = self.reference(step).map_err(Err)?;
                out.insert("ref".into(), json!(reference));
                self.locator(&reference)
                    .press(str_of(step, "key").unwrap_or_default(), timeout)
                    .await
                    .map_err(engine)?;
                self.settle().await;
            }
            "select" => {
                let reference = self.reference(step).map_err(Err)?;
                out.insert("ref".into(), json!(reference));
                self.locator(&reference)
                    .select_option(&strings(step["values"].clone()), timeout)
                    .await
                    .map_err(engine)?;
                self.settle().await;
            }
            "keyboard" => {
                page.keyboard()
                    .press(str_of(step, "key").unwrap_or_default(), Duration::ZERO)
                    .await
                    .map_err(engine)?;
                self.settle().await;
            }
            "insertText" => {
                page.keyboard()
                    .insert_text(str_of(step, "text").unwrap_or_default())
                    .await
                    .map_err(engine)?;
            }
            "waitFor" => {
                let (text, state) = match (str_of(step, "text"), str_of(step, "textGone")) {
                    (Some(text), _) => (text, WaitState::Visible),
                    (None, Some(gone)) => (gone, WaitState::Hidden),
                    _ => return Err(Err("waitFor needs text or textGone".into())),
                };
                Locator::text_first(&page, text)
                    .wait_for(state, timeout)
                    .await
                    .map_err(engine)?;
            }
            "evaluate" => {
                let result = self.evaluate(step).await?;
                out.insert("result".into(), result);
            }
            "frames" => {
                let frames = page.frames();
                let index = |frame: &Frame| frames.iter().position(|f| f.id() == frame.id());
                let list: Vec<Value> = frames
                    .iter()
                    .map(|frame| {
                        json!({
                            "url": frame.url(),
                            "name": frame.name(),
                            "parent": frame.parent().and_then(|parent| index(&parent)),
                        })
                    })
                    .collect();
                out.insert("frames".into(), Value::Array(list));
            }
            "targets" => {
                let targets = page
                    .session()
                    .call("Target.getTargets", json!({}))
                    .await
                    .map_err(|e| Err(e.message))?;
                let mut urls: Vec<String> = targets["targetInfos"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter(|info| info["type"] == "iframe")
                    .map(|info| info["url"].as_str().unwrap_or_default().to_owned())
                    .collect();
                urls.sort();
                out.insert("iframeTargets".into(), json!(urls));
            }
            "wait" => tokio::time::sleep(ms(step["timeout"].as_u64().unwrap_or(0))).await,
            other => return Err(Err(format!("unknown op {other}"))),
        }
        Ok(())
    }

    async fn evaluate(&mut self, step: &Value) -> Result<Value, Result<String, String>> {
        let engine = |error: pirc_node::browser::engine::Error| Ok(error.message);
        let page = self.page.clone();
        if let Some(expression) = str_of(step, "expression") {
            return page.evaluate(expression, Value::Null).await.map_err(engine);
        }
        let all = str_of(step, "frames") == Some("all");
        let per_frame = |function: &'static str, fallback: Value| {
            let page = page.clone();
            async move {
                if all {
                    let mut results = Vec::new();
                    for frame in page.frames() {
                        results.push(
                            frame
                                .evaluate(&without_argument(function), Value::Null)
                                .await
                                .unwrap_or(fallback.clone()),
                        );
                    }
                    Ok(Value::Array(results))
                } else {
                    page.main_frame()
                        .evaluate(&without_argument(function), Value::Null)
                        .await
                        .map_err(engine)
                }
            }
        };
        match str_of(step, "helper") {
            Some("pageMarkdown") => page
                .evaluate(&without_argument(PAGE_MARKDOWN), Value::Null)
                .await
                .map_err(engine),
            Some("innerText") => page
                .evaluate(
                    "() => globalThis.document.body?.innerText ?? ''",
                    Value::Null,
                )
                .await
                .map_err(engine),
            Some("content") => page.content().await.map(Value::String).map_err(engine),
            Some("passwordValues") => per_frame(PASSWORD_VALUES, json!([])).await,
            Some("sensitiveField") => {
                if step.get("target").is_some() || step.get("ref").is_some() {
                    let reference = self.reference(step).map_err(Err)?;
                    let timeout = ms(step["timeout"].as_u64().unwrap_or(ACTION_TIMEOUT));
                    return self
                        .locator(&reference)
                        .evaluate(SENSITIVE_FIELD, timeout)
                        .await
                        .map_err(engine);
                }
                per_frame(SENSITIVE_FIELD, json!(false)).await
            }
            other => Err(Err(format!("unknown helper {other:?}"))),
        }
    }
}

fn strings(value: Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Run one case in a new page; its recorded steps.
/// `expected/<case>.json`, with the steps of `expected/<case>.macos.json`
/// (`{"steps": {"<index>": step}}`) in their place on macOS.
fn expected(name: &str) -> Value {
    let read = |file: String| {
        let path = fixtures().join("expected").join(file);
        std::fs::read_to_string(&path)
            .ok()
            .map(|text| serde_json::from_str::<Value>(&text).unwrap())
    };
    let mut expected = read(format!("{name}.json")).expect("the case's expected steps");
    if cfg!(target_os = "macos")
        && let Some(overrides) = read(format!("{name}.macos.json"))
    {
        let steps = expected["steps"].as_array_mut().unwrap();
        for (index, step) in overrides["steps"].as_object().unwrap() {
            let index: usize = index.parse().unwrap();
            assert!(index < steps.len(), "{name}.macos.json: no step {index}");
            steps[index] = step.clone();
        }
    }
    expected
}

async fn run_case(context: &Context, name: &str, port: u16) -> Result<Vec<Value>, String> {
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("cases").join(format!("{name}.json"))).unwrap(),
    )
    .unwrap();
    let page = context.new_page().await.map_err(|e| e.message)?;
    screencast::show_actions(&page, Some(ShowActions { duration: ms(600) }));
    let mut runner = Runner {
        page: page.clone(),
        host_a: format!("127.0.0.1:{port}"),
        host_b: format!("localhost:{port}"),
        latest: String::new(),
        snapshots: Default::default(),
    };
    let mut steps = Vec::new();
    let mut failure = None;
    for (index, step) in spec["steps"].as_array().unwrap().iter().enumerate() {
        let op = str_of(step, "op").unwrap_or_default();
        let mut out = Map::new();
        out.insert("op".into(), json!(op));
        let expect_error = step["error"] == true;
        match runner.run(step, &mut out).await {
            Ok(()) if expect_error => {
                failure = Some(format!("step {index} ({op}) should have failed"));
                break;
            }
            Ok(()) => {}
            Err(Err(problem)) => {
                failure = Some(format!("step {index} ({op}): {problem}"));
                break;
            }
            Err(Ok(error)) if !expect_error => {
                failure = Some(format!("step {index} ({op}) failed: {error}"));
                break;
            }
            Err(Ok(error)) => {
                let mut entry = Map::new();
                entry.insert("op".into(), json!(op));
                entry.insert("error".into(), json!(clean_error(&error)));
                if (step.get("target").is_some() || step.get("ref").is_some())
                    && let Ok(reference) = runner.reference(step)
                {
                    entry.insert("ref".into(), json!(reference));
                }
                out = entry;
            }
        }
        if !(out.contains_key("error") && matches!(op, "goto" | "back")) {
            out.insert("url".into(), json!(page.url()));
        }
        steps.push(runner.normalize(Value::Object(out)));
    }
    let _ = page.close().await;
    match failure {
        Some(failure) => Err(failure),
        None => Ok(steps),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_engine_does_what_playwright_recorded() {
    let Some(executable) = chromium() else {
        eprintln!("skipped: no Chromium found");
        return;
    };
    let only: Vec<String> = std::env::var("PIRC_BROWSER_CORPUS")
        .unwrap_or_default()
        .split(',')
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    let mut names: Vec<String> = std::fs::read_dir(fixtures().join("cases"))
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".json").map(str::to_owned)
        })
        .filter(|name| only.is_empty() || only.contains(name))
        .collect();
    names.sort();

    let port = serve().await;
    let profile = tempfile::tempdir().unwrap();
    let env = pirc_config::env_allowlist::without_secrets(&pirc_config::Env::from_process(), &[]);
    let guard = HostGuard::from_policy(&["127.0.0.1", "localhost"], None, &[], system_resolver());
    let context = Context::launch(
        &executable,
        profile.path(),
        LaunchOptions {
            viewport: (1280, 800),
            env,
        },
        Arc::new(guard),
    )
    .await
    .expect("launch");

    let mut failures = Vec::new();
    for name in &names {
        let started = std::time::Instant::now();
        let expected = expected(name);
        match run_case(&context, name, port).await {
            Err(failure) => failures.push(format!("{name}: {failure}")),
            Ok(steps) => {
                let expected_steps = expected["steps"].as_array().cloned().unwrap_or_default();
                if steps.len() != expected_steps.len() {
                    failures.push(format!(
                        "{name}: {} steps, expected {}",
                        steps.len(),
                        expected_steps.len()
                    ));
                }
                for (index, (actual, wanted)) in steps.iter().zip(&expected_steps).enumerate() {
                    if actual != wanted {
                        failures.push(format!(
                            "{name}: step {index} differs\n  actual:   {actual}\n  expected: {wanted}"
                        ));
                    }
                }
            }
        }
        eprintln!("{name}: {:.1}s", started.elapsed().as_secs_f64());
    }
    context.close().await;
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// Every platform checks the macOS overrides (only a Mac replays them):
/// they name a case and existing steps, and differ from the Linux steps.
#[test]
fn the_macos_overrides_replace_existing_steps() {
    for entry in std::fs::read_dir(fixtures().join("expected")).unwrap() {
        let file = entry.unwrap().file_name().into_string().unwrap();
        let Some(name) = file.strip_suffix(".macos.json") else {
            continue;
        };
        let read = |file: String| -> Value {
            serde_json::from_str(
                &std::fs::read_to_string(fixtures().join("expected").join(file)).unwrap(),
            )
            .unwrap()
        };
        let linux = read(format!("{name}.json"));
        let overrides = read(file.clone());
        assert_eq!(overrides["case"], name, "{file}");
        let steps = overrides["steps"].as_object().unwrap();
        assert!(!steps.is_empty(), "{file}");
        for (index, step) in steps {
            let linux = &linux["steps"][index.parse::<usize>().unwrap()];
            assert_eq!(linux["op"], step["op"], "{file}: step {index}");
            assert_ne!(linux, step, "{file}: step {index} is the same on Linux");
        }
    }
}
