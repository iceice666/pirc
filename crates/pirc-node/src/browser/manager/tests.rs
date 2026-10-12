//! The session lifecycle with a fake context behind [`Launcher`]
//! (`browser.test.ts`'s "BrowserManager session lifecycle"), and the rest
//! of the manager's bookkeeping that needs no Chromium.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt as _;
use futures_util::stream::BoxStream;
use pirc_config::node::{BrowserSettings, Viewport};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::seam::{
    ContextApi, ContextRef, FrameApi, FrameSink as CastSink, Launcher, LocatorApi, PageApi,
    PageEvent, PageRef, Selector,
};
use super::{BrowserManager, LazyHosts};
use crate::browser::engine::screencast::ScreencastOptions;
use crate::browser::engine::screenshot::ScreenshotOptions;
use crate::browser::engine::{self, LoadState, MouseButton};
use crate::browser::{BoxFuture, BrowserService, BrowserTarget, FrameSink};
use crate::error::ApiError;

fn fake_error<T>() -> engine::Result<T> {
    Err(engine::Error::new("fake page"))
}

#[derive(Default)]
struct FakePage {
    url: Mutex<String>,
    subscribers: Mutex<Vec<mpsc::UnboundedSender<PageEvent>>>,
    closed: AtomicBool,
}

impl FakePage {
    fn new(url: &str) -> Arc<Self> {
        Arc::new(Self {
            url: Mutex::new(url.to_owned()),
            ..Self::default()
        })
    }

    fn emit(&self, event: impl Fn() -> PageEvent) {
        for subscriber in self.subscribers.lock().unwrap().iter() {
            let _ = subscriber.send(event());
        }
    }
}

impl PageApi for FakePage {
    fn subscribe(&self) -> BoxStream<'static, PageEvent> {
        let (send, receive) = mpsc::unbounded_channel();
        self.subscribers.lock().unwrap().push(send);
        futures_util::stream::unfold(receive, |mut receive| async move {
            receive.recv().await.map(|event| (event, receive))
        })
        .boxed()
    }
    fn url(&self) -> String {
        self.url.lock().unwrap().clone()
    }
    fn title(&self) -> BoxFuture<'_, engine::Result<String>> {
        Box::pin(async { Ok("Fake".to_owned()) })
    }
    fn content(&self) -> BoxFuture<'_, engine::Result<String>> {
        Box::pin(async { fake_error() })
    }
    fn frames(&self) -> Vec<Arc<dyn FrameApi>> {
        Vec::new()
    }
    fn goto<'a>(
        &'a self,
        _: &'a str,
        _: LoadState,
        _: Duration,
    ) -> BoxFuture<'a, engine::Result<Option<u16>>> {
        Box::pin(async { fake_error() })
    }
    fn go_back(&self, _: LoadState, _: Duration) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn go_forward(&self, _: Duration) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn reload(&self, _: Duration) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn wait_for_load_state(&self, _: LoadState, _: Duration) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn evaluate<'a>(&'a self, _: &'a str) -> BoxFuture<'a, engine::Result<Value>> {
        Box::pin(async { fake_error() })
    }
    fn aria_snapshot(&self, _: Duration) -> BoxFuture<'_, engine::Result<String>> {
        Box::pin(async { Ok("- generic [ref=e1]".to_owned()) })
    }
    fn locator(self: Arc<Self>, _: Selector) -> Box<dyn LocatorApi> {
        unimplemented!("no locators on the fake page")
    }
    fn press<'a>(&'a self, _: &'a str) -> BoxFuture<'a, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn insert_text<'a>(&'a self, _: &'a str) -> BoxFuture<'a, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn mouse_move(&self, _: f64, _: f64) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn mouse_down(&self, _: MouseButton, _: u32) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn mouse_up(&self, _: MouseButton, _: u32) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn mouse_wheel(&self, _: f64, _: f64) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn screenshot(&self, _: ScreenshotOptions) -> BoxFuture<'_, engine::Result<Vec<u8>>> {
        Box::pin(async { Ok(vec![0xff, 0xd8, 0xff]) })
    }
    fn start_screencast(
        &self,
        _: ScreencastOptions,
        _: CastSink,
    ) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn stop_screencast(&self) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn bring_to_front(&self) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn close(&self) -> BoxFuture<'_, engine::Result<()>> {
        Box::pin(async {
            if !self.closed.swap(true, Ordering::SeqCst) {
                self.emit(|| PageEvent::Closed);
            }
            Ok(())
        })
    }
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

