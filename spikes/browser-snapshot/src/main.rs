//! M1 spike A (plans/rust-rewrite.md): the agent's browser model without
//! Node. `node/browser.ts` gives the agent Playwright's AI aria snapshot
//! (`page.ariaSnapshot({ mode: 'ai' })`) and acts on its `[ref=…]`s through
//! `aria-ref=` locators. Both are computed in the page by Playwright's
//! injected script, so a Rust browser driver can evaluate that same script
//! over the Chrome DevTools Protocol.
//!
//! This drives Chromium over a minimal hand-written CDP client (WebSocket +
//! JSON), injects `target/injected.js` (from `bun extract.ts`), compares each
//! page's snapshot with Playwright's (`bun reference.ts`), and fills and
//! submits the form through refs with CDP input events.
//!
//! Usage: browser-snapshot <chromium executable>

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// One browser-wide CDP connection; page commands carry a `sessionId`.
struct Cdp {
    outgoing: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
}

impl Cdp {
    async fn connect(url: &str) -> Self {
        let (socket, _) = tokio_tungstenite::connect_async(url).await.expect("CDP");
        let (mut write, mut read) = socket.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(text) = queue.recv().await {
                if write.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
        });
        let pending: Pending = Arc::default();
        let responses = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = read.next().await {
                let Message::Text(text) = message else { continue };
                let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                // Events (no id) are not needed by this spike.
                if let Some(id) = value["id"].as_u64()
                    && let Some(reply) = responses.lock().await.remove(&id)
                {
                    let _ = reply.send(value);
                }
            }
        });
        Self {
            outgoing,
            pending,
            next: AtomicU64::new(1),
        }
    }

    async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().await.insert(id, reply);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.outgoing.send(message.to_string()).expect("CDP writer");
        let response = tokio::time::timeout(Duration::from_secs(20), answer)
            .await
            .unwrap_or_else(|_| panic!("{method}: no answer"))
            .expect("CDP reader");
        if !response["error"].is_null() {
            panic!("{method}: {}", response["error"]);
        }
        response["result"].clone()
    }
}

/// A page target attached in flat mode.
struct Page<'a> {
    cdp: &'a Cdp,
    session: String,
}

impl Page<'_> {
    async fn call(&self, method: &str, params: Value) -> Value {
        self.cdp.call(Some(&self.session), method, params).await
    }

    /// Evaluate in the page's main world, returning the JSON value.
    async fn eval(&self, expression: &str) -> Value {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await;
        if let Some(exception) = result.get("exceptionDetails") {
            panic!("evaluate failed: {exception}");
        }
        result["result"]["value"].clone()
    }

    async fn goto(&self, url: &str, injected: &str) {
        self.call("Page.navigate", json!({ "url": url })).await;
        for _ in 0..100 {
            if self.eval("document.readyState").await == "complete" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // As Playwright's FrameExecutionContext does; options as for Chromium.
        let options = json!({ "isUnderTest": false, "sdkLanguage": "javascript",
            "frameSeq": 0, "testIdAttributeName": "data-testid", "stableRafCount": 1,
            "browserName": "chromium", "shouldPrependErrorPrefix": true,
            "isUtilityWorld": false, "customEngines": [] });
        self.eval(&format!(
            "(() => {{ const module = {{}};\n{injected}\n\
             globalThis.__pw = new (module.exports.InjectedScript())(globalThis, {options}); \
             return true; }})()"
        ))
        .await;
    }

    async fn snapshot(&self) -> String {
        self.eval("__pw.ariaSnapshot(document.body, { mode: 'ai' })")
            .await
            .as_str()
            .expect("snapshot text")
            .to_owned()
    }

    /// Run `body` with `element` bound to the node an `aria-ref` names.
    async fn on_ref(&self, reference: &str, body: &str) -> Value {
        self.eval(&format!(
            "(() => {{ const element = __pw.querySelector(__pw.parseSelector('aria-ref={reference}'), document, true);\n\
             if (!element) throw new Error('no element for {reference}');\n{body} }})()"
        ))
        .await
    }

    async fn click(&self, reference: &str) {
        let point = self
            .on_ref(
                reference,
                "element.scrollIntoView(); const r = element.getBoundingClientRect(); \
                 return { x: r.x + r.width / 2, y: r.y + r.height / 2 };",
            )
            .await;
        for kind in ["mousePressed", "mouseReleased"] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({ "type": kind, "x": point["x"], "y": point["y"], "button": "left",
                    "clickCount": 1 }),
            )
            .await;
        }
    }

    async fn fill(&self, reference: &str, text: &str) {
        self.on_ref(reference, "element.focus(); element.select && element.select();")
            .await;
        self.call("Input.insertText", json!({ "text": text })).await;
    }
}

