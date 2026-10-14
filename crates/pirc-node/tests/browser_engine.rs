//! The engine's context, pages and frames against a real Chromium (found
//! as `BrowserSettings` finds it; the tests are skipped without one), on
//! pages served from loopback by a tiny HTTP server: `127.0.0.1` and
//! `localhost` are two sites, so iframes from the other one are
//! out-of-process. Expected values (frame sequence numbers, snapshots,
//! messages) were taken from Playwright 1.63.0 on the same pages.
//!
//! These tests launch the context without the host guard
//! (`Context::launch_unguarded`). With `PIRC_BROWSER_REQUIRED=1` (CI) they
//! fail instead of skipping, and use `PIRC_BROWSER_EXECUTABLE` only.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pirc_node::browser::engine::context::{Context, LaunchOptions};
use pirc_node::browser::engine::frame::Arg;
use pirc_node::browser::engine::page::{Page, PageEvent};
use pirc_node::browser::engine::screencast::{ScreencastFrame, ScreencastOptions};
use pirc_node::browser::engine::screenshot::ScreenshotOptions;
use pirc_node::browser::engine::snapshot::aria_snapshot;
use pirc_node::browser::engine::{LoadState, MouseButton};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const FORM: &str = include_str!("fixtures/browser/pages/form.html");

/// What Playwright's `page.ariaSnapshot({mode: 'ai'})` gives for the form
/// (recorded with Playwright 1.63.0 during the M1 browser spike).
const FORM_SNAPSHOT: &str = r#"- generic [active] [ref=e1]:
  - heading "Sign up" [level=1] [ref=e2]
  - generic [ref=e3]:
    - generic [ref=e4]:
      - text: Name
      - textbox "Name" [ref=e5]
    - generic [ref=e6]:
      - text: Password
      - textbox "Password" [ref=e7]
    - generic [ref=e8]:
      - checkbox "Remember me" [checked] [ref=e9]
      - text: Remember me
    - generic [ref=e10]:
      - text: Plan
      - combobox "Plan" [ref=e11]:
        - option "Free"
        - option "Pro" [selected]
    - button "Submit" [ref=e12]
    - button "Later" [disabled] [ref=e13]
  - paragraph"#;

/// `PIRC_BROWSER_REQUIRED=1` (CI): nothing is skipped. The Chromium must be
/// `PIRC_BROWSER_EXECUTABLE`, an existing file (no fallback to another
/// browser on `PATH`), and a missing one fails the test.
fn required() -> bool {
    std::env::var_os("PIRC_BROWSER_REQUIRED").is_some_and(|value| value == "1")
}

/// Under [`required`], the explicit Chromium, or a panic.
fn required_chromium() -> Option<PathBuf> {
    if !required() {
        return None;
    }
    let explicit = std::env::var_os("PIRC_BROWSER_EXECUTABLE")
        .filter(|path| !path.is_empty())
        .expect("PIRC_BROWSER_REQUIRED=1 needs PIRC_BROWSER_EXECUTABLE");
    assert!(
        Path::new(&explicit).is_file(),
        "PIRC_BROWSER_EXECUTABLE={explicit:?} is not a file"
    );
    Some(explicit.into())
}