/// `fakeContext()`: counts `newPage` and `close`.
#[derive(Default)]
struct FakeContext {
    initial: Vec<PageRef>,
    created: Mutex<Vec<Arc<FakePage>>>,
    new_page_calls: AtomicUsize,
    close_calls: AtomicUsize,
    gone: Mutex<Option<watch::Sender<bool>>>,
}

impl FakeContext {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            gone: Mutex::new(Some(watch::channel(false).0)),
            ..Self::default()
        })
    }

    fn stats(&self) -> (usize, usize) {
        (
            self.new_page_calls.load(Ordering::SeqCst),
            self.close_calls.load(Ordering::SeqCst),
        )
    }

    fn page(&self, index: usize) -> Arc<FakePage> {
        self.created.lock().unwrap()[index].clone()
    }

    /// Chromium went away by itself.
    fn crash(&self) {
        if let Some(gone) = self.gone.lock().unwrap().as_ref() {
            gone.send_replace(true);
        }
    }
}

impl ContextApi for FakeContext {
    fn pages(&self) -> Vec<PageRef> {
        self.initial.clone()
    }
    fn new_page(&self) -> BoxFuture<'_, engine::Result<PageRef>> {
        Box::pin(async {
            self.new_page_calls.fetch_add(1, Ordering::SeqCst);
            let page = FakePage::new("about:blank");
            self.created.lock().unwrap().push(page.clone());
            Ok(page as PageRef)
        })
    }
    fn closed(&self) -> BoxFuture<'_, ()> {
        let mut gone = self.gone.lock().unwrap().as_ref().unwrap().subscribe();
        Box::pin(async move {
            let _ = gone.wait_for(|gone| *gone).await;
        })
    }
    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {
            self.close_calls.fetch_add(1, Ordering::SeqCst);
            self.crash();
        })
    }
}

type LaunchFn = dyn Fn() -> BoxFuture<'static, Result<ContextRef, String>> + Send + Sync;

/// `settings.launch`.
struct FakeLauncher {
    launch: Box<LaunchFn>,
    calls: AtomicUsize,
    profiles: Mutex<Vec<PathBuf>>,
}

impl Launcher for FakeLauncher {
    fn launch(
        &self,
        _: &Path,
        profile_dir: &Path,
        _: (u32, u32),
        _: BTreeMap<String, String>,
        _: Arc<LazyHosts>,
    ) -> BoxFuture<'static, Result<ContextRef, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.profiles.lock().unwrap().push(profile_dir.to_owned());
        (self.launch)()
    }
}

fn settings(profiles: &Path) -> BrowserSettings {
    BrowserSettings {
        enabled: true,
        executable: Some("/fake/chromium".into()),
        ffmpeg: "ffmpeg".into(),
        profiles_dir: profiles.to_owned(),
        idle_ms: 60_000,
        viewport: Viewport {
            width: 800,
            height: 600,
        },
        allow_private_hosts: Vec::new(),
        gateway_host: String::new(),
        blocked_hosts: Vec::new(),
    }
}

struct Fixture {
    manager: Arc<BrowserManager>,
    launcher: Arc<FakeLauncher>,
    _profiles: tempfile::TempDir,
}

fn manager_with(
    settings_of: impl FnOnce(&Path) -> BrowserSettings,
    launch: Box<LaunchFn>,
) -> Fixture {
    let profiles = tempfile::tempdir().unwrap();
    let launcher = Arc::new(FakeLauncher {
        launch,
        calls: AtomicUsize::new(0),
        profiles: Mutex::new(Vec::new()),
    });
    let manager = Arc::new(BrowserManager::with_launcher(
        settings_of(profiles.path()),
        BTreeMap::new(),
        launcher.clone(),
    ));
    Fixture {
        manager,
        launcher,
        _profiles: profiles,
    }
}

