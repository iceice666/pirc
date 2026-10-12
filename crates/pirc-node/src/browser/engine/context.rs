//! One Chromium with its persistent profile: Playwright's persistent
//! `BrowserContext` (`crBrowser.ts`). It auto-attaches every target
//! (`Target.setAutoAttach {autoAttach, waitForDebuggerOnStart, flatten}`),
//! initializes each page (and its out-of-process iframes and workers) before
//! letting it run, installs the host guard on each, and turns pages opened
//! by a page into that page's popups.
//!
//! Owner: core.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use super::Result;
use super::page::Page;
use crate::browser::hosts::HostGuard;

/// How the context is launched (`launchPersistentContext` options as
/// `node/browser.ts` passes them).
#[derive(Clone, Debug)]
pub struct LaunchOptions {
    pub viewport: (u32, u32),
    /// `env: withoutSecrets(process.env)`.
    pub env: BTreeMap<String, String>,
}

/// A persistent browser context.
pub struct Context {
    _todo: (),
}

impl Context {
    /// Start Chromium on `profile_dir` (created by the caller) and wait for
    /// its initial page. Every page, frame and worker it ever has goes
    /// through `guard` (`acceptDownloads: false`, `serviceWorkers: 'block'`).
    /// The error is the reason ("Could not start the browser: <reason>").
    pub async fn launch(
        _executable: &Path,
        _profile_dir: &Path,
        _options: LaunchOptions,
        _guard: Arc<HostGuard>,
    ) -> std::result::Result<Arc<Self>, String> {
        todo!("core")
    }

    /// The open pages, oldest first (`context.pages()`).
    pub fn pages(&self) -> Vec<Arc<Page>> {
        todo!("core")
    }

    /// A new page (`context.newPage()`), initialized.
    pub async fn new_page(&self) -> Result<Arc<Page>> {
        todo!("core")
    }

    pub fn is_closed(&self) -> bool {
        todo!("core")
    }

    /// Resolves when the context is gone, closed by us or not (the
    /// `close` event).
    pub async fn closed(&self) {
        todo!("core")
    }

    /// Close every page and the browser (`context.close()`); the process is
    /// waited for.
    pub async fn close(&self) {
        todo!("core")
    }
}