fn chromium() -> Option<PathBuf> {
    if let Some(explicit) = required_chromium() {
        return Some(explicit);
    }
    if let Ok(explicit) = std::env::var("PIRC_BROWSER_EXECUTABLE") {
        return Some(PathBuf::from(explicit));
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for name in [
        "chromium",
        "chromium-browser",
        "google-chrome-stable",
        "google-chrome",
        "microsoft-edge",
    ] {
        for dir in path.split(':').filter(|dir| !dir.is_empty()) {
            let candidate = PathBuf::from(dir).join(name);
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

struct Browser {
    context: Arc<Context>,
    _profile: tempfile::TempDir,
}

async fn launch() -> Option<Browser> {
    let Some(executable) = chromium() else {
        eprintln!("skipped: no Chromium found");
        return None;
    };
    let profile = tempfile::tempdir().unwrap();
    let env = std::env::vars()
        .filter(|(name, _)| {
            [
                "PATH",
                "HOME",
                "TMPDIR",
                "FONTCONFIG_FILE",
                "XDG_RUNTIME_DIR",
            ]
            .contains(&name.as_str())
        })
        .collect();
    let context = Context::launch_unguarded(
        &executable,
        profile.path(),
        LaunchOptions {
            viewport: (1280, 800),
            env,
        },
    )
    .await
    .expect("launch");
    Some(Browser {
        context,
        _profile: profile,
    })
}

/// A page's HTML, by path.
fn route(path: &str, port: u16) -> Option<(u16, String)> {
    let html = |body: &str| Some((200, body.replace("PORT", &port.to_string())));
    match path {
        "/plain" | "/plain#x" => html("<title>Plain</title><h1>Plain</h1>"),
        "/input" => html("<title>Input</title><input id=i>"),
        "/same" => {
            html(r#"<title>Same</title><h1>Outer</h1><iframe title="Inner" src="/plain"></iframe>"#)
        }
        "/nested" => {
            html(r#"<title>Nested</title><h1>N</h1><iframe title="L1" src="/same"></iframe>"#)
        }
        "/cross" => html(
            r#"<title>Cross</title><h1>C</h1><iframe title="X" src="http://localhost:PORT/form"></iframe>"#,
        ),
        "/two" => html(
            r#"<title>Two</title><iframe title="A" src="/plain"></iframe><iframe title="B" src="http://localhost:PORT/same"></iframe>"#,
        ),
        "/form" => html(FORM),
        "/idle" => html(r#"<title>idle</title><img src="/slow.png">"#),
        "/dialog" => html("<title>Dialog</title><p>dialogs</p>"),
        "/dnd" => html(
            r#"<div id=s draggable=true style="width:50px;height:50px;background:red">S</div><div id=t style="width:100px;height:100px;margin-top:50px;background:blue">T</div><script>window.log=[];t.ondragover=e=>e.preventDefault();t.ondrop=e=>{e.preventDefault();log.push('drop')};s.ondragstart=e=>{e.dataTransfer.setData('text/plain','x');log.push('start')};s.ondragend=()=>log.push('end')</script>"#,
        ),
        // An iframe whose document never comes (an ad, a long poll).
        "/hanging" => html(
            r#"<title>Hanging</title><h1>Outer</h1><input id=i><iframe title="Late" src="/hang"></iframe>"#,
        ),
        "/missing" => Some((
            404,
            format!("<title>Missing</title>{}", "<p>not here</p>".repeat(60)),
        )),
        _ => None,
    }
}

async fn respond(mut stream: TcpStream, port: u16) {
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&buffer[..n]),
        }
    }
    let head = String::from_utf8_lossy(&head);
    let path = head.split(' ').nth(1).unwrap_or("/").to_owned();
    let reply = match path.as_str() {
        "/hang" => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            return;
        }
        "/redirect" => {
            "HTTP/1.1 302 Found\r\nLocation: /plain\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_owned()
        }
        "/slow.png" => {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
        }
        _ => {
            let (status, body) =
                route(&path, port).unwrap_or((404, "<title>nf</title>".repeat(100)));
            format!(
                "HTTP/1.1 {status} X\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        }
    };
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Serve the pages on loopback; the port.
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

const T: Duration = Duration::from_secs(30);

fn seqs(page: &Page) -> Vec<u64> {
    page.frames().iter().map(|frame| frame.seq()).collect()
}

async fn snapshot(frame: &pirc_node::browser::engine::frame::Frame) -> String {
    let injected = frame.injected().await.unwrap();
    injected
        .call(
            "function () { return this.ariaSnapshot(this.document.body, { mode: 'ai' }); }",
            vec![],
        )
        .await
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

macro_rules! guard {
    ($body:expr) => {
        tokio::time::timeout(Duration::from_secs(120), $body)
            .await
            .expect("test timed out")
    };
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn launches_opens_pages_and_closes_killing_the_browser() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let context = &browser.context;
        let pages = context.pages();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].url(), "about:blank");
        assert_eq!(pages[0].viewport(), (1280, 800));
        assert_eq!(
            pages[0]
                .evaluate("() => [innerWidth, innerHeight]", Value::Null)
                .await
                .unwrap(),
            json!([1280, 800])
        );
        let second = context.new_page().await.unwrap();
        assert_eq!(second.url(), "about:blank");
        let ids: Vec<String> = context
            .pages()
            .iter()
            .map(|p| p.target_id().to_owned())
            .collect();
        assert_eq!(ids, [pages[0].target_id(), second.target_id()]);
        let mut events = second.subscribe();
        second.close().await.unwrap();
        assert!(second.is_closed());
        // Its `about:blank` may still report `load` first (Playwright's
        // `newPage` does not wait for it either).
        loop {
            match events.recv().await {
                Some(PageEvent::Closed) => break,
                Some(PageEvent::Load | PageEvent::MainFrameNavigated) => {}
                Some(PageEvent::Popup(_)) | None => panic!("closed last"),
            }
        }
        assert!(events.recv().await.is_none());
        assert_eq!(context.pages().len(), 1);

        let pid = context.pid().unwrap() as i32;
        context.close().await;
        assert!(context.is_closed());
        context.closed().await;
        assert!(pages[0].is_closed());
        // Killed helpers may stay zombies until their new parent reaps them.
        let gone = Instant::now();
        while nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid), None).is_ok() {
            assert!(
                gone.elapsed() < Duration::from_secs(5),
                "the process group is gone"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_killed_browser_closes_the_context() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let page = browser.context.pages()[0].clone();
        let mut events = page.subscribe();
        let pid = browser.context.pid().unwrap() as i32;
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        )
        .unwrap();
        browser.context.closed().await;
        assert!(page.is_closed());
        assert!(matches!(events.recv().await, Some(PageEvent::Closed)));
        let error = page.evaluate("() => 1", Value::Null).await.unwrap_err();
        assert_eq!(
            error.message,
            "evaluate: Target page, context or browser has been closed"
        );
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn numbers_frames_as_playwright_across_navigations_and_oopifs() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let base = format!("http://127.0.0.1:{port}");
        let page = browser.context.pages()[0].clone();
        assert_eq!(seqs(&page), [0]);
        // Playwright 1.63.0's refs for the same steps: f0; f1; f2,f3;
        // f4,f5,f6; f7,f8; f9..f12; reload f13..f16; back f17,f18;
        // about:blank; f19,f20; f19,f20.
        let steps: [(&str, &[u64]); 11] = [
            ("/plain", &[0]),
            ("/plain", &[1]),
            ("/same", &[2, 3]),
            ("/nested", &[4, 5, 6]),
            ("/cross", &[7, 8]),
            ("/two", &[9, 10, 11, 12]),
            ("reload", &[13, 14, 15, 16]),
            ("back", &[17, 18]),
            ("about:blank", &[19]),
            ("/same", &[19, 20]),
            ("/same#x", &[19, 20]),
        ];
        for (step, expected) in steps {
            match step {
                "reload" => page.reload(T).await.unwrap(),
                "back" => page.go_back(LoadState::Load, T).await.unwrap(),
                "about:blank" => {
                    assert_eq!(page.goto(step, LoadState::Load, T).await.unwrap(), None);
                }
                _ => {
                    page.goto(&format!("{base}{step}"), LoadState::Load, T)
                        .await
                        .unwrap();
                }
            }
            assert_eq!(seqs(&page), expected, "after {step}");
        }

        // The cross-site frame is out of process: its own session, its own
        // injected script numbering its refs with its sequence number.
        page.goto(&format!("{base}/cross"), LoadState::Load, T)
            .await
            .unwrap();
        let frames = page.frames();
        assert_eq!(frames.len(), 2);
        let (main, child) = (&frames[0], &frames[1]);
        assert!(main.is_main() && !child.is_main());
        assert_eq!(child.url(), format!("http://localhost:{port}/form"));
        assert_eq!(child.parent().unwrap().id(), main.id());
        assert_ne!(child.session().id(), main.session().id());
        assert_eq!(page.frame_by_seq(child.seq()).unwrap().id(), child.id());
        let prefix = format!("f{}e", child.seq());
        assert_eq!(
            snapshot(child).await,
            FORM_SNAPSHOT
                .replace("[ref=e", &format!("[ref={prefix}"))
                .replace("generic [active] [ref", "generic [ref")
        );
        let owner = child.owner().await.unwrap().unwrap();
        assert_eq!(
            owner
                .call("function () { return this.title; }", vec![])
                .await
                .unwrap(),
            "X"
        );
        assert!(main.owner().await.unwrap().is_none());

        // Same-process frames share the page's session.
        page.goto(&format!("{base}/nested"), LoadState::Load, T)
            .await
            .unwrap();
        let frames = page.frames();
        let urls: Vec<String> = frames.iter().map(|f| f.url()).collect();
        assert_eq!(
            urls,
            [
                format!("{base}/nested"),
                format!("{base}/same"),
                format!("{base}/plain")
            ]
        );
        assert!(
            frames
                .iter()
                .all(|f| f.session().id() == page.session().id())
        );
        assert_eq!(frames[2].parent().unwrap().id(), frames[1].id());
        let owner = frames[2].owner().await.unwrap().unwrap();
        assert_eq!(
            owner
                .call("function () { return this.title; }", vec![])
                .await
                .unwrap(),
            "Inner"
        );
        assert_eq!(
            frames[2]
                .evaluate("() => document.title", Value::Null)
                .await
                .unwrap(),
            "Plain"
        );
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn evaluates_and_runs_the_injected_script() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(&format!("http://127.0.0.1:{port}/form"), LoadState::Load, T)
            .await
            .unwrap();
        let main = page.main_frame();
        assert_eq!(main.seq(), 0);
        assert_eq!(snapshot(&main).await, FORM_SNAPSHOT);
        // One injected script per document.
        let first = main.injected().await.unwrap();
        assert_eq!(main.injected().await.unwrap().object_id, first.object_id);

        assert_eq!(
            page.evaluate("() => 1 + 1", Value::Null).await.unwrap(),
            json!(2)
        );
        assert_eq!(page.evaluate("1 + 2", Value::Null).await.unwrap(), json!(3));
        assert_eq!(
            page.evaluate("(a) => [a === undefined, typeof a]", Value::Null)
                .await
                .unwrap(),
            json!([true, "undefined"])
        );
        assert_eq!(
            page.evaluate("(a) => a.x * 2", json!({ "x": 21 }))
                .await
                .unwrap(),
            json!(42)
        );
        assert_eq!(
            page.evaluate("async () => 'later'", Value::Null)
                .await
                .unwrap(),
            "later"
        );
        assert_eq!(
            page.evaluate("() => undefined", Value::Null).await.unwrap(),
            Value::Null
        );
        assert_eq!(
            page.evaluate("() => NaN", Value::Null).await.unwrap(),
            Value::Null
        );
        assert_eq!(
            page.evaluate("() => document.title", Value::Null)
                .await
                .unwrap(),
            "Form"
        );
        let error = page
            .evaluate("() => { throw new Error('boom'); }", Value::Null)
            .await
            .unwrap_err();
        assert!(
            error.message.starts_with("evaluate: Error: boom\n    at "),
            "{}",
            error.message
        );
        let error = page
            .evaluate("async () => { throw new TypeError('bad'); }", Value::Null)
            .await
            .unwrap_err();
        assert!(
            error.message.starts_with("evaluate: TypeError: bad\n"),
            "{}",
            error.message
        );
        let error = page
            .evaluate("() => { throw 'str'; }", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(error.message, "evaluate: str");
        // The utility world is not the page's.
        page.evaluate("() => { window.marker = 1; }", Value::Null)
            .await
            .unwrap();
        let injected = main.injected().await.unwrap();
        assert_eq!(
            injected
                .call("function () { return typeof window.marker; }", vec![])
                .await
                .unwrap(),
            "undefined"
        );
        // Handles, arguments and adoption across worlds.
        let button = injected
            .call_handle(
                "function (selector) { return document.querySelector(selector); }",
                vec![Arg::Value(json!("button"))],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            injected
                .call(
                    "function (node) { return node.textContent; }",
                    vec![Arg::Handle(button.clone())]
                )
                .await
                .unwrap(),
            "Submit"
        );
        assert!(
            injected
                .call_handle("function () { return null; }", vec![])
                .await
                .unwrap()
                .is_none()
        );
        let in_main = main.adopt(&button, false).await.unwrap();
        assert_ne!(in_main.object_id, button.object_id);
        let back = main.adopt(&in_main, true).await.unwrap();
        assert_eq!(
            back.call("function () { return this.type; }", vec![])
                .await
                .unwrap(),
            "submit"
        );
        button.release().await;
        assert_eq!(page.title().await.unwrap(), "Form");
        let content = page.content().await.unwrap();
        assert!(
            content.starts_with("<!DOCTYPE html><html lang=\"en\"><head>"),
            "{content}"
        );
        // A new document has a new injected script.
        page.reload(T).await.unwrap();
        assert_ne!(main.injected().await.unwrap().object_id, first.object_id);
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn navigates_with_playwright_statuses_and_errors() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let base = format!("http://127.0.0.1:{port}");
        let page = browser.context.pages()[0].clone();
        let mut events = page.subscribe();
        let status = |r: Option<pirc_node::browser::engine::page::Response>| r.map(|r| r.status);
        assert_eq!(
            status(
                page.goto(&format!("{base}/plain"), LoadState::Load, T)
                    .await
                    .unwrap()
            ),
            Some(200)
        );
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            seen.push(match event {
                PageEvent::MainFrameNavigated => "navigated",
                PageEvent::Load => "load",
                _ => "other",
            });
        }
        assert_eq!(seen, ["navigated", "load"]);
        assert_eq!(
            status(
                page.goto(&format!("{base}/missing"), LoadState::Load, T)
                    .await
                    .unwrap()
            ),
            Some(404)
        );
        assert_eq!(
            status(
                page.goto(&format!("{base}/redirect"), LoadState::Load, T)
                    .await
                    .unwrap()
            ),
            Some(200)
        );
        assert_eq!(page.url(), format!("{base}/plain"));
        // Same-document: no response.
        assert_eq!(
            page.goto(&format!("{base}/plain#x"), LoadState::Load, T)
                .await
                .unwrap(),
            None
        );
        assert_eq!(page.url(), format!("{base}/plain#x"));
        assert_eq!(
            status(
                page.goto(&format!("{base}/plain"), LoadState::Commit, T)
                    .await
                    .unwrap()
            ),
            Some(200)
        );

        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let url = format!("http://127.0.0.1:{closed}/x");
        let error = page.goto(&url, LoadState::Load, T).await.unwrap_err();
        assert_eq!(
            error.message,
            format!("goto: net::ERR_CONNECTION_REFUSED at {url}")
        );
        let error = page
            .goto("http://127.0.0.1:1/x", LoadState::Load, T)
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            "goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1/x"
        );
        let started = Instant::now();
        let error = page
            .goto(
                &format!("{base}/hang"),
                LoadState::Load,
                Duration::from_millis(1000),
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, "goto: Timeout 1000ms exceeded.");
        assert!(started.elapsed() < Duration::from_secs(3));
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn goes_back_forward_and_reloads() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let base = format!("http://127.0.0.1:{port}");
        let page = browser.context.new_page().await.unwrap();
        // No history: nothing happens, no error.
        page.go_back(LoadState::DomContentLoaded, T).await.unwrap();
        assert_eq!(page.url(), "about:blank");
        page.goto(&format!("{base}/plain"), LoadState::Load, T)
            .await
            .unwrap();
        page.goto(&format!("{base}/same"), LoadState::Load, T)
            .await
            .unwrap();
        page.go_back(LoadState::DomContentLoaded, T).await.unwrap();
        assert_eq!(page.url(), format!("{base}/plain"));
        page.go_forward(T).await.unwrap();
        assert_eq!(page.url(), format!("{base}/same"));
        page.go_forward(T).await.unwrap();
        assert_eq!(page.url(), format!("{base}/same"));
        page.evaluate("() => { window.before = 1; }", Value::Null)
            .await
            .unwrap();
        page.reload(T).await.unwrap();
        assert_eq!(
            page.evaluate("() => typeof window.before", Value::Null)
                .await
                .unwrap(),
            "undefined"
        );
        assert_eq!(page.frames().len(), 2);
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn waits_for_load_states_and_networkidle() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        let started = Instant::now();
        page.goto(
            &format!("http://127.0.0.1:{port}/idle"),
            LoadState::DomContentLoaded,
            T,
        )
        .await
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(1400),
            "{:?}",
            started.elapsed()
        );
        let main = page.main_frame();
        assert!(main.has_load_state(LoadState::DomContentLoaded));
        assert!(!main.has_load_state(LoadState::NetworkIdle));
        let error = page
            .wait_for_load_state(LoadState::NetworkIdle, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert_eq!(error.message, "waitForLoadState: Timeout 300ms exceeded.");
        page.wait_for_load_state(LoadState::NetworkIdle, T)
            .await
            .unwrap();
        // The image takes 1.5 s, then 500 ms without requests.
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(1950), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(3500), "{elapsed:?}");
        assert!(main.has_load_state(LoadState::Load));
        // Already reached: immediate.
        page.wait_for_load_state(LoadState::Load, Duration::from_millis(50))
            .await
            .unwrap();
        // goto with networkidle.
        let started = Instant::now();
        page.goto(
            &format!("http://127.0.0.1:{port}/plain"),
            LoadState::NetworkIdle,
            T,
        )
        .await
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(500));
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dismisses_dialogs_and_reports_popups() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(
            &format!("http://127.0.0.1:{port}/dialog"),
            LoadState::Load,
            T,
        )
        .await
        .unwrap();
        let answers = page
            .evaluate(
                "() => { const r = [confirm('sure?'), prompt('name', 'x')]; alert('hi'); r.push('done'); return r; }",
                Value::Null,
            )
            .await
            .unwrap();
        assert_eq!(answers, json!([false, null, "done"]));

        let mut events = page.subscribe();
        page.evaluate(
            "() => { window.open('/plain', '_blank', 'width=500,height=400'); }",
            Value::Null,
        )
        .await
        .unwrap();
        let popup = loop {
            match events.recv().await.unwrap() {
                PageEvent::Popup(popup) => break popup,
                _ => continue,
            }
        };
        popup.wait_for_load_state(LoadState::Load, T).await.unwrap();
        assert_eq!(popup.url(), format!("http://127.0.0.1:{port}/plain"));
        assert_eq!(popup.viewport(), (500, 400));
        assert_eq!(
            popup
                .evaluate("() => [innerWidth, innerHeight]", Value::Null)
                .await
                .unwrap(),
            json!([500, 400])
        );
        assert_eq!(popup.main_frame().seq(), 0);
        assert_eq!(browser.context.pages().len(), 2);
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_iframe_keeps_its_number_moving_in_and_out_of_process() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(&format!("http://127.0.0.1:{port}/same"), LoadState::Load, T)
            .await
            .unwrap();
        assert_eq!(seqs(&page), [0, 1]);
        // Playwright 1.63.0: the child stays f1 through every swap.
        let cross = format!("http://localhost:{port}/plain");
        let same = format!("http://127.0.0.1:{port}/plain");
        for (src, url, own_session) in [
            (cross.as_str(), cross.as_str(), true),
            ("/plain", same.as_str(), false),
            (cross.as_str(), cross.as_str(), true),
        ] {
            page.evaluate(
                "(src) => new Promise((resolve) => { const f = document.querySelector('iframe'); f.onload = resolve; f.src = src; })",
                json!(src),
            )
            .await
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let frames = page.frames();
                let settled = frames.len() == 2
                    && frames[1].url() == url
                    && (frames[1].session().id() != page.session().id()) == own_session
                    && frames[1].has_load_state(LoadState::Load);
                if settled {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "the iframe did not settle on {url}"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert_eq!(seqs(&page), [0, 1], "after {src}");
            let child = &page.frames()[1];
            assert_eq!(
                child
                    .evaluate("() => document.title", Value::Null)
                    .await
                    .unwrap(),
                "Plain"
            );
            assert_eq!(
                snapshot(child).await,
                "- heading \"Plain\" [level=1] [ref=f1e2]"
            );
            let owner = child.owner().await.unwrap().unwrap();
            assert_eq!(
                owner
                    .call("function () { return this.title; }", vec![])
                    .await
                    .unwrap(),
                "Inner"
            );
        }
        browser.context.close().await;
    });
}