/// A manager whose launches all return `context` at once.
fn ready(context: &Arc<FakeContext>) -> Fixture {
    let context = context.clone();
    manager_with(
        settings,
        Box::new(move || {
            let context = context.clone() as ContextRef;
            Box::pin(async move { Ok(context) })
        }),
    )
}

/// A manager whose (single) launch waits for the returned sender.
fn gated_manager() -> (Fixture, oneshot::Sender<ContextRef>, oneshot::Receiver<()>) {
    let (open, gate) = oneshot::channel::<ContextRef>();
    let (started, launch_started) = oneshot::channel::<()>();
    let gate = Mutex::new(Some((gate, started)));
    let fixture = manager_with(
        settings,
        Box::new(move || {
            let (gate, started) = gate.lock().unwrap().take().expect("one launch");
            let _ = started.send(());
            Box::pin(async move { gate.await.map_err(|_| "gate dropped".to_owned()) })
        }),
    );
    (fixture, open, launch_started)
}

fn target(session: &str, workspace: &str) -> BrowserTarget {
    BrowserTarget {
        session_id: session.into(),
        workspace_id: workspace.into(),
        root: std::env::temp_dir(),
    }
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn spawn_handle(
    manager: &Arc<BrowserManager>,
    target: &BrowserTarget,
    op: &str,
    args: Value,
) -> tokio::task::JoinHandle<Result<Value, ApiError>> {
    let manager = manager.clone();
    let target = target.clone();
    let op = op.to_owned();
    tokio::spawn(async move { manager.handle(target, op, args).await })
}

fn code(result: Result<Value, ApiError>) -> String {
    result.unwrap_err().code.into_owned()
}

#[tokio::test]
async fn drains_a_pending_launch_before_closing_and_never_creates_a_late_tab() {
    let (fixture, open, launch_started) = gated_manager();
    let manager = &fixture.manager;
    let target = target("pending-close", "launch-drain");
    let request = spawn_handle(
        manager,
        &target,
        "navigate",
        json!({ "url": "https://example.com" }),
    );
    launch_started.await.unwrap();

    let closing = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.close_session("pending-close").await })
    };
    settle().await;
    assert!(!closing.is_finished());

    let fake = FakeContext::new();
    let _ = open.send(fake.clone());
    closing.await.unwrap();
    let error = request.await.unwrap().unwrap_err();
    assert_eq!((error.status, &*error.code), (409, "conflict"));
    assert_eq!(error.message, "The browser session is closing");
    assert_eq!(fake.stats(), (0, 1));
    let status = manager
        .handle(target, "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["active"], false);
    manager.shutdown().await;
}

/// `controller.abort()` while the launch is pending: dropping the request
/// changes nothing (TS's abort did not interrupt the launch either).
#[tokio::test]
async fn an_abandoned_request_still_drains_with_its_launch() {
    let (fixture, open, launch_started) = gated_manager();
    let manager = &fixture.manager;
    let target = target("pending-close", "launch-drain");
    let request = manager.handle(
        target.clone(),
        "navigate".into(),
        json!({ "url": "https://example.com" }),
    );
    let request = tokio::time::timeout(Duration::from_millis(1), request);
    let (_, launched) = tokio::join!(request, launch_started);
    launched.unwrap();
    let closing = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.close_session("pending-close").await })
    };
    settle().await;
    assert!(!closing.is_finished());
    let fake = FakeContext::new();
    let _ = open.send(fake.clone());
    closing.await.unwrap();
    assert_eq!(fake.stats(), (0, 1));
    manager.shutdown().await;
}

