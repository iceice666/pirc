//! The PTC execution engine (`apps/gateway/test/ptc-runtime.test.ts`):
//! preflight, the QuickJS realm, the SDK, quotas, cancellation and the
//! completion summary, against a fake broker. Agent integration is covered
//! by the agent_ptc conformance transcripts; the registry, argument
//! validation and attachments by the crate's unit tests.
//!
//! The scripts run in a real `ptc-guest` process: this test binary is its
//! own guest (`harness = false`), as `pirc-node` is in production.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::time::{Duration, Instant};

use pirc_agent::LocalBoxFuture;
use pirc_agent::ptc::contracts::{CONTRACT_VERSION, PtcError, budgets};
use pirc_agent::ptc::runtime::{
    Broker, BrokerCall, ExecutionOptions, ExecutionReport, OnHumanWait, OnProgress, execute,
};
use pirc_agent::signal::{AbortController, AbortSignal};
use pirc_ptc::preflight::preflight;
use serde_json::{Map, Value, json};

type Handler = Rc<dyn Fn(BrokerCall) -> LocalBoxFuture<'static, Value>>;

fn handler<F, Fut>(f: F) -> Handler
where
    F: Fn(BrokerCall) -> Fut + 'static,
    Fut: Future<Output = Value> + 'static,
{
    Rc::new(move |call| Box::pin(f(call)))
}

fn ok(call: &BrokerCall, text: &str) -> Value {
    json!({ "ok": true, "contractVersion": CONTRACT_VERSION, "operationId": call.operation_id,
        "data": { "text": text }, "attachments": [], "truncated": false })
}

fn failure(call: &BrokerCall, code: &str, message: &str, outcome: &str) -> Value {
    json!({ "ok": false, "contractVersion": 1, "operationId": call.operation_id,
        "error": { "code": code, "message": message, "outcome": outcome } })
}

struct FakeBroker {
    manifest: Vec<String>,
    writes: Vec<String>,
    handlers: HashMap<String, Handler>,
    calls: Rc<RefCell<Vec<String>>>,
}

impl Broker for FakeBroker {
    fn manifest(&self) -> &[String] {
        &self.manifest
    }

    fn is_write(&self, name: &str, _args: &Map<String, Value>) -> bool {
        self.writes.iter().any(|write| write == name)
    }

    fn invoke(&self, call: BrokerCall) -> LocalBoxFuture<'static, Result<Value, PtcError>> {
        self.calls.borrow_mut().push(call.name.clone());
        let handler = self.handlers.get(&call.name).cloned();
        Box::pin(async move {
            let Some(handler) = handler else {
                return Err(PtcError::with_outcome(
                    "OperationFailed",
                    format!("no handler for {}", call.name),
                    "unknown",
                ));
            };
            (call.claim_slot)(call.name.clone(), call.args.clone()).await?;
            Ok(handler(call).await)
        })
    }
}

#[derive(Default)]
struct Options {
    signal: Option<AbortSignal>,
    timeout: Option<Duration>,
    writes: Vec<&'static str>,
    on_human_wait: Option<OnHumanWait>,
    on_progress: Option<OnProgress>,
    on_process: Option<Box<dyn FnOnce(u32)>>,
}

struct Run {
    report: ExecutionReport,
    calls: Rc<RefCell<Vec<String>>>,
}

fn guest() -> Vec<std::ffi::OsString> {
    vec![
        std::env::current_exe().unwrap().into_os_string(),
        "ptc-guest".into(),
    ]
}

async fn run(code: &str, handlers: Vec<(&str, Handler)>, options: Options) -> Run {
    let compiled = preflight(code).unwrap_or_else(|e| panic!("{code}: {}", e.message));
    let calls = Rc::new(RefCell::new(Vec::new()));
    let broker = FakeBroker {
        manifest: compiled.manifest,
        writes: options.writes.iter().map(|w| (*w).to_owned()).collect(),
        handlers: handlers
            .into_iter()
            .map(|(name, handler)| (name.to_owned(), handler))
            .collect(),
        calls: calls.clone(),
    };
    let report = execute(ExecutionOptions {
        code: compiled.js,
        broker: Rc::new(broker),
        signal: options.signal.unwrap_or_else(AbortSignal::never),
        timeout: options.timeout.unwrap_or(Duration::from_secs(10)),
        turn_id: "turn".to_owned(),
        execution_id: "exec".to_owned(),
        on_human_wait: options.on_human_wait,
        attach: None,
        on_progress: options.on_progress,
        store: None,
        guest: guest(),
        on_process: options.on_process,
    })
    .await;
    Run { report, calls }
}

/// The returned value: a string as is, else parsed JSON.
fn value(report: &ExecutionReport) -> Value {
    if report.value_is_string {
        json!(report.value)
    } else {
        serde_json::from_str(report.value.as_deref().unwrap_or("null")).unwrap()
    }
}

fn echo() -> Handler {
    handler(|call: BrokerCall| async move {
        let text = serde_json::to_string(&call.args).unwrap();
        ok(&call, &text)
    })
}

fn code_of(report: &ExecutionReport) -> &str {
    report.error.as_ref().map_or("", |(code, _)| code.as_str())
}

fn message_of(report: &ExecutionReport) -> &str {
    report
        .error
        .as_ref()
        .map_or("", |(_, message)| message.as_str())
}

fn sleep(ms: u64) -> tokio::time::Sleep {
    tokio::time::sleep(Duration::from_millis(ms))
}

// --- the QuickJS realm