/// A page whose iframe never gets its document, loaded up to
/// `DOMContentLoaded` (`load` waits for the iframe).
async fn hanging_page(browser: &Browser) -> Arc<Page> {
    let port = serve().await;
    let page = browser.context.pages()[0].clone();
    page.goto(
        &format!("http://127.0.0.1:{port}/hanging"),
        LoadState::DomContentLoaded,
        T,
    )
    .await
    .unwrap();
    assert_eq!(page.frames().len(), 2);
    page
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn screenshots_skip_a_frame_that_is_still_loading() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let page = hanging_page(&browser).await;
        // Playwright 1.63.0 takes it at once (50 ms): the loading iframe has
        // no utility world and is not waited for.
        let options = ScreenshotOptions {
            quality: 50,
            full_page: false,
            timeout: Duration::from_secs(3),
        };
        for _ in 0..2 {
            let started = Instant::now();
            let shot = tokio::time::timeout(Duration::from_secs(10), page.screenshot(options))
                .await
                .expect("the screenshot returns")
                .unwrap();
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{:?}",
                started.elapsed()
            );
            assert_eq!(shot[..2], [0xff, 0xd8]);
        }
        browser.context.close().await;
    });
}

/// A screenshot of a page whose main thread is busy times out at its
/// timeout (not when the page answers), and its cleanup is still sent: the
/// page runs it once it is free, and the next screenshot works.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_timed_out_screenshot_still_cleans_up() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(
            &format!("http://127.0.0.1:{port}/input"),
            LoadState::Load,
            T,
        )
        .await
        .unwrap();
        let caret = "() => document.getElementById('i').style.getPropertyValue('caret-color')";
        let options = |timeout| ScreenshotOptions {
            quality: 50,
            full_page: false,
            timeout,
        };
        page.screenshot(options(T)).await.unwrap();
        assert_eq!(page.evaluate(caret, Value::Null).await.unwrap(), "");
        page.evaluate(
            "() => { setTimeout(() => { const end = Date.now() + 3000; while (Date.now() < end); }, 0); }",
            Value::Null,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = Instant::now();
        let error = tokio::time::timeout(
            Duration::from_secs(10),
            page.screenshot(options(Duration::from_millis(500))),
        )
        .await
        .expect("the screenshot returns")
        .unwrap_err();
        assert_eq!(error.message, "screenshot: Timeout 500ms exceeded.");
        // Not held until the page is free again.
        assert!(
            started.elapsed() < Duration::from_millis(2500),
            "{:?}",
            started.elapsed()
        );
        // Once free, the page ran the prepare call and then the cleanup
        // (the caret is shown again).
        assert_eq!(page.evaluate(caret, Value::Null).await.unwrap(), "");
        let shot = page.screenshot(options(T)).await.unwrap();
        assert_eq!(shot[..2], [0xff, 0xd8]);
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn calls_in_flight_fail_when_their_page_closes() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let page = browser.context.new_page().await.unwrap();
        let pending = {
            let page = page.clone();
            tokio::spawn(async move {
                page.evaluate("() => new Promise(() => {})", Value::Null)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        page.close().await.unwrap();
        // Playwright 1.63.0 rejects it at once.
        let error = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .expect("the evaluation ends")
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.message,
            "evaluate: Target page, context or browser has been closed"
        );
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshots_leave_out_a_frame_still_loading_at_the_timeout() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let page = hanging_page(&browser).await;
        // Playwright 1.63.0 returns this after the timeout (2003 ms): the
        // iframe's snapshot timed out and is left empty.
        let started = Instant::now();
        let snapshot = tokio::time::timeout(
            Duration::from_secs(10),
            aria_snapshot(&page, Duration::from_secs(2)),
        )
        .await
        .expect("the snapshot returns")
        .unwrap();
        assert_eq!(
            snapshot,
            "- generic [active] [ref=e1]:\n  - heading \"Outer\" [level=1] [ref=e2]\n  - textbox [ref=e3]\n  - iframe [ref=e4]"
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_secs(2) && elapsed < Duration::from_secs(4),
            "{elapsed:?}"
        );
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drags_do_not_wait_for_a_frame_still_loading() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let page = hanging_page(&browser).await;
        // Playwright 1.63.0: move, down, move, up in 28 ms.
        let mouse = page.mouse();
        let started = Instant::now();
        tokio::time::timeout(Duration::from_secs(10), async {
            mouse.move_to(10.0, 10.0, 0).await.unwrap();
            mouse.down(MouseButton::Left, 1, 0).await.unwrap();
            mouse.move_to(50.0, 50.0, 0).await.unwrap();
            mouse.up(MouseButton::Left, 1, 0).await.unwrap();
        })
        .await
        .expect("the drag ends");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drags_and_drops_as_playwright() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(&format!("http://127.0.0.1:{port}/dnd"), LoadState::Load, T)
            .await
            .unwrap();
        let mouse = page.mouse();
        mouse.move_to(25.0, 25.0, 0).await.unwrap();
        mouse.down(MouseButton::Left, 1, 0).await.unwrap();
        mouse.move_to(50.0, 150.0, 0).await.unwrap();
        assert!(mouse.is_dragging());
        mouse.move_to(50.0, 160.0, 0).await.unwrap();
        mouse.up(MouseButton::Left, 1, 0).await.unwrap();
        // Playwright 1.63.0 on the same page.
        assert_eq!(
            page.evaluate("() => window.log", Value::Null)
                .await
                .unwrap(),
            json!(["start", "drop", "end"])
        );
        browser.context.close().await;
    });
}