#[tokio::test]
async fn keeps_a_shared_workspace_context_alive_for_another_pending_session() {
    let (fixture, open, launch_started) = gated_manager();
    let manager = &fixture.manager;
    let first = target("closing-session", "shared-launch");
    let second = target("active-session", "shared-launch");
    let first_request = spawn_handle(manager, &first, "handoff", json!({ "reason": "close me" }));
    let second_request = spawn_handle(manager, &second, "handoff", json!({ "reason": "keep me" }));
    launch_started.await.unwrap();
    settle().await;

    let closing = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.close_session("closing-session").await })
    };
    settle().await;
    let fake = FakeContext::new();
    let _ = open.send(fake.clone());
    assert_eq!(code(first_request.await.unwrap()), "conflict");
    let kept = second_request.await.unwrap().unwrap();
    assert_eq!(kept["active"], true);
    assert_eq!(kept["mode"], "user");
    assert_eq!(kept["handoff"], "keep me");
    closing.await.unwrap();
    assert_eq!(fake.stats().1, 0);

    manager.close_session("active-session").await;
    assert_eq!(fake.stats().1, 1);
    assert_eq!(fixture.launcher.calls.load(Ordering::SeqCst), 1);
    manager.shutdown().await;
}

#[tokio::test]
async fn cancels_control_waits_when_a_session_closes_or_the_manager_shuts_down() {
    let target = target("waiting-session", "waiting-workspace");
    let closed_context = FakeContext::new();
    let fixture = ready(&closed_context);
    let manager = &fixture.manager;
    manager
        .handle(
            target.clone(),
            "handoff".into(),
            json!({ "reason": "user input" }),
        )
        .await
        .unwrap();
    let wait = spawn_handle(manager, &target, "wait_control", json!({}));
    settle().await;
    let closing = manager.close_session("waiting-session");
    assert_eq!(code(wait.await.unwrap()), "conflict");
    closing.await;
    assert_eq!(closed_context.stats().1, 1);
    manager.shutdown().await;

    let shutdown_context = FakeContext::new();
    let fixture = ready(&shutdown_context);
    let manager = &fixture.manager;
    let target = BrowserTarget {
        session_id: "shutdown-waiting-session".into(),
        ..target
    };
    manager
        .handle(
            target.clone(),
            "handoff".into(),
            json!({ "reason": "user input" }),
        )
        .await
        .unwrap();
    let wait = spawn_handle(manager, &target, "wait_control", json!({}));
    settle().await;
    manager.shutdown().await;
    assert_eq!(code(wait.await.unwrap()), "conflict");
    assert_eq!(shutdown_context.stats().1, 1);
    // Shut down: nothing more is accepted.
    let error = manager
        .handle(target, "status".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.code, &*error.message),
        (503, "runner_unavailable", "The node is shutting down")
    );
}

#[tokio::test]
async fn refuses_when_disabled_or_without_chromium() {
    let context = FakeContext::new();
    let disabled = manager_with(
        |dir| BrowserSettings {
            enabled: false,
            ..settings(dir)
        },
        Box::new(move || {
            let context = context.clone() as ContextRef;
            Box::pin(async move { Ok(context) })
        }),
    );
    assert!(!disabled.manager.enabled());
    let error = disabled
        .manager
        .handle(target("s", "w"), "status".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.code, &*error.message),
        (
            403,
            "forbidden",
            "The browser is disabled on this node (PIRC_BROWSER)"
        )
    );

    let missing = manager_with(
        |dir| BrowserSettings {
            executable: None,
            ..settings(dir)
        },
        Box::new(|| Box::pin(async { Err("unused".to_owned()) })),
    );
    assert!(!missing.manager.enabled());
    let error = missing
        .manager
        .handle(target("s", "w"), "close".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.code, &*error.message),
        (
            503,
            "runner_unavailable",
            "No Chromium found on this node; set PIRC_BROWSER_EXECUTABLE"
        )
    );
}

