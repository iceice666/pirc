//! `pending-requests.test.ts` and `gateway-channel.test.ts` (agent side).
//! The team channel is M5; a writer cannot fail here (`Write` is
//! infallible), so the TS cases about throwing writers have no equivalent.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Map, Value, json};

use super::*;
use crate::signal::AbortController;

fn recorder() -> (Write, Rc<RefCell<Vec<Value>>>) {
    let frames = Rc::new(RefCell::new(Vec::new()));
    let sink = frames.clone();
    (Rc::new(move |value| sink.borrow_mut().push(value)), frames)
}

fn args() -> Map<String, Value> {
    json!({ "x": 1 }).as_object().unwrap().clone()
}

fn plain(error: &str) -> ChannelError {
    ChannelError::Plain(error.to_owned())
}

#[tokio::test]
async fn registers_before_send_uses_unique_ids_and_ignores_late_settlers() {
    let requests = Rc::new(PendingRequests::<u32>::new());
    let mut ids = Vec::new();
    let mut results = Vec::new();
    for value in [1, 2] {
        let pending = requests.clone();
        let request = requests.request(
            None,
            RequestOptions {
                abort_error: || plain("Aborted"),
                cancel: None,
                timeout: None,
            },
            |id| {
                ids.push(id.to_owned());
                assert!(pending.resolve(id, value));
                assert!(!pending.reject(id, plain("late failure")));
                assert!(!pending.resolve(id, 99));
                assert!(!pending.contains(id));
            },
        );
        results.push(request);
    }
    let mut values = Vec::new();
    for request in results {
        values.push(request.await.unwrap());
    }
    assert_eq!(values, [1, 2]);
    assert_ne!(ids[0], ids[1]);
}

#[tokio::test]
async fn times_out_once_and_ignores_late_replies_and_aborts() {
    let requests = PendingRequests::<Value>::new();
    let controller = AbortController::new();
    let cancellations = Rc::new(RefCell::new(0));
    let counter = cancellations.clone();
    let mut id = String::new();
    let request = requests.request(
        Some(&controller.signal()),
        RequestOptions {
            abort_error: || plain("Aborted"),
            cancel: Some(Rc::new(move |_: &str| *counter.borrow_mut() += 1)),
            timeout: Some((Duration::from_millis(5), || plain("lost reply"))),
        },
        |value| id = value.to_owned(),
    );
    assert_eq!(request.await, Err(plain("lost reply")));
    assert!(!requests.contains(&id));
    assert!(!requests.resolve(&id, json!("late")));
    controller.abort();
    assert_eq!(*cancellations.borrow(), 0);
}

/// A channel under test, as the TS table describes it.
struct Case {
    name: &'static str,
    request: Value,
    cancel: Option<&'static str>,
    close: ChannelError,
    success: Value,
    result: Value,
    failure: Value,
    failure_error: ChannelError,
    aborted: ChannelError,
}

type Request =
    Box<dyn Fn(Option<&AbortSignal>) -> LocalBoxFuture<'static, Result<Value, ChannelError>>>;

fn boxed(request: PendingRequest<Value>) -> LocalBoxFuture<'static, Result<Value, ChannelError>> {
    Box::pin(request)
}

/// Send, receive an answer, close all.
type Client = (Request, Rc<dyn Fn(&Value)>, Rc<dyn Fn()>);

