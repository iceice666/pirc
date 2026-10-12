//! A frame of a page: Playwright's `Frame` with its execution contexts. Each
//! frame has its main world and a utility world
//! (`Page.createIsolatedWorld`, `grantUniveralAccess`) where Playwright's
//! injected script lives, created lazily once per document with the
//! Chromium options from `FrameExecutionContext` (`frameSeq` = the frame's
//! sequence number, `isUtilityWorld: true`, `stableRafCount: 1`,
//! `shouldPrependErrorPrefix: false`). Sequence numbers are per page and
//! advance as Playwright's `FrameManager` advances them.
//!
//! Evaluation runs the function itself with `Runtime.callFunctionOn`
//! rather than through Playwright's `UtilityScript` (not embedded): the
//! result is the same JSON, and an exception's message is the same first
//! line, but the stack lines after it name other frames than Playwright's
//! `UtilityScript.evaluate` ones.
//!
//! Owner: core.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::OnceCell;

use super::cdp::{CdpError, Session};
use super::page::{FrameKey, Shared, closed_error, protocol_error};
use super::{Error, LoadState, Result};
use crate::browser::assets;

/// Playwright's message when a node cannot move to another context.
const UNABLE_TO_ADOPT: &str = "Unable to adopt element handle from a different document";

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
    /// the thrown message (Playwright's `getExceptionMessage`: the error's
    /// description, its stack included).
    pub async fn call(&self, function: &str, args: Vec<Arg>) -> Result<Value> {
        let reply = self.call_function(function, args, true).await?;
        Ok(reply["result"]["value"].clone())
    }

    /// The same, returning a handle (for elements); `None` for `null` and
    /// `undefined`.
    pub async fn call_handle(&self, function: &str, args: Vec<Arg>) -> Result<Option<JsHandle>> {
        let reply = self.call_function(function, args, false).await?;
        Ok(handle_of(&self.session, &reply["result"]))
    }

    async fn call_function(&self, function: &str, args: Vec<Arg>, by_value: bool) -> Result<Value> {
        let arguments: Vec<Value> = args.iter().map(Arg::to_cdp).collect();
        let reply = self
            .session
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "functionDeclaration": function,
                    "objectId": self.object_id,
                    "arguments": arguments,
                    "returnByValue": by_value,
                    "awaitPromise": true,
                    "userGesture": true,
                }),
            )
            .await;
        evaluation_reply("", reply).map_err(|error| error.error)
    }

    /// `Runtime.releaseObject` (failures ignored).
    pub async fn release(self) {
        let _ = self
            .session
            .call(
                "Runtime.releaseObject",
                json!({ "objectId": self.object_id }),
            )
            .await;
    }
}

/// An argument to [`JsHandle::call`].
#[derive(Clone, Debug)]
pub enum Arg {
    Value(Value),
    Handle(JsHandle),
}

impl Arg {
    fn to_cdp(&self) -> Value {
        match self {
            Self::Value(value) => json!({ "value": value }),
            Self::Handle(handle) => json!({ "objectId": handle.object_id }),
        }
    }
}

fn handle_of(session: &Session, object: &Value) -> Option<JsHandle> {
    if object["subtype"] == "null" || object["type"] == "undefined" {
        return None;
    }
    object["objectId"].as_str().map(|id| JsHandle {
        session: session.clone(),
        object_id: id.to_owned(),
    })
}

/// A failed evaluation: the error, and whether retrying cannot help
/// (Playwright's `isNonRetriableError`: an exception thrown by the page's
/// code, or a closed target).
pub(super) struct EvalError {
    pub(super) error: Error,
    pub(super) non_retriable: bool,
}

/// Playwright's `getExceptionMessage`.
fn exception_message(details: &Value) -> String {
    if let Some(exception) = details.get("exception") {
        if let Some(description) = exception["description"].as_str() {
            return description.to_owned();
        }
        return match &exception["value"] {
            Value::String(text) => text.clone(),
            Value::Null => exception["unserializableValue"]
                .as_str()
                .unwrap_or("undefined")
                .to_owned(),
            other => other.to_string(),
        };
    }
    let mut message = details["text"].as_str().unwrap_or_default().to_owned();
    if let Some(frames) = details["stackTrace"]["callFrames"].as_array() {
        for frame in frames {
            let name = frame["functionName"]
                .as_str()
                .filter(|name| !name.is_empty())
                .unwrap_or("<anonymous>");
            message.push_str(&format!(
                "\n    at {name} ({}:{}:{})",
                frame["url"].as_str().unwrap_or_default(),
                frame["lineNumber"],
                frame["columnNumber"]
            ));
        }
    }
    message
}