/// Kill the renderers of the context's browser (`SIGKILL`, found by their
/// process group): its pages crash.
fn kill_renderers(context: &Context) {
    let group = context.pid().unwrap().to_string();
    let listing = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,pgid=,command="])
        .output()
        .unwrap();
    let mut killed = 0;
    for line in String::from_utf8_lossy(&listing.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(pgid)) = (fields.next(), fields.next()) else {
            continue;
        };
        if pgid == group && line.contains("--type=renderer") {
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid.parse().unwrap()),
                nix::sys::signal::Signal::SIGKILL,
            )
            .unwrap();
            killed += 1;
        }
    }
    assert!(killed > 0, "no renderer found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crashed_page_fails_its_calls_as_playwright() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(
            &format!("http://127.0.0.1:{port}/plain"),
            LoadState::Load,
            T,
        )
        .await
        .unwrap();
        let pending = {
            let page = page.clone();
            tokio::spawn(async move {
                page.evaluate("() => new Promise(() => {})", Value::Null)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        kill_renderers(&browser.context);
        // Playwright 1.63.0 after the same crash.
        let error = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .expect("the evaluation ends")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.message, "evaluate: Target crashed ");
        let short = Duration::from_secs(5);
        let error = page.evaluate("() => 1", Value::Null).await.unwrap_err();
        assert_eq!(error.message, "evaluate: Target crashed ");
        assert_eq!(page.title().await.unwrap(), "");
        assert_eq!(
            page.content().await.unwrap_err().message,
            "content: Target crashed "
        );
        let shot = page.screenshot(ScreenshotOptions {
            quality: 50,
            full_page: false,
            timeout: short,
        });
        assert_eq!(
            shot.await.unwrap_err().message,
            "screenshot: Target crashed "
        );
        assert_eq!(
            aria_snapshot(&page, short).await.unwrap_err().message,
            "ariaSnapshot: Target crashed "
        );
        let error = page
            .goto(
                &format!("http://127.0.0.1:{port}/same"),
                LoadState::Load,
                short,
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, "goto: Page crashed");
        assert!(!page.is_closed());
        browser.context.close().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_key_press_cut_short_leaves_no_modifier_held() {
    guard!(async {
        let Some(browser) = launch().await else {
            return;
        };
        let port = serve().await;
        let page = browser.context.pages()[0].clone();
        page.goto(&format!("http://127.0.0.1:{port}/form"), LoadState::Load, T)
            .await
            .unwrap();
        page.evaluate("() => document.querySelector('input').focus()", Value::Null)
            .await
            .unwrap();
        let keyboard = page.keyboard();
        // Its action's timeout drops it while Control is down.
        let press = keyboard.press("Control+a", Duration::from_secs(60));
        assert!(
            tokio::time::timeout(Duration::from_millis(300), press)
                .await
                .is_err()
        );
        assert_eq!(keyboard.modifiers(), 0);
        keyboard.type_text("x", Duration::ZERO).await.unwrap();
        assert_eq!(
            page.evaluate("() => document.querySelector('input').value", Value::Null)
                .await
                .unwrap(),
            "x"
        );
        browser.context.close().await;
    });
}

/// A JPEG's size from its first SOF marker.
fn jpeg_size(jpeg: &[u8]) -> (u32, u32) {
    let mut at = 2;
    while at + 9 < jpeg.len() {
        let marker = jpeg[at + 1];
        let length = usize::from(u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]));
        if matches!(marker, 0xc0..=0xc3) {
            let height = u16::from_be_bytes([jpeg[at + 5], jpeg[at + 6]]);
            let width = u16::from_be_bytes([jpeg[at + 7], jpeg[at + 8]]);
            return (u32::from(width), u32::from(height));
        }
        at += 2 + length;
    }
    panic!("no SOF marker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_first_screencast_frame_shows_the_viewport() {
    guard!(async {
        let port = serve().await;
        // Chromium's first frame is often of the un-emulated window
        // (1280x713) when the screencast starts with the first navigation,
        // as the manager's does (Playwright 1.63.0: 10 of 15 launches).
        for _ in 0..6 {
            let Some(browser) = launch().await else {
                return;
            };
            let page = browser.context.pages()[0].clone();
            let frames: Arc<std::sync::Mutex<Vec<(u32, u32)>>> = Arc::default();
            let sink = {
                let frames = frames.clone();
                Arc::new(move |frame: ScreencastFrame| {
                    assert_eq!((frame.width, frame.height), (1280, 800));
                    frames.lock().unwrap().push(jpeg_size(&frame.jpeg));
                })
            };
            let options = ScreencastOptions {
                width: 1280,
                height: 800,
                quality: 60,
            };
            let url = format!("http://127.0.0.1:{port}/form");
            let (started, navigated) = tokio::join!(
                page.start_screencast(options, sink),
                page.goto(&url, LoadState::Load, T)
            );
            started.unwrap();
            navigated.unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while frames.lock().unwrap().is_empty() {
                assert!(Instant::now() < deadline, "no frame");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(frames.lock().unwrap()[0], (1280, 800));
            browser.context.close().await;
        }
    });
}