fn client(name: &str, write: Write) -> Client {
    match name {
        "gateway" => {
            let client = Rc::new(NodeGateway::new(write));
            let (a, b, c) = (client.clone(), client.clone(), client);
            (
                Box::new(move |signal| boxed(a.request("op", args(), signal))),
                Rc::new(move |frame| b.respond(frame)),
                Rc::new(move || c.close_all()),
            )
        }
        "browser" => {
            let client = Rc::new(NodeBrowser::new(write));
            let (a, b, c) = (client.clone(), client.clone(), client);
            (
                Box::new(move |signal| boxed(a.request("op", args(), signal))),
                Rc::new(move |frame| b.respond(frame)),
                Rc::new(move || c.close_all()),
            )
        }
        "sandbox" => {
            let client = Rc::new(NodeSandboxChannel::new(write));
            let (a, b, c) = (client.clone(), client.clone(), client);
            (
                Box::new(move |signal| boxed(a.request("network", args(), signal, None))),
                Rc::new(move |frame| b.respond(frame)),
                Rc::new(move || c.close_all()),
            )
        }
        _ => {
            let client = Rc::new(NodeWriteBroker::new(write));
            let (a, b, c) = (client.clone(), client.clone(), client);
            (
                Box::new(move |signal| {
                    let request = a.acquire("/workspace", signal);
                    // `undefined` as `null`.
                    Box::pin(async move { request.await.map(|()| Value::Null) })
                }),
                Rc::new(move |frame| b.respond(frame)),
                Rc::new(move || c.close_all()),
            )
        }
    }
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "gateway",
            request: json!({ "type": "gateway_request", "op": "op", "args": { "x": 1 } }),
            cancel: None,
            close: ChannelError::coded("gateway_closed", "The gateway channel closed"),
            success: json!({ "ok": true, "result": { "value": 1 } }),
            result: json!({ "value": 1 }),
            failure: json!({ "ok": false, "error": { "code": "denied", "message": "refused",
                "status": 409, "details": { "version": 2 } } }),
            failure_error: ChannelError::Coded {
                code: "denied".to_owned(),
                message: "refused".to_owned(),
                status: Some(409.0),
                details: Some(Box::new(json!({ "version": 2 }))),
            },
            aborted: plain("Aborted"),
        },
        Case {
            name: "browser",
            request: json!({ "type": "browser_request", "op": "op", "args": { "x": 1 } }),
            cancel: Some("browser_cancel"),
            close: ChannelError::coded("closed", "The browser channel closed"),
            success: json!({ "ok": true, "result": { "value": 1 } }),
            result: json!({ "value": 1 }),
            failure: json!({ "ok": false, "error": { "code": "denied", "message": "refused" } }),
            failure_error: ChannelError::coded("denied", "refused"),
            aborted: ChannelError::coded("aborted", "Aborted"),
        },
        Case {
            name: "sandbox",
            request: json!({ "type": "sandbox_request", "op": "network", "args": { "x": 1 } }),
            cancel: Some("sandbox_cancel"),
            close: ChannelError::coded("closed", "The sandbox channel closed"),
            success: json!({ "ok": true, "result": null }),
            result: json!({}),
            failure: json!({ "ok": false, "error": { "code": "denied", "message": "refused" } }),
            failure_error: ChannelError::coded("denied", "refused"),
            aborted: ChannelError::coded("aborted", "Aborted"),
        },
        Case {
            name: "write lease",
            request: json!({ "type": "write_lease_request", "path": "/workspace" }),
            cancel: None,
            close: plain("Write broker closed"),
            success: json!({ "granted": true }),
            result: Value::Null,
            failure: json!({ "granted": false, "error": "refused" }),
            failure_error: plain("refused"),
            aborted: plain("Aborted"),
        },
    ]
}

fn with_id(frame: &Value, id: &Value) -> Value {
    let mut frame = frame.clone();
    frame["id"] = id.clone();
    frame
}

