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
//! before it is let run (`Runtime.runIfWaitingForDebugger`). The caller
//! owns `Network.enable` and `Runtime.enable` (needed for
//! `Runtime.bindingCalled`); this module owns `Fetch.*`,
//! `Network.setCacheDisabled`, the bindings and the init scripts.
//!
//! What it does per target kind (Playwright 1.63.0, `crNetworkManager`,
//! `crPage` `FrameSession._initialize`, `crServiceWorker`):
//!
//! - pages and out-of-process iframes: `Network.setCacheDisabled {true}`,
//!   `Fetch.enable {handleAuthRequests: true, patterns: [{urlPattern: '*',
//!   requestStage: 'Request'}]}`, `Runtime.addBinding
//!   {name: '__playwright__binding__'}` and, in the main world with
//!   `runImmediately`, the init scripts in Playwright's order: the bindings
//!   controller, `addBinding('__pwWebSocketBinding')`, the service-worker
//!   block, the WebSocket mock.
//! - dedicated workers: `Network.setCacheDisabled {true}` only (Playwright
//!   skips `Fetch` on worker sessions: their requests pause on the page's).
//! - service workers (and shared workers): see the deviations.
//!
//! `Fetch.requestPaused`: an intercepted CORS preflight is fulfilled with
//! Playwright's 204; a redirect hop continues unchecked, as Playwright does
//! not route redirects (the manager's `assertAllowed` covers the final
//! URLs); every other request is checked: `Fetch.failRequest {errorReason:
//! 'BlockedByClient'}` or `Fetch.continueRequest {requestId}`.
//!
//! A redirect hop pauses again with the request's `networkId` and the new
//! URL (Chromium 153 sets no `redirectedRequestId` at the `Request`
//! stage). Playwright continues it unrouted, either because its
//! `Network.requestWillBeSent` carries the `redirectResponse` or because
//! the request was already continued (it replays that `continue`). Here: a
//! pause whose `networkId` this session already continued is continued
//! again unchecked. Checking hops instead would cost nothing more than
//! dropping that rule ([`CHECK_REDIRECT_HOPS`]): each hop's pause has its
//! URL.
//! `Fetch.authRequired` answers `Default` (Playwright without credentials).
//!
//! Deviations (each blocks more than Playwright, never less):
//!
//! - Playwright continues a paused request without a `networkId`, and one
//!   whose frame it does not know, without routing it: such a request's URL
//!   would reach the network unchecked. Here every paused request that is
//!   not a redirect hop or preflight is checked. A dedicated worker's
//!   `fetch` pauses without a `networkId` (seen with Chromium 153 when the
//!   worker's session has not enabled `Network`).
//! - With `serviceWorkers: 'block'` Playwright gives a service worker no
//!   network manager, so a service worker that runs anyway (the init script
//!   only replaces `navigator.serviceWorker.register` on the instance;
//!   `ServiceWorkerContainer.prototype.register` still works) fetches
//!   unchecked. Here service workers get the same `Fetch` guard as pages.
//!   Likewise shared workers, whose requests the page's `Fetch` does not
//!   see (Playwright detaches them, so they run unguarded).
//!
//! Known gaps kept from Playwright's WebSocket mock (an untrusted page can
//! open a socket to a blocked host): `ws.url` is a writable property the
//! mock connects to after the verdict on the original URL, and
//! `__pwWebSocketDispatch` is a page-visible global that connects any
//! pending socket. WebSockets of workers are not guarded at all (the mock
//! is a main-world init script; `Fetch` does not see WebSocket handshakes).
//! - The bindings controller is pirc's own few lines rather than
//!   Playwright's `BindingsController` (not among the extracted assets): it
//!   defines the same globals and wire envelope (`{name, seq,
//!   serializedArgs}` on `__playwright__binding__`), with the arguments as
//!   plain JSON instead of Playwright's serialization, and resolves a
//!   binding call's promise at once (the mock never awaits it).
//! - Playwright recognizes a CORS preflight by its `Network.requestWillBeSent`
//!   (`initiator.type === 'preflight'`, method `OPTIONS`), which it pairs
//!   with the pause. The pause alone tells it here: `OPTIONS` with an
//!   `Access-Control-Request-Method` header, which only Chromium can set
//!   (a forbidden request header for pages); the paused event's resource
//!   type is the request's own (`XHR`), not `Preflight`.
//! - An allowed WebSocket is dispatched `passthrough` (the mock connects and
//!   relays itself), where Playwright's `connectToServer()` dispatches
//!   `connect` and relays every message through its client: the page sees
//!   the same socket. A page `close()` before the verdict is relayed as
//!   Playwright's client does (`closeServer`, then `closePage`).
//!
//! Owner: netio.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::Result;
use super::cdp::{Event, Session};
use crate::browser::assets;
use crate::browser::hosts::HostGuard;

