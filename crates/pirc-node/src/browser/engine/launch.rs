//! Starting Chromium as Playwright 1.63.0's `launchPersistentContext` does
//! for `node/browser.ts` (headless, the workspace's profile, its default
//! switches; see the M8 scout report), with the CDP pipe on fds 3 and 4.
//!
//! Ported from playwright-core 1.63.0 `src/server/chromium/chromium.ts`,
//! `src/server/chromium/chromiumSwitches.ts`, `src/server/browserType.ts`
//! (Apache-2.0, see `crates/pirc-node/NOTICE`).

use std::collections::BTreeMap;
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use command_fds::{CommandFdExt as _, FdMapping};
use tokio::net::unix::pipe;
use tokio::process::{Child, Command};

use super::cdp::Connection;

/// Playwright's `chromiumSwitches` for headless Chromium (1.63.0,
/// `coreBundle.js`), in its order, then its `launchPersistentContext`
/// additions. `--remote-debugging-pipe`, `--user-data-dir` and the initial
/// `about:blank` are added by [`launch`].
pub const SWITCHES: &[&str] = &[
    "--disable-field-trial-config",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-back-forward-cache",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-edgeupdater",
    "--disable-extensions",
    "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
    "--enable-features=CDPScreenshotNewSurface",
    "--allow-pre-commit-input",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-updater-scheduler",
    "--force-color-profile=srgb",
    "--metrics-recording-only",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-service-autorun",
    "--export-tagged-pdf",
    "--disable-search-engine-choice-screen",
    "--unsafely-disable-devtools-self-xss-warnings",
    "--edge-skip-compat-layer-relaunch",
    "--disable-infobars",
    "--disable-search-engine-choice-screen",
    "--disable-sync",
    "--enable-unsafe-swiftshader",
    "--headless",
    "--hide-scrollbars",
    "--mute-audio",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    "--no-sandbox",
];

/// A running Chromium and its CDP connection.
pub struct Launched {
    pub child: Child,
    pub connection: Arc<Connection>,
}

/// Start `executable` on `profile_dir` (created by the caller) with `env` as
/// its whole environment (`withoutSecrets`). The error is the reason, for
/// "Could not start the browser: …".
pub fn launch(
    executable: &Path,
    profile_dir: &Path,
    env: &BTreeMap<String, String>,
) -> Result<Launched, String> {
    let (command_read, command_write) = std::io::pipe().map_err(|e| e.to_string())?;
    let (reply_read, reply_write) = std::io::pipe().map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(executable);
    command
        .args(SWITCHES)
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--remote-debugging-pipe")
        .arg("about:blank")
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group, killed as a whole (Playwright spawns it
        // `detached` and kills `-pid`).
        .process_group(0);
    command
        .fd_mappings(vec![
            FdMapping {
                parent_fd: OwnedFd::from(command_read),
                child_fd: 3,
            },
            FdMapping {
                parent_fd: OwnedFd::from(reply_write),
                child_fd: 4,
            },
        ])
        .map_err(|e| e.to_string())?;
    let mut command = Command::from(command);
    command.kill_on_drop(true);
    let child = command.spawn().map_err(|e| e.to_string())?;
    // The child's ends were moved into the mappings and are closed here
    // with `command` (only the child keeps them).
    drop(command);
    let sender =
        pipe::Sender::from_owned_fd(OwnedFd::from(command_write)).map_err(|e| e.to_string())?;
    let receiver =
        pipe::Receiver::from_owned_fd(OwnedFd::from(reply_read)).map_err(|e| e.to_string())?;
    Ok(Launched {
        child,
        connection: Connection::new(sender, receiver),
    })
}
