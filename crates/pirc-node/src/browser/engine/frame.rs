//! A frame of a page: Playwright's `Frame` with its execution contexts. Each
//! frame has its main world and a utility world
//! (`Page.createIsolatedWorld`, `grantUniveralAccess`) where Playwright's
//! injected script lives, created lazily once per document with the
//! Chromium options from `FrameExecutionContext` (`frameSeq` = the frame's
//! sequence number, `isUtilityWorld: true`, `stableRafCount: 1`,
//! `shouldPrependErrorPrefix: false`). Sequence numbers are per page and
//! advance as Playwright's `FrameManager` advances them.
//!
//! Owner: core.

use serde_json::Value;

use super::Result;
use super::cdp::Session;

/// A remote object in one execution context (`JSHandle`), released on
/// [`JsHandle::release`] (or when its document goes away).
#[derive(Clone, Debug)]
pub struct JsHandle {
    pub session: Session,
    pub object_id: String,
}

impl JsHandle {
    /// `Runtime.callFunctionOn` with `this` = the handle and `args` (JSON
    /// values or handles of the same context), `awaitPromise`,
    /// `userGesture`, by value. Exceptions become [`super::Error`]s with
    /// the thrown message.
    pub async fn call(&self, _function: &str, _args: Vec<Arg>) -> Result<Value> {
        todo!("core")
    }

    /// The same, returning a handle (for elements).
    pub async fn call_handle(&self, _function: &str, _args: Vec<Arg>) -> Result<Option<JsHandle>> {
        todo!("core")
    }

    pub async fn release(self) {
        todo!("core")
    }
}

/// An argument to [`JsHandle::call`].
#[derive(Clone, Debug)]
pub enum Arg {
    Value(Value),
    Handle(JsHandle),
}

/// A handle to a frame (cheap to clone); stale once the frame detaches.
#[derive(Clone)]
pub struct Frame {
    _todo: (),
}

impl Frame {
    /// The CDP frame id.
    pub fn id(&self) -> &str {
        todo!("core")
    }

    /// Playwright's per-page sequence number (0 for the first main frame).
    pub fn seq(&self) -> u64 {
        todo!("core")
    }

    pub fn url(&self) -> String {
        todo!("core")
    }

    pub fn is_main(&self) -> bool {
        todo!("core")
    }

    pub fn is_detached(&self) -> bool {
        todo!("core")
    }

    pub fn parent(&self) -> Option<Frame> {
        todo!("core")
    }

    /// The session that owns the frame's documents (its own for an
    /// out-of-process iframe).
    pub fn session(&self) -> Session {
        todo!("core")
    }

    /// `frame.evaluate(fn, arg)` in the main world: `function` is a JS
    /// function's source, called with `arg`; the result by value.
    pub async fn evaluate(&self, _function: &str, _arg: Value) -> Result<Value> {
        todo!("core")
    }

    /// The injected script of the frame's current document, in its utility
    /// world (created on first use per document).
    pub async fn injected(&self) -> Result<JsHandle> {
        todo!("core")
    }

    /// Adopt `handle` (an element from another world or this frame's main
    /// world) into the utility world, or the reverse: `DOM.describeNode` +
    /// `DOM.resolveNode`.
    pub async fn adopt(&self, _handle: &JsHandle, _utility: bool) -> Result<JsHandle> {
        todo!("core")
    }

    /// The `<iframe>` element that holds this frame, as a handle in its
    /// parent's utility world (`DOM.getFrameOwner`); `None` for the main
    /// frame.
    pub async fn owner(&self) -> Result<Option<JsHandle>> {
        todo!("core")
    }

    /// Resolve once `state` has fired for the current document.
    pub async fn wait_for_load_state(
        &self,
        _state: super::LoadState,
        _timeout: std::time::Duration,
    ) -> Result<()> {
        todo!("core")
    }
}