/// An evaluation's reply, with Playwright's `rewriteError` for protocol
/// errors.
fn evaluation_reply(
    api: &str,
    reply: std::result::Result<Value, CdpError>,
) -> std::result::Result<Value, EvalError> {
    match reply {
        Ok(reply) => match reply.get("exceptionDetails") {
            Some(details) => Err(EvalError {
                error: Error::api(api, exception_message(details)),
                non_retriable: true,
            }),
            None => Ok(reply),
        },
        Err(error)
            if error
                .message
                .contains("Object couldn't be returned by value") =>
        {
            Ok(json!({ "result": { "type": "undefined" } }))
        }
        Err(error) => {
            let (message, non_retriable) =
                if error.message.contains("Object reference chain is too long")
                    || error.message.contains("CBOR: stack limit exceeded")
                {
                    (
                        "Cannot serialize result: object reference chain is too long.".to_owned(),
                        false,
                    )
                } else if error.message.contains("Promise was collected") {
                    ("Resulting promise was garbage collected.".to_owned(), false)
                } else if error.is_closed() {
                    (CdpError::closed().message, true)
                } else {
                    (
                        "Execution context was destroyed, most likely because of a navigation."
                            .to_owned(),
                        false,
                    )
                };
            Err(EvalError {
                error: Error::api(api, message),
                non_retriable,
            })
        }
    }
}

/// Which world of a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum World {
    Main,
    Utility,
}

/// One execution context of a frame's document, with its injected script
/// once created.
#[derive(Clone)]
pub(super) struct ExecContext {
    pub(super) uid: u64,
    pub(super) id: i64,
    pub(super) session: Session,
    injected: Arc<OnceCell<JsHandle>>,
}

impl ExecContext {
    pub(super) fn new(uid: u64, id: i64, session: Session) -> Self {
        Self {
            uid,
            id,
            session,
            injected: Arc::default(),
        }
    }
}

/// A handle to a frame (cheap to clone); stale once the frame detaches.
#[derive(Clone)]
pub struct Frame {
    pub(super) shared: Arc<Shared>,
    pub(super) key: FrameKey,
    id: Arc<str>,
}

impl Frame {
    pub(super) fn new(shared: Arc<Shared>, key: FrameKey, id: &str) -> Self {
        Self {
            shared,
            key,
            id: Arc::from(id),
        }
    }

    /// The CDP frame id (as it was when this handle was taken: a main
    /// frame's id can change while the frame stays).
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Playwright's per-page sequence number (0 for the first main frame;
    /// the main frame takes a new one when it leaves a document other than
    /// `about:blank`).
    pub fn seq(&self) -> u64 {
        let state = self.shared.state.lock().unwrap();
        state
            .frames
            .get(&self.key)
            .map_or(u64::MAX, |frame| frame.seq)
    }

    /// The frame's URL ("" once detached).
    pub fn url(&self) -> String {
        let state = self.shared.state.lock().unwrap();
        state
            .frames
            .get(&self.key)
            .map(|frame| frame.url.clone())
            .unwrap_or_default()
    }

    pub fn is_main(&self) -> bool {
        self.shared.state.lock().unwrap().main == Some(self.key)
    }

    pub fn is_detached(&self) -> bool {
        let state = self.shared.state.lock().unwrap();
        state.closed || !state.frames.contains_key(&self.key)
    }

    pub fn parent(&self) -> Option<Frame> {
        let state = self.shared.state.lock().unwrap();
        let parent = state.frames.get(&self.key)?.parent?;
        let id = state.frames.get(&parent)?.id.clone();
        Some(Frame::new(self.shared.clone(), parent, &id))
    }

    /// The frame's child frames, in the order they attached.
    pub fn children(&self) -> Vec<Frame> {
        let state = self.shared.state.lock().unwrap();
        let keys = state.frame_keys();
        keys.into_iter()
            .filter(|key| state.frames[key].parent == Some(self.key))
            .map(|key| Frame::new(self.shared.clone(), key, &state.frames[&key].id))
            .collect()
    }

    /// The session that owns the frame's documents (its own for an
    /// out-of-process iframe; the page's once detached).
    pub fn session(&self) -> Session {
        self.owning_session()
            .unwrap_or_else(|| self.shared.session.clone())
    }

    pub(super) fn owning_session(&self) -> Option<Session> {
        self.shared.state.lock().unwrap().session_for(self.key)
    }

    /// `frame.evaluate(fn, arg)` in the main world: `function` is a JS
    /// function's source (or an expression), called with `arg`
    /// (`Value::Null` is passed as `undefined`, as an argumentless
    /// `evaluate(fn)` does), awaited; the result by value (`null` for what
    /// JSON cannot carry). Waits for the frame's document to have a main
    /// world.
    pub async fn evaluate(&self, function: &str, arg: Value) -> Result<Value> {
        self.evaluate_api("frame.evaluate", function, arg).await
    }

    pub(super) async fn evaluate_api(
        &self,
        api: &str,
        function: &str,
        arg: Value,
    ) -> Result<Value> {
        self.evaluate_in(World::Main, api, function, arg)
            .await
            .map_err(|error| error.error)
    }

