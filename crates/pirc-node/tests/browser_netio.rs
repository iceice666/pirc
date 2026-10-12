//! The netio area of the native browser against a real Chromium: the host
//! guard on requests and WebSockets (`engine::network`), keyboard and
//! mouse (`engine::input`), screenshots and the screencast. Each test
//! launches Chromium as the engine does and drives one CDP page session
//! directly (the page/frame layer is tested elsewhere).
//!
//! Skipped, with a message, when no Chromium is found (`chromium`,
//! `chromium-browser`, `google-chrome-stable`, `google-chrome`,
//! `microsoft-edge` on PATH, or the macOS application bundles), or
//! `PIRC_BROWSER_EXECUTABLE`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pirc_node::browser::engine::cdp::{Connection, Session};
use pirc_node::browser::engine::launch;
use pirc_node::browser::engine::network::{self, TargetKind};
use pirc_node::browser::hosts::HostGuard;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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

struct Browser {
    _launched: launch::Launched,
    _profile: tempfile::TempDir,
    connection: Arc<Connection>,
}

impl Browser {
    fn start() -> Option<Self> {
        let Some(executable) = chromium() else {
            eprintln!("skipped: no Chromium found");
            return None;
        };
        let profile = tempfile::tempdir().unwrap();
        let env: BTreeMap<String, String> = std::env::vars()
            .filter(|(name, _)| matches!(name.as_str(), "PATH" | "HOME" | "TMPDIR" | "LANG"))
            .collect();
        let launched = launch::launch(&executable, profile.path(), &env).unwrap();
        let connection = launched.connection.clone();
        Some(Self {
            _launched: launched,
            _profile: profile,
            connection,
        })
    }

    /// A new page target attached in flat mode, with Page, Runtime and
    /// Network enabled.
    async fn page(&self) -> Session {
        let browser = self.connection.browser();
        let target = browser
            .call("Target.createTarget", json!({ "url": "about:blank" }))
            .await
            .unwrap();
        let attached = browser
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target["targetId"], "flatten": true }),
            )
            .await
            .unwrap();
        let session = self
            .connection
            .session(attached["sessionId"].as_str().unwrap());
        for method in ["Page.enable", "Runtime.enable", "Network.enable"] {
            session.call(method, json!({})).await.unwrap();
        }
        session
    }
}

/// Navigate and wait for `load`.
async fn goto(session: &Session, url: &str) {
    let mut events = session.listen();
    session
        .call("Page.navigate", json!({ "url": url }))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = events.recv().await {
            if event.method == "Page.loadEventFired" {
                return;
            }
        }
    })
    .await
    .expect("load");
}

/// `Runtime.evaluate` with `awaitPromise`, by value.
async fn eval(session: &Session, expression: &str) -> Value {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }),
        )
        .await
        .unwrap();
    assert!(
        result.get("exceptionDetails").is_none(),
        "{expression}: {result}"
    );
    result["result"]["value"].clone()
}

/// A tiny HTTP server: `GET /` pages from `routes`, every request line
/// recorded.
#[derive(Clone)]
struct Server {
    port: u16,
    hits: Arc<Mutex<Vec<String>>>,
}

type Routes = Arc<dyn Fn(&str) -> (u16, Vec<(String, String)>, String) + Send + Sync>;

async fn serve(address: &str, routes: Routes) -> Option<Server> {
    let listener = TcpListener::bind(address).await.ok()?;
    let port = listener.local_addr().unwrap().port();
    let hits: Arc<Mutex<Vec<String>>> = Arc::default();
    let recorded = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let routes = routes.clone();
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buffer).into_owned();
                let line = head.lines().next().unwrap_or_default().to_owned();
                recorded.lock().unwrap().push(line.clone());
                if head.to_ascii_lowercase().contains("upgrade: websocket") {
                    // Hand the socket to tungstenite with the bytes read so far.
                    let stream = Prefixed { buffer, stream };
                    if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                        use futures_util::{SinkExt, StreamExt};
                        while let Some(Ok(message)) = ws.next().await {
                            if message.is_text() && ws.send(message).await.is_err() {
                                break;
                            }
                        }
                    }
                    return;
                }
                let path = line.split(' ').nth(1).unwrap_or("/").to_owned();
                let (status, headers, body) = routes(&path);
                let mut response = format!(
                    "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                response.push_str("\r\n");
                response.push_str(&body);
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    Some(Server { port, hits })
}

