//! Which hosts the agent's browser may reach: a port of
//! `node/browser-hosts.ts` (its tests in `browser-hosts.test.ts`). Public
//! internet hosts only, unless the node operator allows private ones
//! (`PIRC_BROWSER_ALLOW_PRIVATE`); never the gateway itself unless named
//! explicitly; `PIRC_BROWSER_BLOCK_HOSTS` always. Names are resolved with
//! the system resolver (every address must pass), results cached 30 s.
//!
//! Owner: netio.

use std::net::IpAddr;
use std::sync::Arc;

use pirc_config::node::BrowserSettings;

use super::BoxFuture;
use crate::error::ApiError;

/// Resolves a host name to all its addresses (`dns.lookup(host, {all:
/// true, verbatim: true})`); the error is the resolver's message.
pub type Resolver =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Vec<IpAddr>, String>> + Send + Sync>;

pub struct HostGuard {
    _todo: (),
}

impl HostGuard {
    pub fn new(_settings: &BrowserSettings) -> Self {
        todo!("netio")
    }

    /// With another resolver (tests).
    pub fn with_resolver(_settings: &BrowserSettings, _resolver: Resolver) -> Self {
        todo!("netio")
    }

    /// Why `url` may not be opened, or `None` when it may.
    pub async fn blocked_reason(&self, _url: &str) -> Option<String> {
        todo!("netio")
    }
}

/// `blockedError(url, reason)`: 403 `forbidden`, "The browser may not open
/// <url>: <reason>. Agent browsing is limited to …".
pub fn blocked_error(_url: &str, _reason: &str) -> ApiError {
    todo!("netio")
}