/// What kind of target a session is (`targetInfo.type`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Page,
    /// An out-of-process iframe.
    Iframe,
    Worker,
    /// A worker with its own network: service workers, and shared workers
    /// (which Playwright detaches, letting them run unguarded: the context
    /// should install this instead; see the module documentation).
    ServiceWorker,
}

/// The guard's state for one target session; dropping it stops handling
/// the session's events.
pub struct Installed {
    task: Option<JoinHandle<()>>,
}

impl Drop for Installed {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Playwright's single CDP binding (`PageBinding.kBindingName`).
pub const PLAYWRIGHT_BINDING: &str = "__playwright__binding__";
/// The binding the WebSocket mock calls (`kBindingName` of
/// `webSocketRouteDispatcher.ts`).
pub const WEBSOCKET_BINDING: &str = "__pwWebSocketBinding";
/// The close a blocked WebSocket gets (`ws.close({code: 1008, reason})`).
pub const BLOCKED_CLOSE_CODE: u16 = 1008;
pub const BLOCKED_CLOSE_REASON: &str = "blocked by pirc";

/// `Fetch.enable` as Playwright sends it while routing.
fn fetch_enable() -> Value {
    json!({
        "handleAuthRequests": true,
        "patterns": [{ "urlPattern": "*", "requestStage": "Request" }],
    })
}

/// Playwright's `InitScript` wrapper.
fn init_script(source: &str) -> String {
    format!("(() => {{\n      {source}\n    }})();")
}

/// The bindings controller (pirc's stand-in for Playwright's
/// `BindingsController`, see the module documentation).
const BINDINGS_CONTROLLER: &str = r#"
      (() => {
        const property = '__playwright__binding__controller__';
        if (globalThis[property])
          return;
        const send = globalThis['__playwright__binding__'];
        const stringify = JSON.stringify;
        const resolved = () => Promise.resolve(undefined);
        const bindings = new Map();
        globalThis[property] = {
          addBinding(bindingName, noGlobal) {
            const data = { lastSeq: 0, removed: false };
            bindings.set(bindingName, data);
            if (!noGlobal)
              globalThis[bindingName] = (...args) => this.callBinding(bindingName, ...args);
          },
          callBinding(bindingName, ...args) {
            const data = bindings.get(bindingName);
            if (!data || data.removed)
              throw new Error(`binding "${bindingName}" has been removed`);
            const seq = ++data.lastSeq;
            send(stringify({ name: bindingName, seq, serializedArgs: args }));
            return resolved();
          },
        };
      })();
    "#;

/// `serviceWorkers: 'block'` (`BrowserContext._initialize`), verbatim.
const BLOCK_SERVICE_WORKERS: &str = "\nif (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };\n";

/// The main-world init scripts of a page or frame session, in the order
/// Playwright's `page.allInitScripts()` gives them.
pub fn init_scripts() -> Vec<String> {
    vec![
        init_script(BINDINGS_CONTROLLER),
        init_script(&format!(
            "globalThis['__playwright__binding__controller__'].addBinding({}, false)",
            json!(WEBSOCKET_BINDING)
        )),
        init_script(BLOCK_SERVICE_WORKERS),
        init_script(&format!(
            "\n      (() => {{\n        const module = {{}};\n        {}\n        (module.exports.inject())(globalThis);\n      }})();\n    ",
            assets::WEBSOCKET_MOCK
        )),
    ]
}

/// Guard `session` (a target of `kind`) with `guard`.
pub async fn install(
    session: &Session,
    kind: TargetKind,
    guard: Arc<HostGuard>,
) -> Result<Installed> {
    if kind == TargetKind::Worker {
        // `_updateProtocolRequestInterceptionForSession` for a `workerFrame`.
        session
            .call("Network.setCacheDisabled", json!({ "cacheDisabled": true }))
            .await?;
        return Ok(Installed { task: None });
    }
    // Listen before anything can pause.
    let events = session.listen();
    let task = tokio::spawn(handle_events(session.clone(), events, guard));
    let installed = Installed { task: Some(task) };
    let cache = session.call("Network.setCacheDisabled", json!({ "cacheDisabled": true }));
    let fetch = session.call("Fetch.enable", fetch_enable());
    if kind == TargetKind::ServiceWorker {
        let (cache, fetch) = tokio::join!(cache, fetch);
        cache?;
        fetch?;
        return Ok(installed);
    }
    // The binding exists before the scripts that capture it run.
    let binding = session.call("Runtime.addBinding", json!({ "name": PLAYWRIGHT_BINDING }));
    let (cache, fetch, binding) = tokio::join!(cache, fetch, binding);
    cache?;
    fetch?;
    binding?;
    for source in init_scripts() {
        session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": source, "runImmediately": true }),
            )
            .await?;
    }
    Ok(installed)
}

