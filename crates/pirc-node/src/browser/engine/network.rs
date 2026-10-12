//! The host guard on every request and WebSocket of the context, as
//! `node/browser.ts` set it up with Playwright: `context.route('**/*')`
//! (the `Fetch` domain: a blocked request fails with `BlockedByClient`, the
//! rest continue; `Network.setCacheDisabled` as Playwright does while
//! routing), `context.routeWebSocket` (Playwright's main-world WebSocket
//! mock, `assets/websocket-mock.js`: a blocked socket is closed with 1008
//! "blocked by pirc", an allowed one connects), and
//! `serviceWorkers: 'block'`.
//!
//! [`install`] is called by [`super::context`] for every attached target
//! before it is let run (`Runtime.runIfWaitingForDebugger`).
//!
//! Owner: netio.

use std::sync::Arc;

use super::Result;
use super::cdp::Session;
use crate::browser::hosts::HostGuard;

/// What kind of target a session is (`targetInfo.type`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Page,
    /// An out-of-process iframe.
    Iframe,
    Worker,
    ServiceWorker,
}

/// The guard's state for one target session; dropping it stops handling
/// the session's events.
pub struct Installed {
    _todo: (),
}

/// Guard `session` (a target of `kind`) with `guard`.
pub async fn install(
    _session: &Session,
    _kind: TargetKind,
    _guard: Arc<HostGuard>,
) -> Result<Installed> {
    todo!("netio")
}