impl Server {
    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

/// A stream that replays already-read bytes first.
struct Prefixed {
    buffer: Vec<u8>,
    stream: tokio::net::TcpStream,
}

impl tokio::io::AsyncRead for Prefixed {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if !self.buffer.is_empty() {
            let n = self.buffer.len().min(buf.remaining());
            buf.put_slice(&self.buffer[..n]);
            self.buffer.drain(..n);
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for Prefixed {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

fn html(body: &str) -> (u16, Vec<(String, String)>, String) {
    (
        200,
        vec![("content-type".into(), "text/html".into())],
        body.to_owned(),
    )
}

/// 127.0.0.1 is allowed, every other private address blocked (127.0.0.2
/// stands for "a private host").
fn guard() -> Arc<HostGuard> {
    Arc::new(HostGuard::from_policy(
        &["127.0.0.1"],
        None,
        &[],
        pirc_node::browser::hosts::system_resolver(),
    ))
}

// ---- network ---------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn guards_requests_websockets_and_service_workers() {
    let Some(browser) = Browser::start() else {
        return;
    };
    // The "private" server; on hosts without 127.0.0.2 (macOS) the blocked
    // requests are told apart by their error only.
    let private = serve("127.0.0.2:0", Arc::new(|_| html("private"))).await;
    let private_port = private.as_ref().map_or(9, |server| server.port);
    let other = serve("127.0.0.1:0", Arc::new(|_| html("other")))
        .await
        .unwrap();
    let other_port = other.port;
    let public = serve(
        "127.0.0.1:0",
        Arc::new(move |path| match path {
            "/redirect" => (
                302,
                vec![(
                    "location".into(),
                    format!("http://127.0.0.2:{private_port}/hop"),
                )],
                String::new(),
            ),
            "/worker.js" => (
                200,
                vec![("content-type".into(), "text/javascript".into())],
                format!(
                    "onmessage = async () => {{ try {{ await fetch('http://127.0.0.2:{private_port}/worker'); postMessage('ok'); }} catch (e) {{ postMessage('blocked'); }} }};"
                ),
            ),
            "/sw.js" => (
                200,
                vec![("content-type".into(), "text/javascript".into())],
                String::new(),
            ),
            _ => html("<title>public</title>"),
        }),
    )
    .await
    .unwrap();
    let page = browser.page().await;
    let mut network_events = page.listen();
    let _installed = network::install(&page, TargetKind::Page, guard())
        .await
        .unwrap();
    let base = format!("http://127.0.0.1:{}", public.port);
    goto(&page, &format!("{base}/")).await;
    assert_eq!(eval(&page, "document.title").await, "public");

    // A subresource to a blocked host fails BlockedByClient and never
    // reaches it.
    let blocked = format!("http://127.0.0.2:{private_port}/fetch");
    assert_eq!(
        eval(
            &page,
            &format!("fetch('{blocked}').then(() => 'ok', () => 'blocked')")
        )
        .await,
        "blocked"
    );
    let mut reason = None;
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_secs(5), network_events.recv()).await
    {
        if event.method == "Network.loadingFailed" {
            reason = event.params["errorText"].as_str().map(str::to_owned);
            break;
        }
    }
    // Chromium names the client that blocked it.
    assert_eq!(
        reason.as_deref(),
        Some("net::ERR_BLOCKED_BY_CLIENT.Inspector")
    );

    // A dedicated worker's requests pause on the page's session.
    let worker = eval(
        &page,
        "new Promise(resolve => { const w = new Worker('/worker.js'); w.onmessage = e => resolve(e.data); w.postMessage(0); })",
    )
    .await;
    assert_eq!(worker, "blocked");

    // Allowed hosts load; a CORS preflight is answered as Playwright does
    // (never sent).
    let cross = format!("http://127.0.0.1:{other_port}/cors");
    let status = eval(
        &page,
        &format!(
            "fetch('{cross}', {{ method: 'PUT', headers: {{ 'x-pirc': '1' }} }}).then(r => 'ok ' + r.status, e => 'error ' + e)"
        ),
    )
    .await;
    // The real response lacks CORS headers, so the page sees a failure;
    // what matters is that the PUT was sent and the OPTIONS was not.
    assert!(status.as_str().unwrap().starts_with("error"), "{status}");
    let hits = other.hits();
    assert!(
        hits.iter().any(|hit| hit.starts_with("PUT /cors")),
        "{hits:?}"
    );
    assert!(
        !hits.iter().any(|hit| hit.starts_with("OPTIONS")),
        "{hits:?}"
    );