/// Whether a redirect hop is checked like any request (`false`: as TS
/// with Playwright, which does not route redirects).
pub const CHECK_REDIRECT_HOPS: bool = false;

/// The `networkId`s this session continued (their later pauses are
/// redirect hops or repeats), forgotten when the request ends; cleared
/// when it grows past [`CONTINUED_MAX`] (a later hop is then checked).
#[derive(Default)]
struct Continued(Mutex<HashSet<String>>);

const CONTINUED_MAX: usize = 10_000;

impl Continued {
    fn contains(&self, id: &str) -> bool {
        self.0.lock().unwrap().contains(id)
    }

    fn insert(&self, id: &str) {
        let mut ids = self.0.lock().unwrap();
        if ids.len() >= CONTINUED_MAX {
            ids.clear();
        }
        ids.insert(id.to_owned());
    }

    fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

async fn handle_events(
    session: Session,
    mut events: tokio::sync::mpsc::UnboundedReceiver<Event>,
    guard: Arc<HostGuard>,
) {
    let continued: Arc<Continued> = Arc::default();
    while let Some(event) = events.recv().await {
        match event.method.as_str() {
            "Fetch.requestPaused" => {
                let session = session.clone();
                let guard = guard.clone();
                let continued = continued.clone();
                tokio::spawn(async move {
                    on_request_paused(&session, &guard, &continued, event.params).await;
                });
            }
            "Fetch.authRequired" => {
                let session = session.clone();
                tokio::spawn(async move {
                    let _ = session
                        .call(
                            "Fetch.continueWithAuth",
                            json!({
                                "requestId": event.params["requestId"],
                                "authChallengeResponse": { "response": "Default" },
                            }),
                        )
                        .await;
                });
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                if let Some(id) = event.params["requestId"].as_str() {
                    continued.remove(id);
                }
            }
            "Runtime.bindingCalled" if event.params["name"] == PLAYWRIGHT_BINDING => {
                let session = session.clone();
                let guard = guard.clone();
                tokio::spawn(
                    async move { on_binding_called(&session, &guard, event.params).await },
                );
            }
            _ => {}
        }
    }
}

/// What to do with a paused request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// `Fetch.continueRequest` unchecked (a redirect hop).
    Continue,
    /// Playwright's answer to an intercepted CORS preflight.
    FulfillPreflight(Vec<Value>),
    /// Ask the guard about this URL.
    Check(String),
}

/// How `_onRequestPaused`/`_onRequest` treat a `Fetch.requestPaused`;
/// `hop`: its `networkId` was already continued (see the module
/// documentation).
pub fn classify(paused: &Value, hop: bool) -> Verdict {
    let request = &paused["request"];
    let headers = &request["headers"];
    let preflight = request["method"] == "OPTIONS"
        && headers.as_object().is_some_and(|headers| {
            headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("access-control-request-method"))
        });
    if preflight {
        let header = |name: &str| headers[name].as_str().filter(|value| !value.is_empty());
        let mut response = vec![
            json!({ "name": "Access-Control-Allow-Origin", "value": header("Origin").unwrap_or("*") }),
            json!({ "name": "Access-Control-Allow-Methods",
                "value": header("Access-Control-Request-Method").unwrap_or("GET, POST, OPTIONS, DELETE") }),
            json!({ "name": "Access-Control-Allow-Credentials", "value": "true" }),
        ];
        if let Some(allow) = header("Access-Control-Request-Headers") {
            response.push(json!({ "name": "Access-Control-Allow-Headers", "value": allow }));
        }
        return Verdict::FulfillPreflight(response);
    }
    if hop && !CHECK_REDIRECT_HOPS {
        return Verdict::Continue;
    }
    Verdict::Check(request["url"].as_str().unwrap_or_default().to_owned())
}