async fn launch(chromium: &str, profile: &Path) -> (Child, String) {
    let mut child = Command::new(chromium)
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            &format!("--user-data-dir={}", profile.display()),
            "about:blank",
        ])
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("chromium");
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(url) = line.strip_prefix("DevTools listening on ") {
            let url = url.trim().to_owned();
            tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
            return (child, url);
        }
    }
    panic!("chromium did not report its DevTools endpoint");
}

/// Refs differ by frame (`f3e2` vs `e2`): Playwright numbers frames per
/// browser context, which this spike does not track.
fn without_frame_prefix(snapshot: &str) -> String {
    let mut out = String::with_capacity(snapshot.len());
    let mut rest = snapshot;
    while let Some(at) = rest.find("[ref=f") {
        out.push_str(&rest[..at + 5]);
        let tail = &rest[at + 6..];
        let digits = tail.chars().take_while(char::is_ascii_digit).count();
        rest = &tail[digits..];
    }
    out.push_str(rest);
    out
}

fn reference_of(snapshot: &str, label: &str) -> String {
    let line = snapshot
        .lines()
        .find(|line| line.contains(label))
        .unwrap_or_else(|| panic!("{label} not in snapshot"));
    let start = line.find("[ref=").unwrap() + 5;
    line[start..start + line[start..].find(']').unwrap()].to_owned()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let chromium = std::env::args().nth(1).expect("usage: browser-snapshot <chromium>");
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let injected =
        std::fs::read_to_string(here.join("target/injected.js")).expect("run `bun extract.ts`");
    let expected = |name: &str| {
        std::fs::read_to_string(here.join("target/expected").join(name))
            .expect("run `bun reference.ts`")
    };
    let profile = here.join("target/profile");
    let _ = std::fs::remove_dir_all(&profile);
    let (_browser, url) = launch(&chromium, &profile).await;
    let cdp = Cdp::connect(&url).await;
    let target = cdp
        .call(None, "Target.createTarget", json!({ "url": "about:blank" }))
        .await;
    let attached = cdp
        .call(
            None,
            "Target.attachToTarget",
            json!({ "targetId": target["targetId"], "flatten": true }),
        )
        .await;
    let page = Page {
        cdp: &cdp,
        session: attached["sessionId"].as_str().unwrap().to_owned(),
    };

    let mut failures = 0;
    let mut compare = |name: &str, actual: &str, wanted: &str| {
        let same = without_frame_prefix(actual.trim_end()) == without_frame_prefix(wanted.trim_end());
        if !same {
            failures += 1;
            println!("---- {name}: ours\n{actual}\n---- Playwright\n{wanted}");
        }
        println!("{} {name}", if same { "SAME" } else { "DIFF" });
    };
    let mut pages: Vec<_> = std::fs::read_dir(here.join("pages"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    pages.sort();
    for file in pages {
        let name = file.file_stem().unwrap().to_string_lossy().into_owned();
        page.goto(&format!("file://{}", file.display()), &injected).await;
        let started = std::time::Instant::now();
        let snapshot = page.snapshot().await;
        let took = started.elapsed();
        compare(&name, &snapshot, &expected(&format!("{name}.yaml")));
        println!("     snapshot in {} ms", took.as_millis());
        if name == "form" {
            page.fill(&reference_of(&snapshot, "textbox \"Name\""), "Ada")
                .await;
            page.click(&reference_of(&snapshot, "button \"Submit\""))
                .await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            compare(
                "form, filled and submitted through refs",
                &page.snapshot().await,
                &expected("form-submitted.yaml"),
            );
        }
    }
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
