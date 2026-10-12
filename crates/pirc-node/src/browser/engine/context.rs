//! One Chromium with its persistent profile: Playwright's persistent
//! `BrowserContext` (`crBrowser.ts`). It auto-attaches every target
//! (`Target.setAutoAttach {autoAttach, waitForDebuggerOnStart, flatten}`),
//! initializes each page (and its out-of-process iframes and workers) before
//! letting it run, installs the host guard on each, and turns pages opened
//! by a page into that page's popups.
//!
//! As `launchPersistentContext({acceptDownloads: false})`: downloads are
//! denied (`Browser.setDownloadBehavior`), dialogs are closed as Playwright
//! closes them when nobody handles them (see [`super::page`]), and closing
//! is `Browser.close` then waiting for the process. Unlike Playwright, which
//! waits for the process indefinitely, the process group is killed if it
//! has not exited [`CLOSE_GRACE`] after `Browser.close`.
//!
//! Ported from playwright-core 1.63.0 `src/server/chromium/crBrowser.ts`,
//! `src/server/browserContext.ts` (Apache-2.0, see
//! `crates/pirc-node/NOTICE`).

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch};

use super::cdp::{CdpError, Connection, Event, Session};
use super::launch;
use super::network::{Replies, TargetKind};
use super::page::{Page, PageEvent, PageSetup};
use super::{Error, Result};
use crate::browser::BoxFuture;
use crate::browser::hosts::HostGuard;

/// How long [`Context::close`] lets Chromium exit before killing it.
pub const CLOSE_GRACE: Duration = Duration::from_secs(10);

/// The API name of launch errors.
const LAUNCH: &str = "launchPersistentContext";

/// Playwright's default launch timeout.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(180);

/// How the context is launched (`launchPersistentContext` options as
/// `node/browser.ts` passes them).
#[derive(Clone, Debug)]
pub struct LaunchOptions {
    pub viewport: (u32, u32),
    /// `env: withoutSecrets(process.env)`.
    pub env: BTreeMap<String, String>,
}

/// What the guard keeps for a target while it lives
/// ([`super::network::Installed`]).
pub(super) type Installed = Box<dyn Any + Send>;

/// Guards a target before it runs: resolves once the target may run (see
/// [`super::network::install_split`]), with the replies still to come.
pub(super) type Installer = Arc<
    dyn Fn(Session, TargetKind) -> BoxFuture<'static, Result<(Option<Installed>, Replies)>>
        + Send
        + Sync,
>;

/// A persistent browser context.
pub struct Context {
    shared: Arc<Shared>,
    /// Dropping it (with the context) kills the browser.
    kill: Mutex<Option<oneshot::Sender<()>>>,
    pid: Option<u32>,
}

struct Shared {
    connection: Arc<Connection>,
    browser: Session,
    installer: Installer,
    viewport: (u32, u32),
    mac: OnceLock<bool>,
    state: Mutex<State>,
    changed: watch::Sender<u64>,
    events: mpsc::UnboundedSender<Event>,
    exited: watch::Receiver<bool>,
}

#[derive(Default)]
struct State {
    /// Every page target, in the order it attached (initialized or not).
    pages: Vec<Arc<Page>>,
    service_workers: HashMap<String, Option<Installed>>,
    /// The attachments of the targets that existed at launch are known.
    attached: bool,
    closed: bool,
}

impl Shared {
    fn bump(&self) {
        self.changed.send_modify(|generation| *generation += 1);
    }