    // Redirect hops are not routed (TS parity): the hop reaches the
    // blocked host.
    if let Some(private) = &private {
        let _ = eval(
            &page,
            &format!("fetch('{base}/redirect').then(() => 'ok', () => 'error')"),
        )
        .await;
        assert!(
            private.hits().iter().any(|hit| hit.starts_with("GET /hop")),
            "{:?}",
            private.hits()
        );
        assert!(
            !private
                .hits()
                .iter()
                .any(|hit| hit.contains("/fetch") || hit.contains("/worker")),
            "{:?}",
            private.hits()
        );
    }

    // WebSockets: blocked ones close with 1008, allowed ones echo.
    let closed = eval(
        &page,
        &format!(
            "new Promise(resolve => {{ const ws = new WebSocket('ws://127.0.0.2:{private_port}/'); ws.onopen = () => resolve('open'); ws.onclose = e => resolve([e.code, e.reason, e.wasClean, ws.readyState].join(' ')); }})"
        ),
    )
    .await;
    assert_eq!(closed, "1008 blocked by pirc true 3");
    let echoed = eval(
        &page,
        &format!(
            "new Promise(resolve => {{ const ws = new WebSocket('ws://127.0.0.1:{other_port}/'); ws.onopen = () => ws.send('hi'); ws.onmessage = e => {{ resolve(e.data); ws.close(); }}; ws.onclose = e => resolve('closed ' + e.code); }})"
        ),
    )
    .await;
    assert_eq!(echoed, "hi");

    // Service workers are blocked as Playwright's `serviceWorkers: 'block'`.
    let registered = eval(
        &page,
        "navigator.serviceWorker.register('/sw.js').then(r => String(r))",
    )
    .await;
    assert_eq!(registered, "undefined");
}

/// Auto-attach every target of the browser as the context does: service
/// workers get the guard (a pirc deviation), then everything runs.
fn auto_attach(browser: &Browser) -> tokio::task::JoinHandle<()> {
    let connection = browser.connection.clone();
    let root = connection.browser();
    let mut events = root.listen();
    tokio::spawn(async move {
        let mut installed = Vec::new();
        while let Some(event) = events.recv().await {
            if event.method != "Target.attachedToTarget" {
                continue;
            }
            let session = connection.session(event.params["sessionId"].as_str().unwrap());
            if event.params["targetInfo"]["type"] == "service_worker" {
                installed.push(
                    network::install(&session, TargetKind::ServiceWorker, guard())
                        .await
                        .unwrap(),
                );
            }
            let _ = session
                .call("Runtime.runIfWaitingForDebugger", json!({}))
                .await;
        }
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn guards_a_service_worker_that_registers_anyway() {
    let Some(browser) = Browser::start() else {
        return;
    };
    let private = serve("127.0.0.2:0", Arc::new(|_| html("private"))).await;
    let private_port = private.as_ref().map_or(9, |server| server.port);
    let public = serve(
        "127.0.0.1:0",
        Arc::new(move |path| match path {
            "/sw.js" => (
                200,
                vec![("content-type".into(), "text/javascript".into())],
                format!(
                    "self.onmessage = async e => {{ let r; try {{ await fetch('http://127.0.0.2:{private_port}/sw'); r = 'ok'; }} catch (x) {{ r = 'blocked'; }} e.source.postMessage(r); }};"
                ),
            ),
            _ => html("<title>public</title>"),
        }),
    )
    .await
    .unwrap();
    let watcher = auto_attach(&browser);
    browser
        .connection
        .browser()
        .call(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
        )
        .await
        .unwrap();
    let page = browser.page().await;
    let _installed = network::install(&page, TargetKind::Page, guard())
        .await
        .unwrap();
    goto(&page, &format!("http://127.0.0.1:{}/", public.port)).await;
    // The prototype's `register` is not replaced by Playwright's init script.
    let answer = eval(
        &page,
        "ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js')
            .then(() => navigator.serviceWorker.ready)
            .then(r => new Promise(resolve => {
                navigator.serviceWorker.onmessage = e => resolve(e.data);
                r.active.postMessage(0);
            }))",
    )
    .await;
    assert_eq!(answer, "blocked");
    if let Some(private) = private {
        assert!(private.hits().is_empty(), "{:?}", private.hits());
    }
    watcher.abort();
}