async fn on_request_paused(
    session: &Session,
    guard: &HostGuard,
    continued: &Continued,
    paused: Value,
) {
    let request_id = paused["requestId"].clone();
    let network_id = paused["networkId"].as_str();
    let hop = network_id.is_some_and(|id| continued.contains(id));
    let proceed = || {
        if let Some(id) = network_id {
            continued.insert(id);
        }
        ("Fetch.continueRequest", json!({ "requestId": request_id }))
    };
    let (method, params) = match classify(&paused, hop) {
        Verdict::Continue => proceed(),
        Verdict::FulfillPreflight(headers) => (
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": 204,
                "responsePhrase": "No Content",
                "responseHeaders": headers,
                "body": "",
            }),
        ),
        Verdict::Check(url) => match guard.blocked_reason(&url).await {
            Some(_) => (
                "Fetch.failRequest",
                json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
            ),
            None => proceed(),
        },
    };
    let _ = session.call(method, params).await;
}

/// A WebSocket mock's report (`binding({type, id, ...})`) and what
/// Playwright's server and client answer to it: the requests for
/// `__pwWebSocketDispatch`. `Check` is an `onCreate` awaiting the guard.
#[derive(Clone, Debug, PartialEq)]
pub enum SocketAction {
    Check { id: Value, url: String },
    Dispatch(Value),
    Ignore,
}

/// The dispatch request for a WebSocket's verdict.
pub fn socket_verdict(id: &Value, blocked: bool) -> Value {
    if blocked {
        json!({ "id": id, "type": "closePage", "code": BLOCKED_CLOSE_CODE,
            "reason": BLOCKED_CLOSE_REASON, "wasClean": true })
    } else {
        json!({ "id": id, "type": "passthrough" })
    }
}

/// What to do with a `Runtime.bindingCalled` payload of the bindings
/// controller.
pub fn socket_action(payload: &str) -> SocketAction {
    let Ok(call) = serde_json::from_str::<Value>(payload) else {
        return SocketAction::Ignore;
    };
    if call["name"] != WEBSOCKET_BINDING {
        return SocketAction::Ignore;
    }
    let message = &call["serializedArgs"][0];
    let id = message["id"].clone();
    if !id.is_string() {
        return SocketAction::Ignore;
    }
    // Playwright's client without handlers relays one side's close to the
    // other (`closePage` → `closeServer` and back).
    let relay = |kind: &str| {
        let mut request = json!({ "id": id, "type": kind });
        for key in ["code", "reason", "wasClean"] {
            if let Some(value) = message.get(key) {
                request[key] = value.clone();
            }
        }
        SocketAction::Dispatch(request)
    };
    match message["type"].as_str() {
        Some("onCreate") => SocketAction::Check {
            url: message["url"].as_str().unwrap_or_default().to_owned(),
            id,
        },
        Some("onClosePage") => relay("closeServer"),
        Some("onCloseServer") => relay("closePage"),
        // Only sockets in `connect` mode report messages; pirc's are
        // passthrough or closed.
        _ => SocketAction::Ignore,
    }
}