#[tokio::test]
async fn status_and_viewers_launch_nothing() {
    let context = FakeContext::new();
    let fixture = ready(&context);
    let manager = &fixture.manager;
    assert!(manager.enabled());
    let status = manager
        .handle(target("s", "w"), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(
        status,
        json!({ "active": false, "url": "", "title": "", "mode": "agent", "handoff": null,
            "agentWaiting": false, "action": null, "recording": null, "tabs": [],
            "viewport": { "width": 800, "height": 600 } })
    );
    let frames = Arc::new(Mutex::new(Vec::new()));
    let sink: FrameSink = {
        let frames = frames.clone();
        Arc::new(move |frame| frames.lock().unwrap().push(frame))
    };
    let detach = manager.attach("s", sink);
    assert_eq!(
        frames.lock().unwrap()[0],
        json!({ "type": "state", "state": status })
    );
    assert_eq!(
        frames.lock().unwrap()[1],
        json!({ "type": "log", "entries": [] })
    );
    let answer = manager
        .input(target("s", "w"), json!({ "type": "key", "key": "a" }))
        .await
        .unwrap();
    assert_eq!(
        answer,
        Some(json!({ "type": "error", "code": "not_found",
            "message": "No browser is open for this session" }))
    );
    let image = manager
        .input(
            target("s", "w"),
            json!({ "type": "log_image", "index": 3.7 }),
        )
        .await
        .unwrap();
    assert_eq!(
        image,
        Some(json!({ "type": "log_image", "index": 3, "data": null }))
    );
    detach();
    assert_eq!(fixture.launcher.calls.load(Ordering::SeqCst), 0);
    manager.shutdown().await;
}

#[tokio::test]
async fn reports_a_failed_launch_and_tries_again_later() {
    let fixture = manager_with(
        settings,
        Box::new(|| Box::pin(async { Err("spawn chromium ENOENT\nmore detail".to_owned()) })),
    );
    let manager = &fixture.manager;
    let target = target("s", "w/../x y");
    for attempt in 1..=2 {
        let error = manager
            .handle(target.clone(), "snapshot".into(), json!({}))
            .await
            .unwrap_err();
        assert_eq!(
            (error.status, &*error.code, &*error.message),
            (
                503,
                "runner_unavailable",
                "Could not start the browser: spawn chromium ENOENT"
            )
        );
        assert_eq!(fixture.launcher.calls.load(Ordering::SeqCst), attempt);
    }
    let profile = fixture.launcher.profiles.lock().unwrap()[0].clone();
    assert_eq!(profile.file_name().unwrap(), "w____x_y");
    use std::os::unix::fs::PermissionsExt as _;
    assert_eq!(
        std::fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
        0o700
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn adopts_the_spare_blank_page_then_opens_new_ones_up_to_eight() {
    let spare = FakePage::new("about:blank");
    let context = Arc::new(FakeContext {
        initial: vec![spare.clone() as PageRef],
        gone: Mutex::new(Some(watch::channel(false).0)),
        ..FakeContext::default()
    });
    let fixture = ready(&context);
    let manager = &fixture.manager;
    let first = target("s1", "w");
    manager
        .handle(first.clone(), "handoff".into(), json!({ "reason": "x" }))
        .await
        .unwrap();
    assert_eq!(context.stats().0, 0);
    // The spare page is taken: the next session gets a new one.
    let second = target("s2", "w");
    let view = manager
        .handle(second.clone(), "release".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(view["active"], true);
    assert_eq!(context.stats().0, 1);
    for count in 2..=8 {
        let tabs = manager
            .handle(second.clone(), "tabs".into(), json!({ "action": "new" }))
            .await
            .unwrap();
        assert_eq!(tabs["tabs"].as_array().unwrap().len(), count);
        assert_eq!(
            tabs["tabs"][count - 1],
            json!({ "index": count - 1, "url": "about:blank",
            "title": "Fake", "active": true })
        );
    }
    let error = manager
        .handle(second.clone(), "tabs".into(), json!({ "action": "new" }))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.code, &*error.message),
        (409, "conflict", "At most 8 tabs per session")
    );
    for (index, message) in [(json!(8), "No tab 8"), (Value::Null, "No tab null")] {
        let error = manager
            .handle(
                second.clone(),
                "tabs".into(),
                json!({ "action": "select", "index": index }),
            )
            .await
            .unwrap_err();
        assert_eq!((error.status, &*error.message), (404, message));
    }
    let error = manager
        .handle(second.clone(), "tabs".into(), json!({ "action": "close" }))
        .await
        .unwrap_err();
    assert_eq!(error.message, "No tab undefined");
    let error = manager
        .handle(second.clone(), "tabs".into(), json!({ "action": 3 }))
        .await
        .unwrap_err();
    assert_eq!(error.message, "action is list, new, select or close");
    let tabs = manager
        .handle(
            second.clone(),
            "tabs".into(),
            json!({ "action": "select", "index": 0 }),
        )
        .await
        .unwrap();
    assert_eq!(tabs["tabs"][0]["active"], true);
    // Closing the active tab makes the last one active.
    manager
        .handle(
            second.clone(),
            "tabs".into(),
            json!({ "action": "close", "index": 0 }),
        )
        .await
        .unwrap();
    settle().await;
    let status = manager
        .handle(second.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["tabs"].as_array().unwrap().len(), 7);
    assert_eq!(status["tabs"][6]["active"], true);
    let error = manager
        .handle(second, "frobnicate".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.message),
        (400, "Unknown browser operation frobnicate")
    );
    manager.shutdown().await;
    assert!(spare.is_closed());
}

#[tokio::test]
async fn hands_off_waits_for_the_user_and_times_out() {
    let context = FakeContext::new();
    let fixture = ready(&context);
    let manager = &fixture.manager;
    let target = target("s", "w");
    let error = manager
        .handle(target.clone(), "handoff".into(), json!({ "reason": "" }))
        .await
        .unwrap_err();
    assert_eq!(error.message, "reason must be a non-empty string");
    let view = manager
        .handle(
            target.clone(),
            "handoff".into(),
            json!({ "reason": "Please log in" }),
        )
        .await
        .unwrap();
    assert_eq!(
        (&view["mode"], &view["handoff"]),
        (&json!("user"), &json!("Please log in"))
    );
    let error = manager
        .handle(target.clone(), "snapshot".into(), json!({ "waitMs": 30 }))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.code, &*error.message),
        (
            409,
            "user_in_control",
            "The user still controls the browser. Wait, or ask them to return control."
        )
    );
    let status = manager
        .handle(target.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["agentWaiting"], false);

    // An abandoned wait (`browser_cancel`) stops waiting.
    let waiting = manager.handle(target.clone(), "wait_control".into(), json!({}));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), waiting)
            .await
            .is_err()
    );
    settle().await;
    let status = manager
        .handle(target.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["agentWaiting"], false);

    let waiting = spawn_handle(manager, &target, "wait_control", json!({}));
    settle().await;
    let status = manager
        .handle(target.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["agentWaiting"], true);
    // Viewer input other than control needs user mode, which this is.
    let answer = manager
        .input(target.clone(), json!({ "type": "zoom" }))
        .await
        .unwrap();
    assert_eq!(
        answer,
        Some(
            json!({ "type": "error", "code": "invalid_input", "message": "Unknown message zoom" })
        )
    );
    assert_eq!(
        manager
            .input(target.clone(), json!({ "type": "release" }))
            .await
            .unwrap(),
        None
    );
    let summary = waiting.await.unwrap().unwrap();
    assert_eq!(
        summary,
        json!({ "url": "about:blank", "title": "Fake", "snapshot": "- generic [ref=e1]",
            "offset": 0, "totalChars": 18, "truncated": false })
    );
    let answer = manager
        .input(target.clone(), json!({ "type": "text", "text": "x" }))
        .await
        .unwrap();
    assert_eq!(
        answer,
        Some(json!({ "type": "error", "code": "agent_in_control",
            "message": "Take over the browser first" }))
    );
    let view = manager
        .handle(target.clone(), "release".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(view["mode"], "agent");
    assert_eq!(
        manager
            .handle(target, "close".into(), json!({}))
            .await
            .unwrap(),
        json!({ "closed": true })
    );
    manager.shutdown().await;
}