/// The request frame with its id moved to second place, as TS writes it.
fn expected_frame(case: &Case, id: &Value) -> Value {
    let mut out = Map::new();
    let request = case.request.as_object().unwrap();
    out.insert("type".to_owned(), request["type"].clone());
    out.insert("id".to_owned(), id.clone());
    for (key, value) in request.iter().skip(1) {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

async fn local<F: std::future::Future>(future: F) -> F::Output {
    tokio::task::LocalSet::new().run_until(future).await
}

#[tokio::test]
async fn preserves_frames_and_correlates_results() {
    local(async {
        for case in cases() {
            let (write, frames) = recorder();
            let (request, receive, close) = client(case.name, write);
            let controller = AbortController::new();
            let success = request(Some(&controller.signal()));
            let failure = request(Some(&controller.signal()));
            let sent = frames.borrow().clone();
            assert_eq!(
                sent[0],
                expected_frame(&case, &sent[0]["id"]),
                "{}",
                case.name
            );
            // Byte order too.
            assert_eq!(
                serde_json::to_string(&sent[0]).unwrap(),
                serde_json::to_string(&expected_frame(&case, &sent[0]["id"])).unwrap()
            );
            assert_ne!(sent[0]["id"], sent[1]["id"]);
            receive(&with_id(&case.success, &json!(3)));
            receive(&with_id(&case.success, &json!("unknown")));
            receive(&with_id(&case.failure, &sent[1]["id"]));
            receive(&with_id(&case.success, &sent[0]["id"]));
            receive(&with_id(&case.failure, &sent[0]["id"]));
            assert_eq!(success.await, Ok(case.result.clone()), "{}", case.name);
            let error = failure.await.unwrap_err();
            assert_eq!(error, case.failure_error, "{}", case.name);
            assert_eq!(error.message(), "refused");
            controller.abort();
            close();
            assert_eq!(frames.borrow().len(), 2, "{}", case.name);
        }
    })
    .await;
}

#[tokio::test]
async fn pre_abort_sends_nothing_and_post_abort_sends_the_cancellation() {
    local(async {
        for case in cases() {
            let (write, frames) = recorder();
            let (request, receive, close) = client(case.name, write);
            let pre = AbortController::new();
            pre.abort();
            assert_eq!(
                request(Some(&pre.signal())).await,
                Err(plain(PRE_ABORTED)),
                "{}",
                case.name
            );
            assert!(frames.borrow().is_empty());
            let controller = AbortController::new();
            let result = request(Some(&controller.signal()));
            controller.abort();
            let id = frames.borrow()[0]["id"].clone();
            receive(&with_id(&case.success, &id));
            close();
            assert_eq!(result.await, Err(case.aborted.clone()), "{}", case.name);
            let mut expected = vec![expected_frame(&case, &id)];
            if let Some(cancel) = case.cancel {
                expected.push(json!({ "type": cancel, "id": id }));
            }
            assert_eq!(*frames.borrow(), expected, "{}", case.name);
        }
    })
    .await;
}

#[tokio::test]
async fn closes_all_without_cancellations_and_permits_later_requests() {
    local(async {
        for case in cases() {
            let (write, frames) = recorder();
            let (request, receive, close) = client(case.name, write);
            let controller = AbortController::new();
            let first = request(Some(&controller.signal()));
            let second = request(Some(&controller.signal()));
            close();
            close();
            controller.abort();
            assert_eq!(first.await, Err(case.close.clone()), "{}", case.name);
            assert_eq!(second.await, Err(case.close.clone()));
            assert_eq!(frames.borrow().len(), 2, "{}", case.name);
            let id = frames.borrow()[0]["id"].clone();
            receive(&with_id(&case.success, &id));
            let next = request(None);
            let id = frames.borrow()[2]["id"].clone();
            receive(&with_id(&case.success, &id));
            assert_eq!(next.await, Ok(case.result.clone()), "{}", case.name);
        }
    })
    .await;
}

#[tokio::test]
async fn dropping_a_request_abandons_it() {
    let (write, frames) = recorder();
    let browser = NodeBrowser::new(write.clone());
    let request = browser.request("op", args(), None);
    let id = frames.borrow()[0]["id"].clone();
    drop(request);
    assert_eq!(
        frames.borrow()[1],
        json!({ "type": "browser_cancel", "id": id })
    );
    browser.respond(&json!({ "id": id, "ok": true }));
    let broker = NodeWriteBroker::new(write);
    let request = broker.acquire("/w", None);
    let id = request.id().unwrap().to_owned();
    drop(request);
    assert!(!broker.pending.contains(&id));
    assert_eq!(frames.borrow().len(), 3);
}

#[tokio::test]
async fn sandbox_requests_name_their_operation() {
    let (write, frames) = recorder();
    let sandbox = NodeSandboxChannel::new(write);
    let request = sandbox.request("exec", Map::new(), None, Some("call-1"));
    let id = frames.borrow()[0]["id"].clone();
    assert_eq!(
        serde_json::to_string(&frames.borrow()[0]).unwrap(),
        format!(
            r#"{{"type":"sandbox_request","id":{id},"op":"exec","args":{{}},"toolCallId":"call-1"}}"#
        )
    );
    sandbox.respond(&json!({ "id": id, "ok": false, "error": "nope" }));
    assert_eq!(
        request.await,
        Err(ChannelError::coded(
            "sandbox_error",
            "The sandbox request failed"
        ))
    );
}

// gateway-channel.test.ts

#[tokio::test]
async fn gateway_sends_requests_and_settles_them_from_the_node_answers() {
    let (write, lines) = recorder();
    let gateway = NodeGateway::new(write);
    let ok = gateway.request(
        "assistant.context",
        json!({ "a": 1 }).as_object().unwrap().clone(),
        None,
    );
    let failed = gateway.request("nope.op", Map::new(), None);
    let sent: Vec<_> = lines
        .borrow()
        .iter()
        .map(|line| json!([line["type"], line["op"], line["args"]]))
        .collect();
    assert_eq!(
        sent,
        [
            json!(["gateway_request", "assistant.context", { "a": 1 }]),
            json!(["gateway_request", "nope.op", {}]),
        ]
    );
    let ids: Vec<Value> = lines
        .borrow()
        .iter()
        .map(|line| line["id"].clone())
        .collect();
    gateway.respond(&json!({ "id": "someone-else", "ok": true, "result": 1 }));
    gateway.respond(&json!({ "id": ids[0], "ok": true, "result": { "enabled": false } }));
    gateway.respond(
        &json!({ "id": ids[1], "ok": false, "error": { "status": 404,
        "code": "unknown_operation", "message": "Unknown gateway operation: nope.op" } }),
    );
    assert_eq!(ok.await, Ok(json!({ "enabled": false })));
    let error = failed.await.unwrap_err();
    assert_eq!(
        error,
        ChannelError::Coded {
            code: "unknown_operation".to_owned(),
            message: "Unknown gateway operation: nope.op".to_owned(),
            status: Some(404.0),
            details: None,
        }
    );
    // A reply without a usable error object.
    let request = gateway.request("x", Map::new(), None);
    let id = lines.borrow()[2]["id"].clone();
    gateway.respond(&json!({ "id": id, "ok": "yes", "error": null }));
    assert_eq!(
        request.await,
        Err(ChannelError::coded(
            "internal_error",
            "The gateway request failed"
        ))
    );
}

#[tokio::test]
async fn gateway_gives_up_on_aborts_lost_replies_and_shutdown() {
    let quick = NodeGateway::with_lost_reply(Rc::new(|_| {}), 20);
    let controller = AbortController::new();
    let aborted = quick.request("a.b", Map::new(), Some(&controller.signal()));
    controller.abort();
    assert_eq!(aborted.await.unwrap_err().message(), "Aborted");
    assert_eq!(
        quick
            .request("a.b", Map::new(), None)
            .await
            .unwrap_err()
            .code(),
        Some("gateway_timeout")
    );
    let slow = NodeGateway::with_lost_reply(Rc::new(|_| {}), 60_000);
    let pending = slow.request("a.b", Map::new(), None);
    slow.close_all();
    assert_eq!(pending.await.unwrap_err().code(), Some("gateway_closed"));
    assert_eq!(GATEWAY_LOST_REPLY_MS, 45_000);
}

#[test]
fn channels_exist_only_for_the_main_agent_of_a_node() {
    let env = |vars: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    };
    assert!(gateway_enabled(&env(&[("PIRC_GATEWAY", "1")])));
    assert!(!gateway_enabled(&env(&[
        ("PIRC_GATEWAY", "1"),
        ("PIRC_TEAM_AGENT", "worker")
    ])));
    assert!(gateway_enabled(&env(&[
        ("PIRC_GATEWAY", "1"),
        ("PIRC_TEAM_AGENT", "")
    ])));
    assert!(!gateway_enabled(&env(&[])));
    assert!(!gateway_enabled(&env(&[("PIRC_GATEWAY", "true")])));
    assert!(browser_enabled(&env(&[("PIRC_BROWSER", "1")])));
    assert!(!browser_enabled(&env(&[
        ("PIRC_BROWSER", "1"),
        ("PIRC_TEAM_AGENT", "w")
    ])));
    assert!(sandbox_enabled(&env(&[("PIRC_SANDBOX", "srt")])));
    assert!(!sandbox_enabled(&env(&[("PIRC_SANDBOX", "1")])));
    assert!(write_lease_with(&env(&[]), node_channels).is_none());
    assert!(write_lease_with(&env(&[("PIRC_WRITE_BROKER", "1")]), node_channels).is_some());
}

#[tokio::test]
async fn routes_responses_to_their_channel() {
    let (write, frames) = recorder();
    let channels = NodeChannels::new(write);
    let lease = channels.write_broker.acquire("/w", None);
    let gateway = channels.gateway.request("op", Map::new(), None);
    let ids: Vec<Value> = frames.borrow().iter().map(|f| f["id"].clone()).collect();
    assert!(channels.route(
        "write_lease_response",
        &json!({ "id": ids[0], "granted": true })
    ));
    assert!(channels.route(
        "gateway_response",
        &json!({ "id": ids[1], "ok": true, "result": 7 })
    ));
    assert!(!channels.route("team_result", &json!({})));
    assert_eq!(lease.await, Ok(()));
    assert_eq!(gateway.await, Ok(json!(7)));
    let lease = channels.write_broker.acquire("/w", None);
    channels.close_all();
    assert_eq!(lease.await, Err(plain("Write broker closed")));
}
