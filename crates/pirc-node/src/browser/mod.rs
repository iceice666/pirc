//! The agent browser (`node/browser.ts`): [`BrowserService`] is what the
//! rest of the node calls, [`manager::BrowserManager`] implements it over
//! [`engine`], a port of the parts of Playwright the TS node used, speaking
//! CDP to an external Chromium. [`UnavailableBrowser`] stays for tests.
//!
//! The runner calls [`BrowserService::handle_with_abort`] for
//! `browser_request`s (`browser_cancel` aborts it: as in TS, that only
//! abandons waits; an operation already running finishes, and the request
//! keeps its in-flight slot until then); streams call
//! [`BrowserService::attach`] and [`BrowserService::input`]; core calls
//! `close_session` on chat deletion and `shutdown` on close.
//!
//! | Module | Port of | Owner (M8 layout) |
//! |---|---|---|
//! | this file, [`assets`] | the seam; the embedded in-page scripts | layout |
//! | [`engine`] | Playwright (see its table) | core, netio, locator |
//! | [`hosts`] | `node/browser-hosts.ts` | netio |
//! | [`manager`], [`recording`], [`util`] | `node/browser.ts` | manager |

pub mod assets;
pub mod engine;
pub mod hosts;
pub mod manager;
pub mod recording;
pub mod util;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::error::{ApiError, ApiResult};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Where a request comes from: the session its agent or viewer belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserTarget {
    pub session_id: String,
    pub workspace_id: String,
    /// `chat::session_root` of the session (recordings go under it).
    pub root: PathBuf,
}

/// Where a stream's frames go (`terminal_frame` on the link).
pub type FrameSink = Arc<dyn Fn(Value) + Send + Sync>;
/// Stops a viewer's frames.
pub type Detach = Box<dyn FnOnce() + Send>;

pub trait BrowserService: Send + Sync {
    /// Whether agents get a browser (`PIRC_BROWSER` and an executable).
    fn enabled(&self) -> bool;

    /// An agent's `browser_request` (`op` already checked against
    /// `^[a-z_]{1,40}$`, `args` against the size limit): its result, or the
    /// error the agent gets.
    fn handle(
        &self,
        target: BrowserTarget,
        op: String,
        args: Value,
    ) -> BoxFuture<'_, ApiResult<Value>>;

    /// [`BrowserService::handle`] with TS's `AbortSignal`: `abort` turning
    /// true (or closing) is `controller.abort()` (`browser_cancel`), and
    /// the future still resolves only once the operation has settled, as
    /// TS's `handle` promise did, so the runner can hold the request's
    /// in-flight slot until then. Dropping the future also aborts.
    fn handle_with_abort(
        &self,
        target: BrowserTarget,
        op: String,
        args: Value,
        mut abort: tokio::sync::watch::Receiver<bool>,
    ) -> BoxFuture<'_, ApiResult<Value>> {
        let handle = self.handle(target, op, args);
        Box::pin(async move {
            tokio::select! {
                result = handle => result,
                () = async { let _ = abort.wait_for(|aborted| *aborted).await; } => {
                    Err(ApiError::new(499, "aborted", "Aborted"))
                }
            }
        })
    }

    /// A viewer of the session's browser: frames go to `send` until the
    /// returned function runs. Called only when [`BrowserService::enabled`].
    fn attach(&self, session_id: &str, send: FrameSink) -> Detach;

    /// A viewer's message (lease already checked, except `log_image`): a
    /// frame to send back, if any.
    fn input(
        &self,
        target: BrowserTarget,
        message: Value,
    ) -> BoxFuture<'_, ApiResult<Option<Value>>>;

    /// Close a deleted session's tabs.
    fn close_session(&self, session_id: &str) -> BoxFuture<'_, ()>;

    /// Node shutdown.
    fn shutdown(&self) -> BoxFuture<'_, ()>;
}

/// The answer to everything a node without a browser is asked.
pub fn unavailable() -> ApiError {
    ApiError::forbidden("The browser is not available on this node")
}

/// A browser that is never available (tests; the M6 node's).
#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableBrowser;

impl BrowserService for UnavailableBrowser {
    fn enabled(&self) -> bool {
        false
    }

    fn handle(&self, _: BrowserTarget, _: String, _: Value) -> BoxFuture<'_, ApiResult<Value>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn attach(&self, _: &str, _: FrameSink) -> Detach {
        Box::new(|| {})
    }

    fn input(&self, _: BrowserTarget, _: Value) -> BoxFuture<'_, ApiResult<Option<Value>>> {
        Box::pin(async { Err(unavailable()) })
    }

    fn close_session(&self, _: &str) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn answers_unavailable() {
        let browser: Arc<dyn BrowserService> = Arc::new(UnavailableBrowser);
        assert!(!browser.enabled());
        let target = BrowserTarget {
            session_id: "s".into(),
            workspace_id: "w".into(),
            root: PathBuf::from("/w"),
        };
        let error = browser
            .handle(target.clone(), "open".into(), Value::Null)
            .await
            .unwrap_err();
        assert_eq!(
            error.body(),
            serde_json::json!({ "error": { "code": "forbidden",
                "message": "The browser is not available on this node" } })
        );
        assert_eq!(error.status, 403);
        assert!(browser.input(target, Value::Null).await.is_err());
        browser.attach("s", Arc::new(|_| {}))();
        browser.close_session("s").await;
        browser.shutdown().await;
    }
}