#[tokio::test]
async fn streams_state_and_the_action_log_to_viewers() {
    let context = FakeContext::new();
    let fixture = ready(&context);
    let manager = &fixture.manager;
    let target = target("s", "w");
    let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink: FrameSink = {
        let frames = frames.clone();
        Arc::new(move |frame| frames.lock().unwrap().push(frame))
    };
    let detach = manager.attach("s", sink);
    assert_eq!(
        manager
            .input(target.clone(), json!({ "type": "takeover" }))
            .await
            .unwrap(),
        None
    );
    // Twice: the second changes nothing.
    assert_eq!(
        manager
            .input(target.clone(), json!({ "type": "takeover" }))
            .await
            .unwrap(),
        None
    );
    manager
        .input(target.clone(), json!({ "type": "release" }))
        .await
        .unwrap();
    settle().await;
    let entries: Vec<Value> = frames
        .lock()
        .unwrap()
        .iter()
        .filter(|frame| frame["type"] == "log_entry")
        .map(|frame| frame["entry"].clone())
        .collect();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        (
            &entries[0]["index"],
            &entries[0]["actor"],
            &entries[0]["action"],
            &entries[0]["image"]
        ),
        (
            &json!(0),
            &json!("user"),
            &json!("User took control"),
            &json!(false)
        )
    );
    assert_eq!(
        (
            &entries[1]["index"],
            &entries[1]["action"],
            &entries[1]["image"],
            &entries[1]["url"]
        ),
        (
            &json!(1),
            &json!("User returned control"),
            &json!(true),
            &json!("about:blank")
        )
    );
    let image = manager
        .input(target.clone(), json!({ "type": "log_image", "index": 1 }))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(image["data"], "/9j/");
    assert!(
        frames
            .lock()
            .unwrap()
            .iter()
            .any(|frame| frame["type"] == "state"
                && frame["state"]["mode"] == "user"
                && frame["state"]["title"] == "Fake"
                && frame["state"]["tabs"][0]["title"] == "Fake")
    );

    // A popup joins the session as its active tab.
    let popup = FakePage::new("https://example.com/popup");
    context
        .page(0)
        .emit(|| PageEvent::Popup(popup.clone() as PageRef));
    settle().await;
    let status = manager
        .handle(target.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["url"], "https://example.com/popup");
    assert_eq!(status["tabs"].as_array().unwrap().len(), 2);
    assert!(
        frames
            .lock()
            .unwrap()
            .iter()
            .any(|frame| frame["type"] == "log_entry"
                && frame["entry"]["action"] == "Popup opened: https://example.com/popup")
    );

    // Chromium went away: the session's tab is gone, viewers see it.
    context.crash();
    settle().await;
    let status = manager
        .handle(target.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(status["active"], false);
    let last_state = frames
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|frame| frame["type"] == "state")
        .cloned()
        .unwrap();
    assert_eq!(last_state["state"]["active"], false);
    detach();
    manager.shutdown().await;
}