    async fn wait<T>(&self, mut check: impl FnMut(&State) -> Option<T>) -> T {
        let mut changed = self.changed.subscribe();
        loop {
            if let Some(value) = check(&self.state.lock().unwrap()) {
                return value;
            }
            if changed.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Context {
    /// Start Chromium on `profile_dir` (created by the caller) and wait for
    /// its initial page. Every page, frame and worker it ever has goes
    /// through `guard` (`acceptDownloads: false`, `serviceWorkers: 'block'`).
    /// The error is the reason ("Could not start the browser: <reason>").
    pub async fn launch(
        executable: &Path,
        profile_dir: &Path,
        options: LaunchOptions,
        guard: Arc<HostGuard>,
    ) -> std::result::Result<Arc<Self>, String> {
        let installer: Installer = Arc::new(move |session: Session, kind| {
            let guard = guard.clone();
            Box::pin(async move {
                let (installed, replies) =
                    super::network::install_split(&session, kind, guard).await?;
                Ok((Some(Box::new(installed) as Installed), replies))
            })
        });
        Self::launch_with(executable, profile_dir, options, installer).await
    }

    /// [`Context::launch`] WITHOUT the host guard: every target runs
    /// unguarded. For the engine's own tests only.
    #[doc(hidden)]
    pub async fn launch_unguarded(
        executable: &Path,
        profile_dir: &Path,
        options: LaunchOptions,
    ) -> std::result::Result<Arc<Self>, String> {
        let installer: Installer =
            Arc::new(|_, _| Box::pin(async { Ok((None, Box::pin(async { Ok(()) }) as Replies)) }));
        Self::launch_with(executable, profile_dir, options, installer).await
    }

    async fn launch_with(
        executable: &Path,
        profile_dir: &Path,
        options: LaunchOptions,
        installer: Installer,
    ) -> std::result::Result<Arc<Self>, String> {
        let launch::Launched { child, connection } =
            launch::launch(executable, profile_dir, &options.env)
                .map_err(|reason| Error::api(LAUNCH, reason).message)?;
        let pid = child.id();
        let (kill, exited) = watch_process(child);
        let browser = connection.browser();
        let (events, rx) = mpsc::unbounded_channel();
        browser.listen_into(events.clone());
        let (changed, _) = watch::channel(0);
        let shared = Arc::new(Shared {
            connection: connection.clone(),
            browser: browser.clone(),
            installer,
            viewport: options.viewport,
            mac: OnceLock::new(),
            state: Mutex::default(),
            changed,
            events,
            exited,
        });
        tokio::spawn(run(shared.clone(), rx));
        let context = Arc::new(Self {
            shared,
            kill: Mutex::new(Some(kill)),
            pid,
        });
        match tokio::time::timeout(LAUNCH_TIMEOUT, context.start()).await {
            Ok(Ok(())) => Ok(context),
            Ok(Err(reason)) => {
                context.close().await;
                Err(Error::api(LAUNCH, reason).message)
            }
            Err(_) => {
                context.close().await;
                Err(Error::timeout(LAUNCH, LAUNCH_TIMEOUT).message)
            }
        }
    }

    /// `CRBrowser.connect` for a persistent context, then
    /// `loadDefaultContextAsIs`.
    async fn start(&self) -> std::result::Result<(), String> {
        let shared = &self.shared;
        let browser = &shared.browser;
        let reason = |error: CdpError| error.message;
        let version = browser
            .call("Browser.getVersion", json!({}))
            .await
            .map_err(reason)?;
        let mac = version["userAgent"]
            .as_str()
            .is_some_and(|agent| agent.contains("Macintosh"));
        let _ = shared.mac.set(mac);
        let attach = async {
            browser
                .call(
                    "Target.setAutoAttach",
                    json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
                )
                .await?;
            browser
                .call_echo(
                    "Target.getTargetInfo",
                    json!({}),
                    &shared.events,
                    "pirc.echo",
                    json!({ "kind": "attached" }),
                )
                .await
        };
        let downloads = browser.call(
            "Browser.setDownloadBehavior",
            json!({ "behavior": "deny", "eventsEnabled": true }),
        );
        let (attached, downloads) = tokio::join!(attach, downloads);
        attached.map_err(reason)?;
        downloads.map_err(reason)?;
        // `_waitForAllPagesToBeInitialized`.
        let pages = shared
            .wait(|state| (state.attached || state.closed).then(|| state.pages.clone()))
            .await;
        for page in &pages {
            page.shared
                .wait(|state| state.initialized.clone())
                .await
                .ok();
        }
        // `loadDefaultContextAsIs`.
        let first = shared
            .wait(|state| {
                if state.closed {
                    Some(None)
                } else {
                    state.pages.first().cloned().map(Some)
                }
            })
            .await
            .ok_or_else(|| CdpError::closed().message)?;
        first.shared.wait(|state| state.initialized.clone()).await?;
        first
            .main_frame()
            .wait_lifecycle("", super::LoadState::Load)
            .await
            .map_err(|error| error.message)
    }

    /// The open pages, oldest first (`context.pages()`: initialized ones).
    pub fn pages(&self) -> Vec<Arc<Page>> {
        let state = self.shared.state.lock().unwrap();
        state
            .pages
            .iter()
            .filter(|page| page.initialized() == Some(Ok(())) && !page.is_closed())
            .cloned()
            .collect()
    }

    /// A new page (`context.newPage()`), initialized:
    /// `Target.createTarget {url: 'about:blank'}` in the default context.
    pub async fn new_page(&self) -> Result<Arc<Page>> {
        let api = "newPage";
        let shared = &self.shared;
        let reply = shared
            .browser
            .call("Target.createTarget", json!({ "url": "about:blank" }))
            .await
            .map_err(|e| super::page::protocol_error(api, "Target.createTarget", e))?;
        let target = reply["targetId"].as_str().unwrap_or_default().to_owned();
        let page = shared
            .wait(|state| {
                if let Some(page) = state.pages.iter().find(|page| page.target_id() == target) {
                    return Some(Some(page.clone()));
                }
                state.closed.then_some(None)
            })
            .await
            .ok_or_else(|| super::page::closed_error(api))?;
        let initialized = page.shared.wait(|state| state.initialized.clone()).await;
        match initialized {
            Ok(()) if page.is_closed() => Err(Error::api(api, "Page has been closed.")),
            Ok(()) => Ok(page),
            Err(error) => {
                let _ = page.close().await;
                Err(Error::api(api, error))
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.shared.state.lock().unwrap().closed
    }

    /// Resolves when the context is gone, closed by us or not (the
    /// `close` event).
    pub async fn closed(&self) {
        self.shared.wait(|state| state.closed.then_some(())).await;
    }

    /// Close every page and the browser (`context.close()`):
    /// `Browser.close`, then the process is waited for ([`CLOSE_GRACE`],
    /// then killed with its process group).
    pub async fn close(&self) {
        let browser = self.shared.browser.clone();
        if !self.shared.connection.is_closed() {
            tokio::spawn(async move {
                let _ = browser.call("Browser.close", json!({})).await;
            });
        }
        let mut exited = self.shared.exited.clone();
        let graceful = tokio::time::timeout(CLOSE_GRACE, exited.wait_for(|exited| *exited))
            .await
            .is_ok();
        if !graceful && let Some(kill) = self.kill.lock().unwrap().take() {
            let _ = kill.send(());
        }
        let _ = exited.wait_for(|exited| *exited).await;
        self.shared.connection.wait_closed().await;
        self.closed().await;
    }

    /// The browser's process id (its process group's too).
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        if let Some(kill) = self.kill.lock().unwrap().take() {
            let _ = kill.send(());
        }
    }
}

/// Own the browser process: reap it when it exits; kill its process group
/// when asked (or when the sender is dropped). Once the browser exited, what
/// is left of its group (helpers still shutting down) is killed too, so
/// nothing outlives the context and holds the profile.
fn watch_process(mut child: Child) -> (oneshot::Sender<()>, watch::Receiver<bool>) {
    let (kill, killed) = oneshot::channel::<()>();
    let (exit_tx, exited) = watch::channel(false);
    tokio::spawn(async move {
        let group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .map(nix::unistd::Pid::from_raw);
        let kill_group = || {
            if let Some(group) = group {
                let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL);
            }
        };
        tokio::select! {
            _ = child.wait() => {}
            _ = killed => {
                kill_group();
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        // The group's id stays reserved while any member lives, so this
        // reaches only the browser's leftovers.
        kill_group();
        let _ = exit_tx.send(true);
    });
    (kill, exited)
}

/// The context's event loop (`CRBrowser`'s browser-session listeners).
async fn run(shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<Event>) {
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Some(event) => handle(&shared, event),
                None => break,
            },
            () = shared.connection.wait_closed() => break,
        }
    }
    // `_didDisconnect`.
    let pages = {
        let mut state = shared.state.lock().unwrap();
        state.closed = true;
        state.service_workers.clear();
        std::mem::take(&mut state.pages)
    };
    for page in pages {
        page.did_close();
    }
    shared.bump();
}

fn handle(shared: &Arc<Shared>, event: Event) {
    let params = &event.params;
    match event.method.as_str() {
        "pirc.echo" => {
            if params["tag"]["kind"] == "attached" {
                shared.state.lock().unwrap().attached = true;
            }
        }
        "Target.attachedToTarget" => attached(shared, params),
        "Target.detachedFromTarget" => {
            let target = params["targetId"].as_str().unwrap_or_default();
            let mut state = shared.state.lock().unwrap();
            if let Some(index) = state
                .pages
                .iter()
                .position(|page| page.target_id() == target)
            {
                let page = state.pages.remove(index);
                drop(state);
                page.did_close();
            } else {
                state.service_workers.remove(target);
            }
        }
        _ => {}
    }
    shared.bump();
}

/// `CRBrowser._onAttachedToTarget`.
fn attached(shared: &Arc<Shared>, params: &Value) {
    let info = &params["targetInfo"];
    let Some(session_id) = params["sessionId"].as_str() else {
        return;
    };
    let session = shared.connection.session(session_id);
    let target = info["targetId"].as_str().unwrap_or_default().to_owned();
    match info["type"].as_str() {
        Some("browser") => {}
        Some("page") => {
            let opener = info["openerId"].as_str().and_then(|opener| {
                let state = shared.state.lock().unwrap();
                state
                    .pages
                    .iter()
                    .find(|page| page.target_id() == opener)
                    .cloned()
            });
            let page = Page::attach(PageSetup {
                target_id: target,
                session,
                browser: shared.browser.clone(),
                installer: shared.installer.clone(),
                viewport: shared.viewport,
                mac: shared.mac.get().copied().unwrap_or(false),
                opener: opener.clone(),
            });
            shared.state.lock().unwrap().pages.push(page.clone());
            // `reportAsNew`: a popup is reported to its opener once both
            // are initialized.
            let shared = shared.clone();
            tokio::spawn(async move {
                let initialized = page.shared.wait(|state| state.initialized.clone()).await;
                if let Some(opener) = opener {
                    let opener_ok = opener.shared.wait(|state| state.initialized.clone()).await;
                    if initialized.is_ok() && opener_ok.is_ok() && !opener.is_closed() {
                        opener.emit(PageEvent::Popup(page.clone()));
                    }
                }
                shared.bump();
            });
        }
        // Playwright detaches shared workers, which lets them run with no
        // request interception; they are guarded as service workers are
        // (a deviation for the host guard).
        Some("service_worker" | "shared_worker") => {
            shared
                .state
                .lock()
                .unwrap()
                .service_workers
                .insert(target.clone(), None);
            let shared = shared.clone();
            tokio::spawn(async move {
                let _ = session.call("Runtime.enable", json!({})).await;
                let Ok((installed, replies)) =
                    (shared.installer)(session.clone(), TargetKind::ServiceWorker).await
                else {
                    // Unguarded: it stays paused.
                    return;
                };
                if replies.await.is_err() {
                    return;
                }
                if let Some(slot) = shared
                    .state
                    .lock()
                    .unwrap()
                    .service_workers
                    .get_mut(&target)
                {
                    *slot = installed;
                }
                let _ = session
                    .call("Runtime.runIfWaitingForDebugger", json!({}))
                    .await;
            });
        }
        _ => {
            let browser = shared.browser.clone();
            let session_id = session_id.to_owned();
            tokio::spawn(async move {
                let _ = session
                    .call("Runtime.runIfWaitingForDebugger", json!({}))
                    .await;
                let _ = browser
                    .call(
                        "Target.detachFromTarget",
                        json!({ "sessionId": session_id }),
                    )
                    .await;
            });
        }
    }
}
