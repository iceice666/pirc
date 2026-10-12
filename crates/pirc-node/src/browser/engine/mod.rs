//! The browser engine: what `node/browser.ts` got from Playwright 1.63.0,
//! over raw CDP. It is a port of the parts of Playwright's server the TS
//! node uses (see the M8 scout reports and `plans/rust-rewrite.md`, M8), not
//! a general automation library: one persistent context per Chromium,
//! pages with their frame trees (out-of-process iframes included), the
//! injected script in a utility world per frame, `aria-ref` and text
//! locators with Playwright's actionability checks, keyboard and mouse,
//! screenshots, the screencast, and the host guard on every request and
//! WebSocket.
//!
//! Errors carry Playwright's message text ([`Error`]), because the agent
//! reads it (`cleanError` in the manager keeps its first lines), prefixed
//! as the production TS node shows it (see [`Error::api`]).
//!
//! | Module | Port of | Owner |
//! |---|---|---|
//! | [`cdp`], [`launch`] | Playwright's pipe transport, `launchPersistentContext` | layout |
//! | [`context`], [`page`], [`frame`] | `crBrowser`, `crPage`, `frames`, `page`, lifecycle and `networkidle` | core |
//! | [`network`] | `crNetworkManager` routing, `routeWebSocket`, `serviceWorkers: 'block'` | netio |
//! | [`input`], [`keyboard_layout`] | `input.ts`, `usKeyboardLayout.ts`, `crInput`, `crDragDrop` | netio |
//! | [`screenshot`], [`screencast`] | `screenshotter`, `crPage` screencast | netio |
//! | [`snapshot`], [`locator`] | `ariaSnapshotJSONForFrame`, `aria-ref` routing, `dom.ts` actions | locator |

pub mod cdp;
pub mod context;
pub mod frame;
pub mod input;
pub mod keyboard_layout;
pub mod launch;
pub mod locator;
pub mod network;
pub mod page;
pub mod screencast;
pub mod screenshot;
pub mod snapshot;

use std::time::Duration;

pub use cdp::CdpError;

/// A failed engine operation, with the message Playwright would have
/// thrown for it (e.g. `click: Timeout 10000ms exceeded.`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub message: String,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The error of Playwright API call `api` failing with `message`:
    /// `<api>: <message>`. Playwright's client prefixes the API name it
    /// finds in the JS stack; the production TS node (Bun, with
    /// playwright-core on disk) finds the bare client method name, so `api`
    /// is that name (`goto`, `goBack`, `evaluate`, `waitForLoadState`,
    /// `click`, `fill`, `waitFor`…). A `page.`/`locator.`-style qualifier
    /// is dropped; an empty `api` (an internal step, prefixed by the API
    /// call it is part of) leaves `message` as it is. Every engine error
    /// goes through here.
    pub fn api(api: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        match api.rsplit('.').next().unwrap_or_default() {
            "" => Self::new(message),
            name => Self::new(format!("{name}: {message}")),
        }
    }

    /// Playwright's timeout text for `api` (e.g. `click`):
    /// `click: Timeout 10000ms exceeded.` (see [`Error::api`]).
    pub fn timeout(api: &str, timeout: Duration) -> Self {
        Self::api(api, format!("Timeout {}ms exceeded.", timeout.as_millis()))
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<CdpError> for Error {
    fn from(error: CdpError) -> Self {
        Self::new(error.message)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Playwright's load states (`waitUntil`, `waitForLoadState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LoadState {
    Commit,
    DomContentLoaded,
    Load,
    /// Playwright's own: 500 ms without requests in the frame's subtree.
    NetworkIdle,
}

/// Mouse buttons (`button` in Playwright's options).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

impl MouseButton {
    /// `right` and `middle`; anything else is left (as `browser.ts` maps it).
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("right") => Self::Right,
            Some("middle") => Self::Middle,
            _ => Self::Left,
        }
    }
}