    /// Evaluate `function(arg)` in `world`.
    pub(super) async fn evaluate_in(
        &self,
        world: World,
        api: &str,
        function: &str,
        arg: Value,
    ) -> std::result::Result<Value, EvalError> {
        let context = self.context(world, api).await.map_err(|error| EvalError {
            error,
            non_retriable: true,
        })?;
        let arguments = if arg.is_null() {
            json!([])
        } else {
            json!([{ "value": arg }])
        };
        let declaration = format!(
            "function (arg) {{\n  const pageFunction = (\n{function}\n);\n  return typeof pageFunction === 'function' ? pageFunction(arg) : pageFunction;\n}}"
        );
        let reply = context
            .session
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "functionDeclaration": declaration,
                    "executionContextId": context.id,
                    "arguments": arguments,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true,
                }),
            )
            .await;
        let reply = evaluation_reply(api, reply)?;
        Ok(reply["result"]["value"].clone())
    }

    /// The frame's current execution context of `world`, once there is one.
    pub(super) async fn context(&self, world: World, api: &str) -> Result<ExecContext> {
        self.shared
            .wait(|state| {
                if state.closed {
                    return Some(Err(closed_error(api)));
                }
                let Some(frame) = state.frames.get(&self.key) else {
                    return Some(Err(Error::api(api, "Frame was detached")));
                };
                frame.context(world).cloned().map(Ok)
            })
            .await
    }

    /// The injected script of the frame's current document, in its utility
    /// world (created on first use per document).
    pub async fn injected(&self) -> Result<JsHandle> {
        let context = self.context(World::Utility, "injectedScript").await?;
        let seq = self.seq();
        let handle = context
            .injected
            .get_or_try_init(|| async {
                let options = json!({
                    "isUnderTest": false,
                    "sdkLanguage": "javascript",
                    "frameSeq": seq,
                    "testIdAttributeName": "data-testid",
                    "stableRafCount": 1,
                    "browserName": "chromium",
                    "shouldPrependErrorPrefix": false,
                    "isUtilityWorld": true,
                    "customEngines": [],
                });
                let expression = format!(
                    "\n        (() => {{\n        \n        const module = {{}};\n        {}\n        return new (module.exports.InjectedScript())(globalThis, {options});\n        }})();\n      ",
                    assets::INJECTED
                );
                let reply = context
                    .session
                    .call(
                        "Runtime.evaluate",
                        json!({ "expression": expression, "contextId": context.id }),
                    )
                    .await;
                let reply = evaluation_reply("", reply).map_err(|error| error.error)?;
                handle_of(&context.session, &reply["result"]).ok_or_else(|| {
                    Error::new("Execution context was destroyed, most likely because of a navigation.")
                })
            })
            .await?;
        Ok(handle.clone())
    }

    /// Adopt `handle` (an element from another world or this frame's main
    /// world) into the utility world, or the reverse: `DOM.describeNode` +
    /// `DOM.resolveNode`.
    pub async fn adopt(&self, handle: &JsHandle, utility: bool) -> Result<JsHandle> {
        let world = if utility { World::Utility } else { World::Main };
        let node = handle
            .session
            .call("DOM.describeNode", json!({ "objectId": handle.object_id }))
            .await
            .map_err(|e| protocol_error("", "DOM.describeNode", e))?;
        let context = self.context(world, "").await?;
        resolve_node(&context, &node["node"]["backendNodeId"]).await
    }

    /// The `<iframe>` element that holds this frame, as a handle in its
    /// parent's utility world (`DOM.getFrameOwner` in the parent's
    /// session); `None` for the main frame.
    pub async fn owner(&self) -> Result<Option<JsHandle>> {
        if self.is_main() {
            return Ok(None);
        }
        let detached = || Error::new("Frame has been detached.");
        let parent = self.parent().ok_or_else(detached)?;
        let session = parent.owning_session().ok_or_else(detached)?;
        let owner = session
            .call("DOM.getFrameOwner", json!({ "frameId": self.id() }))
            .await
            .map_err(|error| {
                if error
                    .message
                    .contains("Frame with the given id was not found.")
                {
                    detached()
                } else {
                    protocol_error("", "DOM.getFrameOwner", error)
                }
            })?;
        let parent = self.parent().ok_or_else(detached)?;
        let context = parent.context(World::Utility, "").await?;
        resolve_node(&context, &owner["backendNodeId"])
            .await
            .map(Some)
    }

    /// Resolve once `state` has fired for the current document.
    pub async fn wait_for_load_state(&self, state: LoadState, timeout: Duration) -> Result<()> {
        self.wait_for_load_state_api("frame.waitForLoadState", state, timeout)
            .await
    }

    /// Whether `state` has fired for the current document.
    pub fn has_load_state(&self, state: LoadState) -> bool {
        let shared = self.shared.state.lock().unwrap();
        shared
            .frames
            .get(&self.key)
            .is_some_and(|frame| frame.has(state))
    }
}

/// `_adoptBackendNodeId`.
async fn resolve_node(context: &ExecContext, backend_node_id: &Value) -> Result<JsHandle> {
    let resolved = context
        .session
        .call(
            "DOM.resolveNode",
            json!({ "backendNodeId": backend_node_id, "executionContextId": context.id }),
        )
        .await
        .ok()
        .filter(|reply| reply["object"]["subtype"] != "null");
    resolved
        .and_then(|reply| handle_of(&context.session, &reply["object"]))
        .ok_or_else(|| Error::new(UNABLE_TO_ADOPT))
}

impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("id", &self.id)
            .field("seq", &self.seq())
            .finish()
    }
}