async fn on_binding_called(session: &Session, guard: &HostGuard, params: Value) {
    let context = params["executionContextId"].clone();
    let request = match socket_action(params["payload"].as_str().unwrap_or_default()) {
        SocketAction::Ignore => return,
        SocketAction::Dispatch(request) => request,
        SocketAction::Check { id, url } => {
            socket_verdict(&id, guard.blocked_reason(&url).await.is_some())
        }
    };
    // `frame.evaluateExpression` in the main world the mock lives in (the
    // context that called the binding); a context gone meanwhile is fine.
    let _ = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": format!("globalThis.__pwWebSocketDispatch({request})"),
                "contextId": context,
            }),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paused_requests() {
        assert_eq!(
            classify(
                &json!({ "requestId": "1", "request": { "url": "http://a/", "method": "GET" } }),
                false
            ),
            Verdict::Check("http://a/".into())
        );
        assert_eq!(
            classify(
                &json!({ "requestId": "1", "networkId": "9",
                "request": { "url": "http://10.0.0.1/", "method": "GET" } }),
                true
            ),
            Verdict::Continue
        );
        // No networkId: checked (Playwright continues it).
        // A page's own OPTIONS request is no preflight.
        assert_eq!(
            classify(
                &json!({ "requestId": "1", "request": { "url": "http://c/", "method": "OPTIONS",
                "headers": { "Origin": "http://a" } } }),
                false
            ),
            Verdict::Check("http://c/".into())
        );
        assert_eq!(
            classify(
                &json!({ "requestId": "1", "request": { "url": "http://b/", "method": "POST" } }),
                false
            ),
            Verdict::Check("http://b/".into())
        );
        assert_eq!(
            classify(
                &json!({ "requestId": "1", "resourceType": "XHR",
                "request": { "url": "http://b/", "method": "OPTIONS", "headers": {
                    "Origin": "http://a", "Access-Control-Request-Method": "PUT",
                    "Access-Control-Request-Headers": "x-a" } } }),
                false
            ),
            Verdict::FulfillPreflight(vec![
                json!({ "name": "Access-Control-Allow-Origin", "value": "http://a" }),
                json!({ "name": "Access-Control-Allow-Methods", "value": "PUT" }),
                json!({ "name": "Access-Control-Allow-Credentials", "value": "true" }),
                json!({ "name": "Access-Control-Allow-Headers", "value": "x-a" }),
            ])
        );
        assert_eq!(
            classify(
                &json!({ "requestId": "1", "resourceType": "XHR",
                "request": { "url": "http://b/", "method": "OPTIONS", "headers": {
                    "Origin": "", "Access-Control-Request-Method": "" } } }),
                false
            ),
            Verdict::FulfillPreflight(vec![
                json!({ "name": "Access-Control-Allow-Origin", "value": "*" }),
                json!({ "name": "Access-Control-Allow-Methods", "value": "GET, POST, OPTIONS, DELETE" }),
                json!({ "name": "Access-Control-Allow-Credentials", "value": "true" }),
            ])
        );
    }

    fn call(message: Value) -> String {
        json!({ "name": WEBSOCKET_BINDING, "seq": 1, "serializedArgs": [message] }).to_string()
    }

    #[test]
    fn answers_the_websocket_mock_as_playwright() {
        assert_eq!(
            socket_action(&call(
                json!({ "type": "onCreate", "id": "ab", "url": "wss://x/", "protocols": [] })
            )),
            SocketAction::Check {
                id: json!("ab"),
                url: "wss://x/".into()
            }
        );
        assert_eq!(
            socket_verdict(&json!("ab"), true).to_string(),
            r#"{"id":"ab","type":"closePage","code":1008,"reason":"blocked by pirc","wasClean":true}"#
        );
        assert_eq!(
            socket_verdict(&json!("ab"), false).to_string(),
            r#"{"id":"ab","type":"passthrough"}"#
        );
        assert_eq!(
            socket_action(&call(
                json!({ "type": "onClosePage", "id": "ab", "code": 1000, "wasClean": true })
            )),
            SocketAction::Dispatch(
                json!({ "id": "ab", "type": "closeServer", "code": 1000, "wasClean": true })
            )
        );
        assert_eq!(
            socket_action(&call(
                json!({ "type": "onCloseServer", "id": "ab", "code": 1006, "reason": "", "wasClean": false })
            )),
            SocketAction::Dispatch(
                json!({ "id": "ab", "type": "closePage", "code": 1006, "reason": "", "wasClean": false })
            )
        );
        assert_eq!(
            socket_action(&call(
                json!({ "type": "onMessageFromPage", "id": "ab", "data": {} })
            )),
            SocketAction::Ignore
        );
        assert_eq!(socket_action("not json"), SocketAction::Ignore);
        assert_eq!(
            socket_action(
                &json!({ "name": "other", "serializedArgs": [{ "type": "onCreate", "id": "x" }] })
                    .to_string()
            ),
            SocketAction::Ignore
        );
    }

    #[test]
    fn orders_the_init_scripts_as_playwright() {
        let scripts = init_scripts();
        assert_eq!(scripts.len(), 4);
        assert!(scripts[0].contains("__playwright__binding__controller__"));
        assert!(scripts[1].contains(r#".addBinding("__pwWebSocketBinding", false)"#));
        assert!(scripts[2].contains("Service Worker registration blocked by Playwright"));
        assert!(scripts[3].contains("(module.exports.inject())(globalThis);"));
        assert!(scripts.iter().all(|s| s.starts_with("(() => {\n      ")));
    }
}