async fn runs_typescript_returns_values_and_captures_bounded_console_output() {
    let Run { report, .. } = run(
        "const xs: number[] = [1, 2, 3]; console.log(\"sum\", xs.reduce((a, b) => a + b)); console.warn({ ok: true }); return { n: xs.length };",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(report.status, "completed");
    assert_eq!(value(&report), json!({ "n": 3 }));
    assert_eq!(report.console, "sum 6\n[warn] {\"ok\":true}\n");
    let flood = run(
        "for (let i = 0; i < 100000; i++) console.log(\"x\".repeat(100)); return 1;",
        vec![],
        Options::default(),
    )
    .await;
    assert!(flood.report.console_truncated);
    assert!(flood.report.console.len() <= budgets::CONSOLE_BYTES);
}

async fn strings_are_returned_as_is_and_undefined_returns_nothing() {
    let text = run("return \"a\\nb\";", vec![], Options::default()).await;
    assert!(text.report.value_is_string);
    assert_eq!(text.report.value.as_deref(), Some("a\nb"));
    assert_eq!(
        run("let x = 1;", vec![], Options::default())
            .await
            .report
            .value,
        None
    );
    // A lone surrogate cannot leave the realm as UTF-8: it arrives replaced.
    let lone = run("return '\\ud800x';", vec![], Options::default()).await;
    assert_eq!(lone.report.value.as_deref(), Some("\u{fffd}x"));
}

async fn has_no_ambient_authority() {
    let Run { report, .. } = run(
        "return [typeof Bun, typeof process, typeof globalThis.require, typeof fetch,
      typeof setTimeout, typeof WebAssembly, typeof __ptc, typeof __call, typeof Deno,
      typeof globalThis.__ptc, (() => {}).constructor('return typeof process')(),
      Object.constructor('return typeof Bun')(),
      Function('return typeof globalThis.__ptc')()];",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!(vec!["undefined"; 13]));
    let imported = run(
        "try { await import(\"node:fs\"); return \"loaded\"; } catch (e) { return \"refused\"; }",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(value(&imported.report), json!("refused"));
}

async fn the_sdk_object_cannot_be_replaced_or_extended() {
    let Run { report, .. } = run(
        "
      const sdk = () => (globalThis as any)[\"to\" + \"ols\"];
      const before = Object.keys(sdk()).sort();
      try { sdk().read = () => 'forged'; } catch {}
      try { sdk().evil = 1; } catch {}
      try { (globalThis as any)[\"to\" + \"ols\"] = {}; } catch {}
      try { Object.defineProperty(globalThis, \"to\" + \"ols\", { value: {} }); } catch {}
      try { (Object.prototype as any).call = () => 'polluted'; } catch {}
      return { frozen: Object.isFrozen(sdk()), before, after: Object.keys(sdk()).sort(),
        proto: Object.getPrototypeOf(sdk()), text: (await tools.read({})).text };",
        vec![(
            "read",
            handler(|call: BrokerCall| async move { ok(&call, "real") }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(
        value(&report),
        json!({ "frozen": true, "before": ["call", "par", "read"],
            "after": ["call", "par", "read"], "proto": null, "text": "real" })
    );
}

async fn dispatch_outside_the_manifest_is_refused_at_run_time() {
    let Run { report, calls } = run(
        "const t = (globalThis as any)[\"to\" + \"ols\"];
       const results = [];
       for (const name of ['bash', 'constructor', '__proto__', 'toString', 'ptc', 'ptc_docs', 'code'])
         results.push((await t.call(name, {})).error.code);
       try { await t.call(42, {}); } catch (e) { results.push(e.code); }
       return results;",
        vec![],
        Options::default(),
    )
    .await;
    let mut expected = vec!["CapabilityUnavailable"; 7];
    expected.push("InvalidArguments");
    assert_eq!(value(&report), json!(expected));
    assert!(calls.borrow().is_empty());
}

async fn malformed_bridge_input_becomes_typed_errors() {
    let Run { report, calls } = run(
        &format!(
            "const out = [];
       out.push((await tools.call(\"echo\", [1, 2])).error.code);
       out.push((await tools.call(\"echo\", \"text\")).error.code);
       out.push((await tools.call(\"echo\", null)).error.code);
       try {{ await tools.call(\"echo\", {{ big: 1n }}); }} catch (e) {{ out.push(e.code); }}
       const cyclic: any = {{}}; cyclic.self = cyclic;
       try {{ await tools.echo(cyclic); }} catch (e) {{ out.push(e.code); }}
       out.push((await tools.call(\"echo\", {{ s: \"x\".repeat({}) }})).error.code);
       out.push((await tools.call(\"echo\", {{ fn: () => 1, u: undefined }})).data.text);
       return out;",
            budgets::ARGS_BYTES
        ),
        vec![("echo", echo())],
        Options::default(),
    )
    .await;
    assert_eq!(
        value(&report),
        json!([
            "InvalidArguments",
            "InvalidArguments",
            "InvalidArguments",
            "InvalidArguments",
            "InvalidArguments",
            "QuotaExceeded",
            "{}"
        ])
    );
    assert_eq!(*calls.borrow(), ["echo"]);
}

// --- SDK semantics

async fn convenience_calls_throw_ptc_errors_and_call_returns_envelopes() {
    let Run { report, .. } = run(
        "const raw = await tools.call(\"fail\", {});
       try { await tools.fail({}); return \"no throw\"; }
       catch (e) { return { raw: raw.ok, code: e.code, name: e.name, outcome: e.outcome,
         op: typeof e.operationId, isPtc: e instanceof PtcError, message: e.message }; }",
        vec![(
            "fail",
            handler(|call: BrokerCall| async move {
                failure(&call, "ApprovalDenied", "no", "not_started")
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(
        value(&report),
        json!({ "raw": false, "code": "ApprovalDenied", "name": "ApprovalDenied",
            "outcome": "not_started", "op": "string", "isPtc": true, "message": "no" })
    );
}

async fn an_uncaught_ptc_error_fails_the_execution_with_its_code() {
    let denied = run(
        "await tools.fail({});",
        vec![(
            "fail",
            handler(|call: BrokerCall| async move {
                failure(&call, "ApprovalDenied", "declined", "not_started")
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(denied.report.status, "failed");
    assert_eq!(
        denied.report.error,
        Some(("ApprovalDenied".to_owned(), "declined".to_owned()))
    );
    let thrown = run("throw new TypeError(\"boom\");", vec![], Options::default()).await;
    assert_eq!(code_of(&thrown.report), "ScriptError");
    assert!(message_of(&thrown.report).contains("TypeError: boom"));
    let forged = run(
        "throw new PtcError({ code: \"Root\", message: \"x\" });",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(code_of(&forged.report), "ScriptError");
    let number = run("throw 42;", vec![], Options::default()).await;
    assert_eq!(
        number.report.error,
        Some(("ScriptError".to_owned(), "Uncaught 42".to_owned()))
    );
}

async fn par_keeps_order_bounds_concurrency_and_validates_its_options() {
    let in_flight = Rc::new(Cell::new(0));
    let peak = Rc::new(Cell::new(0));
    let (flight, top) = (in_flight.clone(), peak.clone());
    let Run { report, .. } = run(
        "return await tools.par([1, 2, 3, 4, 5, 6], async (n) => Number((await tools.slow({ n })).text), { concurrency: 2 });",
        vec![(
            "slow",
            handler(move |call: BrokerCall| {
                let (flight, top) = (flight.clone(), top.clone());
                async move {
                    flight.set(flight.get() + 1);
                    top.set(top.get().max(flight.get()));
                    let n = call.args["n"].as_u64().unwrap();
                    sleep(5 * (7 - n)).await;
                    flight.set(flight.get() - 1);
                    ok(&call, &(n * 10).to_string())
                }
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!([10, 20, 30, 40, 50, 60]));
    assert_eq!(peak.get(), 2);
    for bad in ["0", "9", "1.5", "\"2\""] {
        let result = run(
            &format!(
                "try {{ await tools.par([1], async () => 1, {{ concurrency: {bad} }}); }} catch (e) {{ return e.code; }}"
            ),
            vec![],
            Options::default(),
        )
        .await;
        assert_eq!(value(&result.report), json!("InvalidArguments"), "{bad}");
    }
    let not_array = run(
        "try { await tools.par(\"ab\", async () => 1); } catch (e) { return e.code; }",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(value(&not_array.report), json!("InvalidArguments"));
}

async fn a_failing_par_item_cancels_in_flight_siblings_and_joins_them() {
    let started = Rc::new(RefCell::new(Vec::new()));
    let signals = Rc::new(RefCell::new(Vec::<AbortSignal>::new()));
    let joined = Rc::new(Cell::new(0));
    let (seen, kept, done) = (started.clone(), signals.clone(), joined.clone());
    let Run { report, .. } = run(
        "try {
         await tools.par([1, 2, 3, 4, 5], async (n) => (await tools.step({ n })).text, { concurrency: 2 });
       } catch (e) { return { code: e.code, message: e.message }; }",
        vec![(
            "step",
            handler(move |call: BrokerCall| {
                let (seen, kept, done) = (seen.clone(), kept.clone(), done.clone());
                async move {
                    let n = call.args["n"].as_u64().unwrap();
                    seen.borrow_mut().push(n);
                    if n == 1 {
                        sleep(10).await;
                        return failure(&call, "OperationFailed", "step 1 failed", "failed");
                    }
                    kept.borrow_mut().push(call.signal.clone());
                    call.signal.cancelled().await;
                    done.set(done.get() + 1);
                    failure(&call, "Cancelled", "cancelled", "cancelled")
                }
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(
        value(&report),
        json!({ "code": "OperationFailed", "message": "step 1 failed" })
    );
    let mut started = started.borrow().clone();
    started.sort();
    assert_eq!(started, [1, 2]);
    assert!(signals.borrow().iter().all(AbortSignal::aborted));
    assert_eq!(joined.get(), 1);
    assert_eq!(
        (
            report.summary.total,
            report.summary.failed,
            report.summary.cancelled,
            report.summary.unknown
        ),
        (2, 1, 1, 0)
    );
    let par: Vec<&Value> = report
        .trace
        .iter()
        .filter(|node| node["type"] == "par")
        .map(|node| &node["status"])
        .collect();
    assert_eq!(par, [&json!("running"), &json!("failed")]);
}

/// Resolves after 60 ms, or as cancelled when aborted first.
fn slow_or_cancelled(aborted: Rc<RefCell<Vec<String>>>) -> Handler {
    handler(move |call: BrokerCall| {
        let aborted = aborted.clone();
        async move {
            let tag = call.args["tag"].as_str().unwrap_or_default().to_owned();
            tokio::select! {
                () = sleep(60) => ok(&call, &format!("{tag} done")),
                () = call.signal.cancelled() => {
                    aborted.borrow_mut().push(tag);
                    failure(&call, "Cancelled", "cancelled", "cancelled")
                }
            }
        }
    })
}

fn failing_after(ms: u64, message: &'static str) -> Handler {
    handler(move |call: BrokerCall| async move {
        sleep(ms).await;
        failure(&call, "OperationFailed", message, "failed")
    })
}

async fn a_failing_par_cancels_only_its_own_operations() {
    let aborted = Rc::new(RefCell::new(Vec::new()));
    let Run { report, .. } = run(
        "const outside = tools.slow({ tag: 'outside' });
       const sibling = tools.par([1], async () => (await tools.slow({ tag: 'sibling-par' })).text);
       const failing = tools.par([1, 2], async (n) => n === 1 ? tools.bad({}) : tools.slow({ tag: 'inside' }));
       let code;
       try { await failing; } catch (e) { code = e.code; }
       return [code, (await outside).text, (await sibling)[0]];",
        vec![
            ("slow", slow_or_cancelled(aborted.clone())),
            ("bad", failing_after(10, "bad")),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        value(&report),
        json!(["OperationFailed", "outside done", "sibling-par done"])
    );
    assert_eq!(*aborted.borrow(), ["inside"]);
    // The trace parents follow ownership.
    let parents: Vec<&Value> = report
        .trace
        .iter()
        .filter(|node| node["type"] == "par" && node["status"] == "running")
        .map(|node| &node["parentNodeId"])
        .collect();
    assert_eq!(parents, [&json!("exec:root"), &json!("exec:root")]);
}

/// Records its tag and finishes after 30 ms whatever happens, like a tool
/// past the point of no return.
fn stubborn(started: Rc<RefCell<Vec<String>>>) -> Handler {
    handler(move |call: BrokerCall| {
        let started = started.clone();
        async move {
            started
                .borrow_mut()
                .push(call.args["tag"].as_str().unwrap_or_default().to_owned());
            sleep(30).await;
            ok(&call, "ok")
        }
    })
}

async fn after_a_par_fails_its_siblings_cannot_start_new_operations() {
    let started = Rc::new(RefCell::new(Vec::new()));
    let Run { report, .. } = run(
        "try {
         await tools.par([1, 2], async (n) => {
           if (n === 1) { await tools.fail({}); return; }
           await tools.step({ tag: 'first' });
           await tools.step({ tag: 'second' });
         });
       } catch (e) { return e.code; }",
        vec![
            ("fail", failing_after(5, "x")),
            ("step", stubborn(started.clone())),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!("OperationFailed"));
    assert_eq!(*started.borrow(), ["first"]);
    let refused = report
        .operations
        .iter()
        .find(|operation| operation.error_code == Some("Cancelled"))
        .unwrap();
    assert_eq!(
        (refused.capability.as_str(), refused.outcome),
        ("step", "not_started")
    );
}

async fn writes_take_one_slot_at_a_time_also_outside_par() {
    let writing = Rc::new(Cell::new(0));
    let overlap = Rc::new(Cell::new(false));
    let (busy, overlapped) = (writing.clone(), overlap.clone());
    let Run { report, .. } = run(
        "await Promise.all([tools.write({ n: 1 }), tools.write({ n: 2 }), tools.write({ n: 3 }), tools.read({})]); return \"done\";",
        vec![
            (
                "write",
                handler(move |call: BrokerCall| {
                    let (busy, overlapped) = (busy.clone(), overlapped.clone());
                    async move {
                        if busy.get() > 0 {
                            overlapped.set(true);
                        }
                        busy.set(busy.get() + 1);
                        sleep(5).await;
                        busy.set(busy.get() - 1);
                        ok(&call, "w")
                    }
                }),
            ),
            (
                "read",
                handler(|call: BrokerCall| async move { ok(&call, "r") }),
            ),
        ],
        Options {
            writes: vec!["write"],
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "completed");
    assert!(!overlap.get());
}

// --- quotas

async fn calls_past_the_in_flight_limit_wait_their_turn() {
    let running = Rc::new(Cell::new(0));
    let peak = Rc::new(Cell::new(0));
    let (now, top) = (running.clone(), peak.clone());
    let Run { report, .. } = run(
        "const results = await Promise.allSettled(Array.from({ length: 10 }, () => tools.wait({})));
       const nested = await tools.par([1, 2], async () => tools.par([1, 2, 3], () => tools.wait({})));
       return [results.map((r) => r.status), nested.flat().length];",
        vec![(
            "wait",
            handler(move |call: BrokerCall| {
                let (now, top) = (now.clone(), top.clone());
                async move {
                    now.set(now.get() + 1);
                    top.set(top.get().max(now.get()));
                    sleep(20).await;
                    now.set(now.get() - 1);
                    ok(&call, "done")
                }
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!([vec!["fulfilled"; 10], 6]));
    assert_eq!(peak.get(), budgets::CONCURRENT_OPERATIONS);
    assert_eq!(
        (
            report.summary.total,
            report.summary.completed,
            report.summary.not_started
        ),
        (16, 16, 0)
    );
}

async fn the_call_quota_counts_every_reservation() {
    let Run { report, calls } = run(
        &format!(
            "const codes = [];
       for (let i = 0; i < {}; i++) {{
         const r = await tools.call(\"echo\", {{ i }});
         if (!r.ok) codes.push(r.error.code);
       }}
       return codes;",
            budgets::INTERNAL_CALLS + 5
        ),
        vec![("echo", echo())],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!(vec!["QuotaExceeded"; 5]));
    assert_eq!(calls.borrow().len(), budgets::INTERNAL_CALLS);
    assert_eq!(report.summary.total, budgets::INTERNAL_CALLS + 5);
}

async fn a_script_that_keeps_calling_past_the_quota_is_stopped() {
    let Run { report, calls } = run(
        "for (;;) await tools.call(\"echo\", {});",
        vec![("echo", echo())],
        Options::default(),
    )
    .await;
    assert_eq!(report.status, "failed");
    assert_eq!(code_of(&report), "QuotaExceeded");
    assert_eq!(calls.borrow().len(), budgets::INTERNAL_CALLS);
    assert!(report.operations.len() <= budgets::INTERNAL_CALLS + 20);
    assert!(report.summary.total > budgets::INTERNAL_CALLS + 20);
    assert_eq!(
        report.summary.not_started,
        report.summary.total - budgets::INTERNAL_CALLS
    );
    let size: usize = report.trace.iter().map(|node| node.to_string().len()).sum();
    assert!(size < 512 * 1024);
}

async fn par_calls_are_bounded_too() {
    let Run { report, .. } = run(
        "let n = 0;
      try { for (;;) { await tools.par([], async () => 1); n++; } }
      catch (e) { return [n, e.code]; }",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(
        value(&report),
        json!([budgets::PAR_SCOPES, "QuotaExceeded"])
    );
}

async fn a_par_left_running_after_its_parent_closed_keeps_its_own_scope() {
    let started = Rc::new(RefCell::new(Vec::new()));
    let Run { report, .. } = run(
        "let inner;
       await tools.par([1], async () => {
         inner = tools.par([1, 2], async (n) => {
           if (n === 1) { await tools.fail({}); return; }
           await tools.step({ tag: 'first' });
           await tools.step({ tag: 'after' });
         });
       });
       try { await inner; } catch (e) { return e.code; }",
        vec![
            ("fail", failing_after(5, "x")),
            ("step", stubborn(started.clone())),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!("OperationFailed"));
    assert_eq!(*started.borrow(), ["first"]);
    assert!(
        report
            .trace
            .iter()
            .filter(|node| node["type"] == "operation")
            .all(|node| node["parentNodeId"] == "exec:par2")
    );
}

async fn oversized_results_are_refused_but_still_count_as_completed() {
    let Run { report, .. } = run(
        "const r = await tools.call(\"big\", {}); return [r.ok, r.error.code, r.error.outcome];",
        vec![(
            "big",
            handler(|call: BrokerCall| async move {
                ok(&call, &"x".repeat(budgets::RESULT_BYTES + 10))
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(value(&report), json!([false, "QuotaExceeded", "completed"]));
    assert_eq!(report.summary.completed, 1);
}

// --- crashes, timeouts and cancellation

async fn a_runaway_loop_is_interrupted_by_the_budget() {
    let started = Instant::now();
    let Run { report, .. } = run(
        "for (;;) { try { for (;;) {} } catch {} }",
        vec![],
        Options {
            timeout: Some(Duration::from_millis(300)),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "timed_out");
    assert_eq!(code_of(&report), "Timeout");
    assert!(started.elapsed() < Duration::from_secs(5));
}

async fn a_caught_out_of_memory_still_interrupts_a_busy_script() {
    let started = Instant::now();
    let Run { report, .. } = run(
        "try { const a = []; for (;;) a.push(\"x\".repeat(1 << 20) + a.length); } catch (_) {} for (;;) {}",
        vec![],
        Options {
            timeout: Some(Duration::from_millis(5_000)),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "failed", "{}", message_of(&report));
    assert!(
        message_of(&report).to_lowercase().contains("out of memory"),
        "{}",
        message_of(&report)
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

async fn memory_exhaustion_and_stack_overflow_end_the_script_not_the_host() {
    let memory = run(
        "const a = []; for (;;) a.push(\"x\".repeat(1 << 20) + a.length);",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(memory.report.status, "failed");
    let message = message_of(&memory.report).to_lowercase();
    assert!(
        message.contains("memory")
            || message.contains("rangeerror")
            || message.contains("internalerror"),
        "{message}"
    );
    let stack = run(
        "const f = (n: number): number => f(n + 1) + 1; return f(0);",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(stack.report.status, "failed");
    // The host still runs the next execution normally.
    assert_eq!(
        value(
            &run("return 2 + 2;", vec![], Options::default())
                .await
                .report
        ),
        json!(4)
    );
}

/// One guest process driven by hand: the `start` line for `code`, then
/// stdin closed after `close_after` lines of output (or at once). Its
/// output lines, stderr and exit status.
fn guest_alone(code: &str, close_after: usize) -> (Vec<Value>, String, std::process::ExitStatus) {
    use std::io::{BufRead, Write};
    let compiled = preflight(code).unwrap_or_else(|e| panic!("{code}: {}", e.message));
    let command = guest();
    let mut child = std::process::Command::new(&command[0])
        .args(&command[1..])
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let start = json!({ "type": "start", "code": compiled.js,
        "manifest": compiled.manifest, "store": "{}" });
    writeln!(stdin, "{start}").unwrap();
    let mut stdin = Some(stdin);
    if close_after == 0 {
        stdin = None;
    }
    let mut lines = Vec::new();
    for line in std::io::BufReader::new(child.stdout.take().unwrap()).lines() {
        lines.push(serde_json::from_str::<Value>(&line.unwrap()).unwrap());
        if lines.len() == close_after {
            stdin = None;
        }
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    (lines, stderr, output.status)
}

/// quickjs-ng asserts in `JS_FreeRuntime` when objects outlive the realm:
/// the guest used to abort (SIGABRT, a crash report on macOS) after every
/// `done`, as its host functions and their state held each other through
/// the realm. Whatever the script did, the guest now reports, tears down
/// and exits cleanly, and the host sees the same result.
async fn the_guest_tears_down_cleanly_after_any_outcome() {
    for (code, expected) in [
        ("return 1;", "\"ok\":true"),
        ("throw new Error(\"x\");", "Error: x"),
        ("throw null;", "Uncaught null"),
        (
            "const a = []; for (;;) a.push(\"x\".repeat(1 << 20) + a.length);",
            "out of memory",
        ),
        (
            "const a = []; for (;;) a.push({ x: [1, 2, 3] });",
            "\"ok\":false",
        ),
        (
            "const f = (n: number): number => f(n + 1) + 1; return f(0);",
            "\"ok\":false",
        ),
        // A call the script never awaited is still pending at the end.
        ("void tools.never({}); return 1;", "\"ok\":true"),
    ] {
        let (lines, stderr, status) = guest_alone(code, 1);
        let done = lines
            .iter()
            .find(|line| line["type"] == "done")
            .unwrap_or_else(|| panic!("{code}: no done in {lines:?}"));
        assert!(
            done["outcome"].to_string().contains(expected),
            "{code}: {done}"
        );
        assert!(status.success(), "{code}: {status:?}, stderr: {stderr}");
        assert!(stderr.is_empty(), "{code}: {stderr}");
    }
    // The host goes away while a call is pending: no `done`, a clean exit.
    let (lines, stderr, status) = guest_alone("return await tools.never({});", 1);
    assert_eq!(lines[0]["type"], "call", "{lines:?}");
    assert!(lines.iter().all(|line| line["type"] != "done"), "{lines:?}");
    assert!(status.success(), "{status:?}, stderr: {stderr}");
    assert!(stderr.is_empty(), "{stderr}");
    // Through the host, an out-of-memory script fails with that reason.
    let memory = run(
        "const a = []; for (;;) a.push(\"x\".repeat(1 << 20) + a.length);",
        vec![],
        Options::default(),
    )
    .await;
    assert_eq!(memory.report.status, "failed");
    assert!(
        message_of(&memory.report).contains("out of memory"),
        "{}",
        message_of(&memory.report)
    );
}

async fn a_crash_after_side_effects_still_reports_them() {
    let Run { report, .. } = run(
        "await tools.write({}); await tools.write({}); null.boom;",
        vec![(
            "write",
            handler(|call: BrokerCall| async move { ok(&call, "written") }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(report.status, "failed");
    assert_eq!((report.summary.total, report.summary.completed), (2, 2));
    assert!(
        report
            .operations
            .iter()
            .all(|operation| operation.delivered)
    );
}

async fn cancellation_aborts_in_flight_operations_and_ignores_late_results() {
    let controller = AbortController::new();
    let signal = controller.signal();
    let seen = Rc::new(RefCell::new(None::<AbortSignal>));
    let kept = seen.clone();
    let Run { report, .. } = run(
        "await tools.read({}); await tools.slow({}); return \"unreachable\";",
        vec![
            (
                "read",
                handler(|call: BrokerCall| async move { ok(&call, "r") }),
            ),
            (
                "slow",
                handler(move |call: BrokerCall| {
                    let (kept, controller) = (kept.clone(), controller.clone());
                    async move {
                        *kept.borrow_mut() = Some(call.signal.clone());
                        tokio::task::spawn_local(async move { controller.abort() });
                        call.signal.cancelled().await;
                        sleep(20).await;
                        ok(&call, "finished after cancel")
                    }
                }),
            ),
        ],
        Options {
            signal: Some(signal),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "cancelled");
    assert_eq!(code_of(&report), "Cancelled");
    assert!(seen.borrow().as_ref().unwrap().aborted());
    assert_eq!(report.value, None);
    // The slow operation finished anyway: an effect the script never saw.
    let slow = report
        .operations
        .iter()
        .find(|operation| operation.capability == "slow")
        .unwrap();
    assert_eq!((slow.outcome, slow.delivered), ("completed", false));
}

async fn operations_that_never_settle_are_reported_with_unknown_outcome() {
    let Run { report, .. } = run(
        "await tools.hang({});",
        vec![(
            "hang",
            handler(|_call: BrokerCall| async move { std::future::pending::<Value>().await }),
        )],
        Options {
            timeout: Some(Duration::from_millis(200)),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "timed_out");
    assert_eq!(
        (
            report.summary.total,
            report.summary.unknown,
            report.summary.running
        ),
        (1, 1, 0)
    );
}

async fn an_operation_the_script_never_awaited_is_cancelled_and_reported() {
    let Run { report, .. } = run(
        "tools.write({}); return \"returned early\";",
        vec![(
            "write",
            handler(|call: BrokerCall| async move {
                call.signal.cancelled().await;
                failure(&call, "Cancelled", "cancelled", "unknown")
            }),
        )],
        Options::default(),
    )
    .await;
    assert_eq!(report.status, "completed");
    assert_eq!(report.operations.len(), 1);
    let write = &report.operations[0];
    assert_eq!(
        (write.capability.as_str(), write.outcome, write.delivered),
        ("write", "unknown", false)
    );
}

/// `onHumanWait` that reports a human being asked at once (when `waiting`).
fn human_waiting(waiting: bool) -> OnHumanWait {
    Box::new(move |listener: Rc<dyn Fn(bool)>| {
        if waiting {
            listener(true);
        }
        Box::new(|| {})
    })
}

async fn cancellation_stops_a_busy_script_at_once_even_while_a_human_is_asked() {
    for waiting in [false, true] {
        let controller = AbortController::new();
        let signal = controller.signal();
        tokio::task::spawn_local(async move {
            sleep(200).await;
            controller.abort();
        });
        let started = Instant::now();
        let Run { report, .. } = run(
            "for (;;) {}",
            vec![],
            Options {
                signal: Some(signal),
                timeout: Some(Duration::from_millis(60_000)),
                on_human_wait: Some(human_waiting(waiting)),
                ..Options::default()
            },
        )
        .await;
        assert_eq!(report.status, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

/// Whether a process exists (signal 0).
fn alive(pid: u32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}

async fn a_stopped_script_process_is_gone_even_mid_regex() {
    let pids = Rc::new(RefCell::new(Vec::new()));
    let mut statuses = Vec::new();
    for (by, code) in [
        ("cancel", "for (;;) {}"),
        ("timeout", "for (;;) {}"),
        ("timeout", "return /^(a+)+$/.test('a'.repeat(60) + 'b');"),
    ] {
        let controller = AbortController::new();
        let signal = controller.signal();
        if by == "cancel" {
            tokio::task::spawn_local(async move {
                sleep(200).await;
                controller.abort();
            });
        }
        let seen = pids.clone();
        let Run { report, .. } = run(
            code,
            vec![],
            Options {
                signal: Some(signal),
                timeout: Some(Duration::from_millis(if by == "timeout" {
                    200
                } else {
                    60_000
                })),
                on_process: Some(Box::new(move |pid| {
                    // The script's process gets no environment and `/` as its
                    // directory (readable through `/proc` on Linux only). It
                    // is reported right after the fork: until its `exec` it
                    // still shows the test's own environment, so wait for
                    // that (or give up after 2 s and let the asserts say why).
                    if cfg!(target_os = "linux") {
                        let probe = || {
                            (
                                std::fs::read(format!("/proc/{pid}/environ")).unwrap(),
                                std::fs::read_link(format!("/proc/{pid}/cwd")).unwrap(),
                            )
                        };
                        let mut state = probe();
                        for _ in 0..400 {
                            if state.0.is_empty() && state.1 == std::path::Path::new("/") {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                            state = probe();
                        }
                        let (environ, cwd) = state;
                        assert!(environ.is_empty(), "{}", String::from_utf8_lossy(&environ));
                        assert_eq!(cwd, std::path::Path::new("/"));
                    }
                    seen.borrow_mut().push(pid);
                })),
                ..Options::default()
            },
        )
        .await;
        statuses.push(report.status);
    }
    assert_eq!(statuses, ["cancelled", "timed_out", "timed_out"]);
    // Each script ran in its own process, and every one of them is gone.
    assert_eq!(pids.borrow().len(), 3);
    assert!(pids.borrow().iter().all(|pid| !alive(*pid)));
}

async fn a_stale_idle_report_cannot_pause_the_budget_of_a_busy_script() {
    let started = Instant::now();
    let Run { report, .. } = run(
        "await tools.fast({}); await tools.fast({}); await tools.par([1, 2, 3], async () => tools.fast({})); for (;;) {}",
        vec![(
            "fast",
            handler(|call: BrokerCall| async move { ok(&call, "x") }),
        )],
        Options {
            timeout: Some(Duration::from_millis(300)),
            on_human_wait: Some(human_waiting(true)),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "timed_out");
    assert!(started.elapsed() < Duration::from_secs(3));
}

async fn a_script_computing_while_a_human_is_asked_still_spends_its_budget() {
    let started = Instant::now();
    let Run { report, .. } = run(
        "for (;;) {}",
        vec![],
        Options {
            timeout: Some(Duration::from_millis(200)),
            on_human_wait: Some(human_waiting(true)),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "timed_out");
    assert!(started.elapsed() < Duration::from_secs(2));
}

type Listener = Rc<RefCell<Option<Rc<dyn Fn(bool)>>>>;

/// `onHumanWait` that keeps the listener for the test to call.
fn kept_listener(slot: &Listener) -> OnHumanWait {
    let slot = slot.clone();
    Box::new(move |listener: Rc<dyn Fn(bool)>| {
        *slot.borrow_mut() = Some(listener);
        Box::new(|| {})
    })
}

fn tell(slot: &Listener, waiting: bool) {
    let listener = slot.borrow().clone();
    if let Some(listener) = listener {
        listener(waiting);
    }
}

async fn a_wait_still_open_at_the_end_is_counted_and_no_progress_follows() {
    let controller = AbortController::new();
    let signal = controller.signal();
    let ended = Rc::new(Cell::new(false));
    let after_end = Rc::new(Cell::new(false));
    let slot: Listener = Rc::new(RefCell::new(None));
    let (listener, done) = (slot.clone(), ended.clone());
    let (seen_end, flagged) = (ended.clone(), after_end.clone());
    let Run { report, .. } = run(
        "await tools.ask({});",
        vec![(
            "ask",
            handler(move |call: BrokerCall| {
                let (listener, done, controller) =
                    (listener.clone(), done.clone(), controller.clone());
                async move {
                    // Start the wait when the operation asks, not before
                    // guest startup.
                    tell(&listener, true);
                    tokio::task::spawn_local(async move {
                        sleep(300).await;
                        controller.abort();
                        done.set(true);
                    });
                    call.signal.cancelled().await;
                    sleep(20).await;
                    ok(&call, "late")
                }
            }),
        )],
        Options {
            signal: Some(signal),
            on_human_wait: Some(kept_listener(&slot)),
            on_progress: Some(Rc::new(move |_| {
                if seen_end.get() {
                    flagged.set(true);
                }
            })),
            ..Options::default()
        },
    )
    .await;
    sleep(50).await;
    assert_eq!(report.status, "cancelled");
    assert!(report.waited_ms >= 250, "{}", report.waited_ms);
    assert!(!after_end.get());
}

async fn time_spent_waiting_for_a_human_does_not_count_against_the_budget() {
    let slot: Listener = Rc::new(RefCell::new(None));
    let listener = slot.clone();
    let Run { report, .. } = run(
        "return (await tools.ask({})).text;",
        vec![(
            "ask",
            handler(move |call: BrokerCall| {
                let listener = listener.clone();
                async move {
                    tell(&listener, true);
                    sleep(400).await;
                    tell(&listener, false);
                    ok(&call, "answered")
                }
            }),
        )],
        Options {
            timeout: Some(Duration::from_millis(250)),
            on_human_wait: Some(kept_listener(&slot)),
            ..Options::default()
        },
    )
    .await;
    assert_eq!(report.status, "completed");
    assert_eq!(report.value.as_deref(), Some("answered"));
    assert!(report.waited_ms >= 350, "{}", report.waited_ms);
}

async fn the_store_is_kept_only_from_a_completed_script() {
    let execute_with = |code: &str, store: &str| {
        let compiled = preflight(code).unwrap();
        execute(ExecutionOptions {
            code: compiled.js,
            broker: Rc::new(FakeBroker {
                manifest: Vec::new(),
                writes: Vec::new(),
                handlers: HashMap::new(),
                calls: Rc::new(RefCell::new(Vec::new())),
            }),
            signal: AbortSignal::never(),
            timeout: Duration::from_secs(10),
            turn_id: "turn".to_owned(),
            execution_id: "exec".to_owned(),
            on_human_wait: None,
            attach: None,
            on_progress: None,
            store: Some(store.to_owned()),
            guest: guest(),
            on_process: None,
        })
    };
    let kept = execute_with("store('a', { b: [1] }); return load('x');", "{\"x\":2}").await;
    assert_eq!(kept.store.as_deref(), Some("{\"x\":2,\"a\":{\"b\":[1]}}"));
    assert_eq!(kept.value.as_deref(), Some("2"));
    assert!(kept.store_read);
    let unread = execute_with("return 1;", "{\"x\":2}").await;
    assert_eq!(unread.store, None);
    assert!(!unread.store_read);
    let failed = execute_with("store('a', 1); throw new Error('no');", "{}").await;
    assert_eq!(failed.store, None);
    // A failed script that loaded may still carry what it loaded.
    let loaded = execute_with("load('x'); throw new Error('no');", "{}").await;
    assert!(loaded.store_read);
}

type Test = (&'static str, fn() -> Pin<Box<dyn Future<Output = ()>>>);

macro_rules! tests {
    ($($name:ident),* $(,)?) => {
        [$((stringify!($name), (|| Box::pin($name()) as Pin<Box<dyn Future<Output = ()>>>) as fn() -> _)),*]
    };
}

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("ptc-guest") {
        return pirc_ptc::guest::run();
    }
    let filter: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .collect();
    let tests: Vec<Test> = tests![
        runs_typescript_returns_values_and_captures_bounded_console_output,
        strings_are_returned_as_is_and_undefined_returns_nothing,
        has_no_ambient_authority,
        the_sdk_object_cannot_be_replaced_or_extended,
        dispatch_outside_the_manifest_is_refused_at_run_time,
        malformed_bridge_input_becomes_typed_errors,
        convenience_calls_throw_ptc_errors_and_call_returns_envelopes,
        an_uncaught_ptc_error_fails_the_execution_with_its_code,
        par_keeps_order_bounds_concurrency_and_validates_its_options,
        a_failing_par_item_cancels_in_flight_siblings_and_joins_them,
        a_failing_par_cancels_only_its_own_operations,
        after_a_par_fails_its_siblings_cannot_start_new_operations,
        writes_take_one_slot_at_a_time_also_outside_par,
        calls_past_the_in_flight_limit_wait_their_turn,
        the_call_quota_counts_every_reservation,
        a_script_that_keeps_calling_past_the_quota_is_stopped,
        par_calls_are_bounded_too,
        a_par_left_running_after_its_parent_closed_keeps_its_own_scope,
        oversized_results_are_refused_but_still_count_as_completed,
        a_runaway_loop_is_interrupted_by_the_budget,
        a_caught_out_of_memory_still_interrupts_a_busy_script,
        memory_exhaustion_and_stack_overflow_end_the_script_not_the_host,
        the_guest_tears_down_cleanly_after_any_outcome,
        a_crash_after_side_effects_still_reports_them,
        cancellation_aborts_in_flight_operations_and_ignores_late_results,
        operations_that_never_settle_are_reported_with_unknown_outcome,
        an_operation_the_script_never_awaited_is_cancelled_and_reported,
        cancellation_stops_a_busy_script_at_once_even_while_a_human_is_asked,
        a_stopped_script_process_is_gone_even_mid_regex,
        a_stale_idle_report_cannot_pause_the_budget_of_a_busy_script,
        a_script_computing_while_a_human_is_asked_still_spends_its_budget,
        a_wait_still_open_at_the_end_is_counted_and_no_progress_follows,
        time_spent_waiting_for_a_human_does_not_count_against_the_budget,
        the_store_is_kept_only_from_a_completed_script,
    ]
    .into_iter()
    .collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failed = Vec::new();
    let mut ran = 0;
    for (name, test) in tests {
        if !filter.is_empty() && !filter.iter().any(|f| name.contains(f.as_str())) {
            continue;
        }
        ran += 1;
        let started = Instant::now();
        let local = tokio::task::LocalSet::new();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(local.run_until(test()));
        }));
        let took = started.elapsed().as_millis();
        match outcome {
            Ok(()) => println!("test {name} ... ok ({took} ms)"),
            Err(_) => {
                println!("test {name} ... FAILED ({took} ms)");
                failed.push(name);
            }
        }
    }
    println!(
        "\ntest result: {}. {} passed; {} failed",
        if failed.is_empty() { "ok" } else { "FAILED" },
        ran - failed.len(),
        failed.len()
    );
    if failed.is_empty() {
        std::process::ExitCode::SUCCESS
    } else {
        for name in failed {
            println!("    {name}");
        }
        std::process::ExitCode::FAILURE
    }
}