#[tokio::test]
async fn stops_a_recording_when_ffmpeg_is_missing() {
    let context = FakeContext::new();
    let fixture = manager_with(
        |dir| BrowserSettings {
            ffmpeg: "/nonexistent/ffmpeg".into(),
            ..settings(dir)
        },
        {
            let context = context.clone();
            Box::new(move || {
                let context = context.clone() as ContextRef;
                Box::pin(async move { Ok(context) })
            })
        },
    );
    let manager = &fixture.manager;
    let root = tempfile::tempdir().unwrap();
    let target = BrowserTarget {
        root: root.path().to_owned(),
        ..target("s", "w")
    };
    let error = manager
        .handle(
            target.clone(),
            "record".into(),
            json!({ "action": "start" }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.code, &*error.message),
        (
            503,
            "runner_unavailable",
            "ffmpeg not found (/nonexistent/ffmpeg); set PIRC_FFMPEG"
        )
    );
    assert!(root.path().join(".pirc/recordings").is_dir());
    let error = manager
        .handle(target.clone(), "record".into(), json!({ "action": "stop" }))
        .await
        .unwrap_err();
    assert_eq!((error.status, &*error.message), (409, "Not recording"));
    let error = manager
        .handle(target, "record".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, &*error.message),
        (400, "action is start or stop")
    );
    manager.shutdown().await;
}
