//! One `ptc` execution (`agent/ptc/runtime.ts`; docs/architecture/ptc.md):
//! the host side.
//!
//! The script runs in a QuickJS realm in a `ptc-guest` child process
//! (`pirc_ptc::guest`), started with an empty environment inside the
//! agent's OS sandbox. The agent stays responsive (dialogs are answered
//! meanwhile), and cancellation or the active-time budget ends the script
//! with SIGKILL, whatever it is doing — QuickJS cannot interrupt a
//! backtracking regular expression. JSON lines over the child's stdin and
//! stdout are the only bridge (`pirc_ptc::protocol`).
//!
//! Every operation goes through the [`Broker`], which applies the agent's
//! normal validation, hooks, auto mode and authorization. This side owns
//! the bookkeeping: quotas are reserved before an operation starts, records
//! live here (so the completion summary survives a crashed, cancelled or
//! killed script), and a stopped execution never resumes from a late
//! result.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::process::Stdio;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use pirc_ptc::contracts::{CONTRACT_VERSION, ERROR_CODES, PtcError, budgets, error_code, outcome};
use pirc_ptc::protocol::{ROOT_SCOPE, guest_limits, head16, len16, well_formed_json};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc};

use crate::LocalBoxFuture;
use crate::signal::{AbortController, AbortSignal};
use crate::tools::js;

/// `claimSlot(name, args)`: take the execution's write slot when the call,
/// as it will finally run (after hook rewrites and approval), writes. Call
/// right before running it; the runtime releases the slot when the
/// operation settles. `Err` when cancelled while waiting.
pub type ClaimSlot =
    Rc<dyn Fn(String, Map<String, Value>) -> LocalBoxFuture<'static, Result<(), PtcError>>>;

/// `BrokerCall`.
pub struct BrokerCall {
    pub name: String,
    pub args: Map<String, Value>,
    pub operation_id: String,
    pub signal: AbortSignal,
    pub claim_slot: ClaimSlot,
}

/// The agent side of an execution (`Broker`): authority stays here, never
/// in the realm.
pub trait Broker {
    /// Capabilities the script may call: the preflight manifest.
    fn manifest(&self) -> &[String];
    /// Whether the call needs the execution's single write slot.
    fn is_write(&self, name: &str, args: &Map<String, Value>) -> bool;
    /// Run one operation; failures come back as error envelopes. `Err` is
    /// what TS threw out of `invoke`.
    fn invoke(&self, call: BrokerCall) -> LocalBoxFuture<'static, Result<Value, PtcError>>;
}

/// `attachments.add(handle)`: queue an operation's image (`{queued}`).
pub type Attach = Rc<dyn Fn(&str) -> Result<Value, PtcError>>;
/// Progress for observers.
pub type OnProgress = Rc<dyn Fn(&OperationSummary)>;

/// Subscribe to "a human is being asked"; returns the unsubscribe.
pub type OnHumanWait = Box<dyn FnOnce(Rc<dyn Fn(bool)>) -> Box<dyn FnOnce()>>;

/// `ExecutionOptions`.
pub struct ExecutionOptions {
    /// Preflighted JavaScript defining `async function __ptc_main()`.
    pub code: String,
    pub broker: Rc<dyn Broker>,
    pub signal: AbortSignal,
    /// Active-time budget; time spent waiting for a human is not counted.
    pub timeout_ms: f64,
    pub turn_id: String,
    pub execution_id: String,
    pub on_human_wait: Option<OnHumanWait>,
    /// `attachments.add(handle)`: queue an operation's image (`{queued}`).
    pub attach: Option<Attach>,
    /// Progress for observers (not the model); never called after the end.
    pub on_progress: Option<OnProgress>,
    /// The session's script store (JSON object) for `load()`.
    pub store: Option<String>,
    /// The guest command: program and arguments (`selfCommand()` and
    /// `ptc-guest`).
    pub guest: Vec<OsString>,
    /// Test seam: the pid of the script's process once started.
    pub on_process: Option<Box<dyn FnOnce(u32)>>,
}

/// `OperationRecord`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OperationRecord {
    pub operation_id: String,
    pub capability: String,
    pub outcome: &'static str,
    pub error_code: Option<&'static str>,
    /// -1 while running.
    pub duration_ms: i64,
    /// The script received this result (false: it ended or was cancelled
    /// first).
    pub delivered: bool,
    /// Refused before it started (TS gave such a record its `errorCode`
    /// before `durationMs`).
    pub(crate) refused: bool,
}

impl OperationRecord {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("operationId".to_owned(), json!(self.operation_id));
        out.insert("capability".to_owned(), json!(self.capability));
        out.insert("outcome".to_owned(), json!(self.outcome));
        if self.refused
            && let Some(code) = self.error_code
        {
            out.insert("errorCode".to_owned(), json!(code));
        }
        out.insert("durationMs".to_owned(), json!(self.duration_ms));
        out.insert("delivered".to_owned(), json!(self.delivered));
        if !self.refused
            && let Some(code) = self.error_code
        {
            out.insert("errorCode".to_owned(), json!(code));
        }
        Value::Object(out)
    }
}

/// `OperationSummary`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OperationSummary {
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub unknown: usize,
    pub not_started: usize,
    pub running: usize,
}

impl OperationSummary {
    pub fn to_json(&self) -> Value {
        json!({ "total": self.total, "completed": self.completed, "failed": self.failed,
            "cancelled": self.cancelled, "unknown": self.unknown,
            "notStarted": self.not_started, "running": self.running })
    }
}

/// `ExecutionReport`.
#[derive(Clone, Debug)]
pub struct ExecutionReport {
    /// `completed`, `failed`, `timed_out` or `cancelled`.
    pub status: &'static str,
    /// The returned string as is, or JSON of any other value.
    pub value: Option<String>,
    /// The returned value was a string (`value` is not JSON).
    pub value_is_string: bool,
    /// The whole script store (JSON) when a completed script changed it.
    pub store: Option<String>,
    /// The script may have read the store: only a script that ended on its
    /// own and reported not loading is known not to have.
    pub store_read: bool,
    /// `(code, message)`; the code may be `ScriptError`.
    pub error: Option<(String, String)>,
    pub console: String,
    pub console_truncated: bool,
    /// Records of the operations (refusals past the call quota are only
    /// counted).
    pub operations: Vec<OperationRecord>,
    pub summary: OperationSummary,
    pub trace: Vec<Value>,
    pub trace_truncated: bool,
    pub active_ms: u64,
    pub waited_ms: u64,
}

/// Refusals past the call quota that still get a record of their own.
const RECORDED_REFUSALS: usize = 20;
/// Calls after which a script that ignores QuotaExceeded is stopped.
const MAX_ATTEMPTS: usize = budgets::INTERNAL_CALLS * 5;
/// `tools.par` scopes per execution (the guest refuses more; the host stops
/// past it).
const MAX_SCOPES: usize = budgets::PAR_SCOPES;
const MAX_TRACE_NODES: usize =
    2 * (budgets::INTERNAL_CALLS + RECORDED_REFUSALS) + 2 * MAX_SCOPES + 2;

/// `truncateUtf8(text, bytes)`: a cut character becomes U+FFFD, as
/// `Buffer.toString` made it.
fn truncate_utf8(text: &str, bytes: usize) -> String {
    if text.len() <= bytes {
        return text.to_owned();
    }
    String::from_utf8_lossy(&text.as_bytes()[..bytes]).into_owned()
}

/// `Budget`: active time that stops counting while a human is asked.
struct Budget {
    limit_ms: f64,
    used_ms: f64,
    since: Option<Instant>,
    waiting_since: Option<Instant>,
    stopped: bool,
    waited_ms: f64,
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

impl Budget {
    fn new(limit_ms: f64) -> Self {
        Self {
            limit_ms,
            used_ms: 0.0,
            since: Some(Instant::now()),
            waiting_since: None,
            stopped: false,
            waited_ms: 0.0,
        }
    }

    fn active_ms(&self) -> f64 {
        self.used_ms + self.since.map_or(0.0, |since| ms(since.elapsed()))
    }

    fn pause(&mut self) {
        if self.stopped {
            return;
        }
        let Some(since) = self.since.take() else {
            return;
        };
        self.used_ms += ms(since.elapsed());
        self.waiting_since = Some(Instant::now());
    }

    fn resume(&mut self) {
        if self.stopped || self.since.is_some() {
            return;
        }
        if let Some(waiting) = self.waiting_since.take() {
            self.waited_ms += ms(waiting.elapsed());
        }
        self.since = Some(Instant::now());
    }

    /// When the budget runs out at the current pace; `None` while paused.
    fn deadline(&self) -> Option<tokio::time::Instant> {
        if self.stopped {
            return None;
        }
        let since = self.since?;
        let left = (self.limit_ms - self.used_ms).max(1.0);
        Some(tokio::time::Instant::from_std(since) + Duration::from_secs_f64(left / 1000.0))
    }

    /// Freeze both counters, including a wait still open.
    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        if let Some(since) = self.since.take() {
            self.used_ms += ms(since.elapsed());
        }
        if let Some(waiting) = self.waiting_since.take() {
            self.waited_ms += ms(waiting.elapsed());
        }
        self.stopped = true;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    TimedOut,
    Cancelled,
    Quota,
}

/// `ScriptOutcome`.
#[derive(Clone, Debug, Default)]
struct ScriptOutcome {
    ok: bool,
    value: Option<String>,
    string: bool,
    store: Option<String>,
    /// `loaded: false` was reported.
    not_loaded: bool,
    error: Option<(String, String)>,
}

impl ScriptOutcome {
    fn failure(code: &str, message: impl Into<String>) -> Self {
        Self {
            error: Some((code.to_owned(), message.into())),
            ..Self::default()
        }
    }
}

/// `storeOf(raw)`: a store, kept only when it is a JSON object within the
/// store budget, with keys and values within their limits (checked here
/// too: the script controls what the guest sends).
pub fn store_of(raw: Option<&Value>) -> Option<String> {
    let raw = raw?.as_str()?;
    if len16(raw) > budgets::STORE_TOTAL_CHARS + 2 {
        return None;
    }
    let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&well_formed_json(raw)) else {
        return None;
    };
    for (key, value) in &parsed {
        if key.is_empty()
            || len16(key) > 200
            || len16(&js::stringify(value)) > budgets::STORE_VALUE_CHARS
        {
            return None;
        }
    }
    Some(raw.to_owned())
}

/// `checkedOutcome(raw)`: the guest's final outcome, checked field by
/// field: the script can shape it.
fn checked_outcome(raw: &Value) -> ScriptOutcome {
    let empty = Map::new();
    let value = raw.as_object().unwrap_or(&empty);
    let not_loaded = value.get("loaded") == Some(&Value::Bool(false));
    if value.get("ok") == Some(&Value::Bool(true)) {
        let store = store_of(value.get("store"));
        return match value.get("value") {
            None => ScriptOutcome {
                ok: true,
                not_loaded,
                store,
                ..ScriptOutcome::default()
            },
            Some(Value::String(text)) => ScriptOutcome {
                ok: true,
                value: Some(head16(text, guest_limits::VALUE_CHARS).to_owned()),
                string: value.get("string") == Some(&Value::Bool(true)),
                not_loaded,
                store,
                error: None,
            },
            Some(_) => {
                ScriptOutcome::failure("ScriptError", "The script returned a malformed value")
            }
        };
    }
    let error = value
        .get("error")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let code = match error.get("code").and_then(Value::as_str) {
        Some(code) if ERROR_CODES.contains(&code) => code,
        _ => "ScriptError",
    };
    let message = match error.get("message").and_then(Value::as_str) {
        Some(message) => head16(message, 8192).to_owned(),
        None => "Script failed".to_owned(),
    };
    ScriptOutcome {
        not_loaded,
        ..ScriptOutcome::failure(code, message)
    }
}

struct Operation {
    record: usize,
    controller: AbortController,
    scope: String,
}

struct ScopeInfo {
    parent: String,
    cancelled: bool,
}

/// Everything `execute`'s closure kept in TS.
struct Exec {
    turn_id: String,
    execution_id: String,
    budget: Budget,
    human_waiting: bool,
    guest_busy: bool,
    /// Results sent; an `idle` counts only once the guest received all.
    results_sent: u64,
    trace: Vec<Value>,
    trace_truncated: bool,
    sequence: u64,
    operations: Vec<Operation>,
    records: Vec<OperationRecord>,
    scopes: HashMap<String, ScopeInfo>,
    attempts: usize,
    unrecorded_refusals: usize,
    pending: usize,
    console: String,
    console_truncated: bool,
    ended: bool,
    stop_reason: Option<StopReason>,
    outcome: Option<ScriptOutcome>,
    /// Lines for the guest's stdin; `None` once it is gone.
    to_guest: Option<mpsc::UnboundedSender<String>>,
    on_progress: Option<OnProgress>,
}

type Shared = Rc<RefCell<Exec>>;

impl Exec {
    fn root_id(&self) -> String {
        format!("{}:root", self.execution_id)
    }

    fn node_id_of(&self, scope: &str) -> String {
        if scope == ROOT_SCOPE {
            self.root_id()
        } else {
            format!("{}:{scope}", self.execution_id)
        }
    }

    /// `node(fields)`: one trace node, unless the trace is full.
    fn node(&mut self, fields: Vec<(&str, Value)>) {
        if self.trace.len() >= MAX_TRACE_NODES {
            self.trace_truncated = true;
            return;
        }
        let mut out = Map::new();
        out.insert("turnId".to_owned(), json!(self.turn_id));
        out.insert("executionId".to_owned(), json!(self.execution_id));
        out.insert("sequence".to_owned(), json!(self.sequence));
        out.insert("createdAt".to_owned(), json!(iso_now()));
        for (key, value) in fields {
            out.insert(key.to_owned(), value);
        }
        self.sequence += 1;
        self.trace.push(Value::Object(out));
    }

    /// `updateBudget()`: paused only while a human is asked and the script
    /// itself waits.
    fn update_budget(&mut self) {
        if self.human_waiting && !self.guest_busy {
            self.budget.pause();
        } else {
            self.budget.resume();
        }
    }

    /// Whether `scope` is `ancestor` or lies inside it.
    fn within(&self, scope: &str, ancestor: &str) -> bool {
        let mut at = Some(scope.to_owned());
        while let Some(current) = at {
            if current == ancestor {
                return true;
            }
            if current == ROOT_SCOPE {
                return false;
            }
            at = self.scopes.get(&current).map(|info| info.parent.clone());
        }
        false
    }

    fn cancelled_scope(&self, scope: &str) -> bool {
        self.scopes
            .iter()
            .any(|(id, info)| info.cancelled && self.within(scope, id))
    }

    /// `summary(final)`: running operations count as `unknown` once the
    /// execution has ended.
    fn summary(&self, last: bool) -> OperationSummary {
        let count = |value: &str| self.records.iter().filter(|r| r.outcome == value).count();
        OperationSummary {
            total: self.attempts,
            completed: count("completed"),
            failed: count("failed"),
            cancelled: count("cancelled"),
            unknown: self
                .records
                .iter()
                .filter(|r| r.outcome == "unknown" && (last || r.duration_ms >= 0))
                .count(),
            not_started: count("not_started") + self.unrecorded_refusals,
            running: if last { 0 } else { self.pending },
        }
    }

    /// `send(message)`.
    fn send(&mut self, message: Value, wake: &Notify) {
        if self.ended || self.stop_reason.is_some() {
            return;
        }
        let Some(sender) = &self.to_guest else {
            return;
        };
        let is_result = message["type"] == "result";
        // The process may be gone; its exit is handled by the main loop.
        let _ = sender.send(format!("{message}\n"));
        if is_result {
            self.results_sent += 1;
            self.guest_busy = true;
            self.update_budget();
            wake.notify_one();
        }
    }
}

/// `progress()`: never after the end; called with no borrow held.
fn progress(state: &Shared) {
    let (summary, listener) = {
        let state = state.borrow();
        if state.ended {
            return;
        }
        (state.summary(false), state.on_progress.clone())
    };
    if let Some(listener) = listener {
        listener(&summary);
    }
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    iso_time(crate::now_ms())
}

/// Epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ` (proleptic Gregorian).
pub fn iso_time(epoch_ms: u64) -> String {
    let days = (epoch_ms / 86_400_000) as i64;
    let rest = epoch_ms % 86_400_000;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

fn envelope_error(operation_id: &str, error: &PtcError) -> Value {
    json!({ "ok": false, "contractVersion": CONTRACT_VERSION, "operationId": operation_id,
        "error": error.to_json(Some(operation_id)) })
}

/// Take a permit of `semaphore` (FIFO, as the TS queues), unless `signal`
/// is aborted first.
async fn acquire(
    semaphore: &Arc<Semaphore>,
    signal: &AbortSignal,
    waiting: &str,
) -> Result<OwnedSemaphorePermit, PtcError> {
    if signal.aborted() {
        return Err(PtcError::new("Cancelled", "Cancelled before it started"));
    }
    if let Ok(permit) = semaphore.clone().try_acquire_owned() {
        return Ok(permit);
    }
    tokio::select! {
        permit = semaphore.clone().acquire_owned() => {
            permit.map_err(|_| PtcError::new("Cancelled", waiting))
        }
        () = signal.cancelled() => Err(PtcError::new("Cancelled", waiting)),
    }
}

/// What the main loop shares with operation tasks.
#[derive(Clone)]
struct Context {
    state: Shared,
    wake: Rc<Notify>,
    broker: Rc<dyn Broker>,
    execution: AbortSignal,
    slots: Arc<Semaphore>,
    writes: Arc<Semaphore>,
}

/// `deliver(envelope, record)`: the envelope back to the script.
fn deliver(
    context: &Context,
    id: &Value,
    operation_id: &str,
    envelope: &Value,
    record: Option<usize>,
) {
    let mut state = context.state.borrow_mut();
    if state.ended || state.stop_reason.is_some() {
        return;
    }
    let mut text = js::stringify(envelope);
    if text.len() > budgets::RESULT_BYTES {
        let outcome = record.map_or("not_started", |index| state.records[index].outcome);
        text = js::stringify(&json!({
            "ok": false, "contractVersion": CONTRACT_VERSION, "operationId": operation_id,
            "error": { "code": "QuotaExceeded",
                "message": format!("The result exceeds {} bytes; ask for less (offset/limit, filters)", budgets::RESULT_BYTES),
                "operationId": operation_id, "outcome": outcome },
        }));
    }
    state.send(
        json!({ "type": "result", "id": id, "json": text }),
        &context.wake,
    );
    if let Some(index) = record {
        state.records[index].delivered = true;
    }
}

/// `startOperation`: one operation, entirely on this side; the envelope
/// goes back to the script. `false` stops the execution (quota).
fn start_operation(
    context: &Context,
    tasks: &mut Vec<tokio::sync::oneshot::Receiver<()>>,
    id: Value,
    raw_name: &str,
    args_json: &str,
    raw_scope: &str,
    oversize: bool,
) -> bool {
    let (index, scope, operation_id, name) = {
        let mut state = context.state.borrow_mut();
        if state.attempts >= MAX_ATTEMPTS {
            return false;
        }
        state.attempts += 1;
        let index = state.attempts;
        let scope = if raw_scope == ROOT_SCOPE || state.scopes.contains_key(raw_scope) {
            raw_scope.to_owned()
        } else {
            ROOT_SCOPE.to_owned()
        };
        let operation_id = format!("{}:op{index}", state.execution_id);
        (index, scope, operation_id, head16(raw_name, 64).to_owned())
    };
    let refuse = |error: PtcError| {
        let envelope = envelope_error(&operation_id, &error);
        // Past the quota a script may loop on refusals: count them, keep a few.
        if index > budgets::INTERNAL_CALLS + RECORDED_REFUSALS {
            context.state.borrow_mut().unrecorded_refusals += 1;
            return deliver(context, &id, &operation_id, &envelope, None);
        }
        let record = {
            let mut state = context.state.borrow_mut();
            state.records.push(OperationRecord {
                operation_id: operation_id.clone(),
                capability: name.clone(),
                outcome: "not_started",
                error_code: Some(error.code),
                duration_ms: 0,
                delivered: false,
                refused: true,
            });
            let parent = state.node_id_of(&scope);
            state.node(vec![
                ("nodeId", json!(operation_id)),
                ("parentNodeId", json!(parent)),
                ("type", json!("operation")),
                (
                    "status",
                    json!(if error.code == "Cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    }),
                ),
                ("capability", json!(name)),
                ("outcome", json!("not_started")),
                ("errorCode", json!(error.code)),
                ("durationMs", json!(0)),
            ]);
            state.records.len() - 1
        };
        deliver(context, &id, &operation_id, &envelope, Some(record));
    };
    // Reserve first: a refused call still counts toward the call quota.
    if index > budgets::INTERNAL_CALLS {
        refuse(PtcError::new(
            "QuotaExceeded",
            format!(
                "More than {} operations in one ptc call; split the work across calls",
                budgets::INTERNAL_CALLS
            ),
        ));
        return true;
    }
    if context.state.borrow().cancelled_scope(&scope) {
        refuse(PtcError::new(
            "Cancelled",
            "Its tools.par was cancelled after a failure",
        ));
        return true;
    }
    if name.is_empty() {
        refuse(PtcError::new(
            "InvalidArguments",
            "The capability name must be a string literal",
        ));
        return true;
    }
    if !context.broker.manifest().contains(&name) {
        refuse(PtcError::new(
            "CapabilityUnavailable",
            format!(
                "{name} is not in this script's capability manifest; call capabilities by literal name"
            ),
        ));
        return true;
    }
    if oversize || args_json.len() > budgets::ARGS_BYTES {
        refuse(PtcError::new(
            "QuotaExceeded",
            format!("Arguments exceed {} bytes", budgets::ARGS_BYTES),
        ));
        return true;
    }
    let Ok(Value::Object(values)) = serde_json::from_str::<Value>(&well_formed_json(args_json))
    else {
        refuse(PtcError::new(
            "InvalidArguments",
            "Arguments must be an object",
        ));
        return true;
    };
    let controller = AbortController::child_of(&context.execution);
    let signal = controller.signal();
    let started = Instant::now();
    let record = {
        let mut state = context.state.borrow_mut();
        state.pending += 1;
        state.records.push(OperationRecord {
            operation_id: operation_id.clone(),
            capability: name.clone(),
            outcome: "unknown",
            error_code: None,
            duration_ms: -1,
            delivered: false,
            refused: false,
        });
        let record = state.records.len() - 1;
        let parent = state.node_id_of(&scope);
        state.node(vec![
            ("nodeId", json!(operation_id)),
            ("parentNodeId", json!(parent)),
            ("type", json!("operation")),
            ("status", json!("running")),
            ("capability", json!(name)),
        ]);
        state.operations.push(Operation {
            record,
            controller,
            scope: scope.clone(),
        });
        record
    };
    progress(&context.state);
    let context = context.clone();
    let task = async move {
        let held: Rc<RefCell<Option<OwnedSemaphorePermit>>> = Rc::new(RefCell::new(None));
        let claim_slot: ClaimSlot = {
            let (held, broker, writes, signal) = (
                held.clone(),
                context.broker.clone(),
                context.writes.clone(),
                signal.clone(),
            );
            Rc::new(move |final_name: String, final_args: Map<String, Value>| {
                let (held, broker, writes, signal) =
                    (held.clone(), broker.clone(), writes.clone(), signal.clone());
                Box::pin(async move {
                    if held.borrow().is_some() || !broker.is_write(&final_name, &final_args) {
                        return Ok(());
                    }
                    let permit = acquire(
                        &writes,
                        &signal,
                        "Cancelled while waiting for the write slot",
                    )
                    .await?;
                    *held.borrow_mut() = Some(permit);
                    Ok(())
                })
            })
        };
        let envelope =
            match acquire(&context.slots, &signal, "Cancelled while waiting to start").await {
                Err(error) => envelope_error(&operation_id, &error),
                Ok(slot) => {
                    let call = BrokerCall {
                        name: name.clone(),
                        args: values,
                        operation_id: operation_id.clone(),
                        signal: signal.clone(),
                        claim_slot,
                    };
                    let result = context.broker.invoke(call).await;
                    // The write slot first, then the operation slot.
                    held.borrow_mut().take();
                    drop(slot);
                    match result {
                        Ok(envelope) => envelope,
                        Err(error) => envelope_error(&operation_id, &error),
                    }
                }
            };
        held.borrow_mut().take();
        let ok = envelope["ok"] == Value::Bool(true);
        let code = envelope["error"]["code"]
            .as_str()
            .and_then(error_code)
            .unwrap_or("OperationFailed");
        {
            let mut state = context.state.borrow_mut();
            state.pending -= 1;
            let duration = ms(started.elapsed()).round() as i64;
            let outcome_value = if ok {
                "completed"
            } else {
                envelope["error"]["outcome"]
                    .as_str()
                    .and_then(outcome)
                    .unwrap_or("unknown")
            };
            let entry = &mut state.records[record];
            entry.duration_ms = duration;
            entry.outcome = outcome_value;
            if !ok {
                entry.error_code = Some(code);
            }
            let parent = state.node_id_of(&scope);
            let status = if ok {
                "completed"
            } else if code == "Timeout" {
                "timed_out"
            } else if code == "Cancelled" {
                "cancelled"
            } else {
                "failed"
            };
            let mut fields = vec![
                ("nodeId", json!(operation_id)),
                ("parentNodeId", json!(parent)),
                ("type", json!("operation")),
                ("status", json!(status)),
                ("capability", json!(name)),
                ("outcome", json!(outcome_value)),
                ("durationMs", json!(duration)),
            ];
            if !ok {
                fields.push(("errorCode", json!(code)));
            }
            state.node(fields);
        }
        progress(&context.state);
        deliver(&context, &id, &operation_id, &envelope, Some(record));
    };
    // Started at once, as the TS async function ran up to its first real
    // wait before the next guest message was handled.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    crate::spawn_eager(async move {
        task.await;
        let _ = sender.send(());
    });
    tasks.push(receiver);
    true
}

fn text_of(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// What one guest message asks of the main loop.
enum Next {
    Continue,
    Stop(StopReason),
    Done,
}

fn on_message(
    context: &Context,
    tasks: &mut Vec<tokio::sync::oneshot::Receiver<()>>,
    attach: Option<&Attach>,
    message: &Value,
) -> Next {
    {
        let state = context.state.borrow();
        if state.ended || state.stop_reason.is_some() || !message.is_object() {
            return Next::Continue;
        }
    }
    match message["type"].as_str() {
        Some("call") => {
            if message["id"].is_number()
                && !start_operation(
                    context,
                    tasks,
                    message["id"].clone(),
                    text_of(&message["name"]),
                    text_of(&message["argsJson"]),
                    text_of(&message["scope"]),
                    message["oversize"] == Value::Bool(true),
                )
            {
                return Next::Stop(StopReason::Quota);
            }
        }
        Some("attach") => {
            if !message["id"].is_number() {
                return Next::Continue;
            }
            let result = match attach {
                None => Err(PtcError::new(
                    "CapabilityUnavailable",
                    "Attachments are not available",
                )),
                Some(attach) => attach(head16(text_of(&message["handle"]), 100)),
            };
            let reply = match result {
                Ok(data) => json!({ "ok": true, "data": data }),
                Err(error) => json!({ "ok": false, "error": error.to_json(None) }),
            };
            context.state.borrow_mut().send(
                json!({ "type": "result", "id": message["id"], "json": js::stringify(&reply) }),
                &context.wake,
            );
        }
        Some("idle") => {
            let mut state = context.state.borrow_mut();
            // An idle sent before the latest result arrived is stale: the
            // script may be busy again.
            if message["received"].as_f64() != Some(state.results_sent as f64) {
                return Next::Continue;
            }
            state.guest_busy = false;
            state.update_budget();
            context.wake.notify_one();
        }
        Some("log") => {
            let mut state = context.state.borrow_mut();
            if state.console_truncated {
                return Next::Continue;
            }
            let level = head16(text_of(&message["level"]), 8);
            let prefix = if matches!(level, "log" | "info" | "") {
                String::new()
            } else {
                format!("[{level}] ")
            };
            let line = format!("{prefix}{}\n", text_of(&message["text"]));
            let used = state.console.len();
            if used + line.len() > budgets::CONSOLE_BYTES {
                let cut = truncate_utf8(&line, budgets::CONSOLE_BYTES.saturating_sub(used));
                state.console.push_str(&cut);
                state.console_truncated = true;
            } else {
                state.console.push_str(&line);
            }
        }
        Some("scope_open") => {
            let mut state = context.state.borrow_mut();
            let scope = text_of(&message["scope"]).to_owned();
            if scope.is_empty() || scope == ROOT_SCOPE || state.scopes.contains_key(&scope) {
                return Next::Continue;
            }
            if state.scopes.len() >= MAX_SCOPES {
                return Next::Stop(StopReason::Quota);
            }
            let requested = text_of(&message["parent"]);
            let parent = if state.scopes.contains_key(requested) {
                requested.to_owned()
            } else {
                ROOT_SCOPE.to_owned()
            };
            state.scopes.insert(
                scope.clone(),
                ScopeInfo {
                    parent: parent.clone(),
                    cancelled: false,
                },
            );
            let (node, parent_node) = (state.node_id_of(&scope), state.node_id_of(&parent));
            state.node(vec![
                ("nodeId", json!(node)),
                ("parentNodeId", json!(parent_node)),
                ("type", json!("par")),
                ("status", json!("running")),
            ]);
        }
        Some("scope_cancel") => {
            let scope = text_of(&message["scope"]);
            let controllers: Vec<AbortController> = {
                let mut state = context.state.borrow_mut();
                match state.scopes.get_mut(scope) {
                    Some(info) if !info.cancelled => info.cancelled = true,
                    _ => return Next::Continue,
                }
                // Abort only what this par (and pars inside it) started and
                // is still running.
                state
                    .operations
                    .iter()
                    .filter(|operation| {
                        state.records[operation.record].duration_ms < 0
                            && state.within(&operation.scope, scope)
                    })
                    .map(|operation| operation.controller.clone())
                    .collect()
            };
            for controller in controllers {
                controller.abort();
            }
        }
        Some("scope_close") => {
            let mut state = context.state.borrow_mut();
            let scope = text_of(&message["scope"]);
            let Some(info) = state.scopes.get(scope) else {
                return Next::Continue;
            };
            let parent = info.parent.clone();
            let (node, parent_node) = (state.node_id_of(scope), state.node_id_of(&parent));
            let status = if message["status"] == "completed" {
                "completed"
            } else {
                "failed"
            };
            state.node(vec![
                ("nodeId", json!(node)),
                ("parentNodeId", json!(parent_node)),
                ("type", json!("par")),
                ("status", json!(status)),
            ]);
        }
        Some("done") => {
            context.state.borrow_mut().outcome = Some(checked_outcome(&message["outcome"]));
            return Next::Done;
        }
        _ => {}
    }
    Next::Continue
}

/// Start the guest process: no environment at all, so nothing of the
/// agent's reaches the script's process, and `/` as its directory (not the
/// workspace; sandboxed agents cannot write there).
fn spawn_guest(guest: &[OsString]) -> std::io::Result<Child> {
    let Some((program, args)) = guest.split_first() else {
        return Err(std::io::Error::other("no guest command"));
    };
    Command::new(program)
        .args(args)
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// `execute(options)`.
pub async fn execute(options: ExecutionOptions) -> ExecutionReport {
    let ExecutionOptions {
        code,
        broker,
        signal,
        timeout_ms,
        turn_id,
        execution_id,
        on_human_wait,
        attach,
        on_progress,
        store,
        guest,
        on_process,
    } = options;
    let execution = AbortController::new();
    let state: Shared = Rc::new(RefCell::new(Exec {
        turn_id,
        execution_id,
        budget: Budget::new(timeout_ms),
        human_waiting: false,
        guest_busy: true,
        results_sent: 0,
        trace: Vec::new(),
        trace_truncated: false,
        sequence: 0,
        operations: Vec::new(),
        records: Vec::new(),
        scopes: HashMap::new(),
        attempts: 0,
        unrecorded_refusals: 0,
        pending: 0,
        console: String::new(),
        console_truncated: false,
        ended: false,
        stop_reason: None,
        outcome: None,
        to_guest: None,
        on_progress,
    }));
    let wake = Rc::new(Notify::new());
    let context = Context {
        state: state.clone(),
        wake: wake.clone(),
        broker: broker.clone(),
        execution: execution.signal(),
        slots: Arc::new(Semaphore::new(budgets::CONCURRENT_OPERATIONS)),
        writes: Arc::new(Semaphore::new(budgets::CONCURRENT_WRITES)),
    };
    // The budget pauses while a human is asked, but only while the script
    // itself waits: a script computing meanwhile still spends active time.
    let unsubscribe = on_human_wait.map(|subscribe| {
        let (state, wake) = (Rc::downgrade(&state), wake.clone());
        subscribe(Rc::new(move |waiting: bool| {
            if let Some(state) = state.upgrade() {
                let mut state = state.borrow_mut();
                state.human_waiting = waiting;
                state.update_budget();
                wake.notify_one();
            }
        }))
    });
    {
        let mut state = state.borrow_mut();
        let root = state.root_id();
        state.node(vec![
            ("nodeId", json!(root)),
            ("type", json!("execution")),
            ("status", json!("running")),
        ]);
    }
    let stop = |reason: StopReason, child: &mut Option<Child>| {
        let mut state = state.borrow_mut();
        if state.outcome.is_some() || state.stop_reason.is_some() {
            return;
        }
        state.stop_reason = Some(reason);
        drop(state);
        if let Some(child) = child {
            let _ = child.start_kill();
        }
        execution.abort();
    };
    let mut tasks: Vec<tokio::sync::oneshot::Receiver<()>> = Vec::new();
    let mut child: Option<Child> = None;
    if signal.aborted() {
        stop(StopReason::Cancelled, &mut child);
    } else {
        match spawn_guest(&guest) {
            Err(error) => {
                state.borrow_mut().outcome = Some(ScriptOutcome::failure(
                    "ScriptError",
                    format!("Script runtime failed: {error}"),
                ));
            }
            Ok(mut started) => {
                if let (Some(on_process), Some(pid)) = (on_process, started.id()) {
                    on_process(pid);
                }
                let mut stdin = started.stdin.take();
                let stdout = started.stdout.take();
                let stderr = started.stderr.take();
                let mut stderr_task = stderr.map(|mut stderr| {
                    tokio::task::spawn_local(async move {
                        let mut tail = Vec::new();
                        let mut chunk = [0u8; 4096];
                        while let Ok(read) = stderr.read(&mut chunk).await {
                            if read == 0 {
                                break;
                            }
                            tail.extend_from_slice(&chunk[..read]);
                            if tail.len() > 8000 {
                                tail.drain(..tail.len() - 8000);
                            }
                        }
                        let text = String::from_utf8_lossy(&tail).into_owned();
                        js::tail16(&text, 2000).to_owned()
                    })
                });
                let (sender, mut lines_out) = mpsc::unbounded_channel::<String>();
                tokio::task::spawn_local(async move {
                    let Some(stdin) = stdin.as_mut() else {
                        return;
                    };
                    while let Some(line) = lines_out.recv().await {
                        if stdin.write_all(line.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
                let start = json!({ "type": "start", "code": code,
                    "manifest": broker.manifest(), "store": store.as_deref().unwrap_or("{}") });
                let _ = sender.send(format!("{start}\n"));
                state.borrow_mut().to_guest = Some(sender);
                child = Some(started);
                if let Some(stdout) = stdout {
                    let mut lines = BufReader::new(stdout).lines();
                    loop {
                        let deadline = state.borrow().budget.deadline();
                        let expire = async {
                            match deadline {
                                Some(deadline) => tokio::time::sleep_until(deadline).await,
                                None => std::future::pending().await,
                            }
                        };
                        tokio::select! {
                            () = signal.cancelled() => {
                                stop(StopReason::Cancelled, &mut child);
                                break;
                            }
                            () = expire => {
                                let expired = {
                                    let state = state.borrow();
                                    state.budget.active_ms() >= state.budget.limit_ms
                                };
                                if expired {
                                    stop(StopReason::TimedOut, &mut child);
                                    break;
                                }
                            }
                            () = wake.notified() => {}
                            line = lines.next_line() => {
                                let Ok(Some(line)) = line else {
                                    // The process is gone, or broke its
                                    // stdout: it is killed either way, so
                                    // waiting for it cannot hang the call.
                                    if let Some(child) = child.as_mut() {
                                        let _ = child.start_kill();
                                        let _ = child.wait().await;
                                    }
                                    let stderr = match stderr_task.take() {
                                        Some(task) => tokio::time::timeout(Duration::from_secs(1), task)
                                            .await
                                            .ok()
                                            .and_then(Result::ok)
                                            .unwrap_or_default(),
                                        None => String::new(),
                                    };
                                    let mut state = state.borrow_mut();
                                    if state.outcome.is_none() && state.stop_reason.is_none() {
                                        let stderr = stderr.trim();
                                        let detail = if stderr.is_empty() {
                                            String::new()
                                        } else {
                                            format!(": {}", js::tail16(stderr, 500))
                                        };
                                        state.outcome = Some(ScriptOutcome::failure(
                                            "ScriptError",
                                            format!("Script runtime stopped unexpectedly{detail}"),
                                        ));
                                    }
                                    break;
                                };
                                let Ok(message) = serde_json::from_str::<Value>(&well_formed_json(&line)) else {
                                    continue;
                                };
                                match on_message(&context, &mut tasks, attach.as_ref(), &message) {
                                    // Let what the message started run on (JavaScript's
                                    // microtasks) before the next one is read.
                                    Next::Continue => tokio::task::yield_now().await,
                                    Next::Done => break,
                                    Next::Stop(reason) => {
                                        stop(reason, &mut child);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // The end: whatever is still running is no longer awaited by anyone.
    // Cancel it, then give it a bounded time to report what happened.
    {
        let mut state = state.borrow_mut();
        state.ended = true;
        state.to_guest = None;
        state.budget.stop();
    }
    if let Some(child) = child.as_mut() {
        let _ = child.start_kill();
    }
    execution.abort();
    if let Some(unsubscribe) = unsubscribe {
        unsubscribe();
    }
    let settle = async {
        for task in tasks {
            let _ = task.await;
        }
        // SIGKILL cannot be ignored; wait for the process to be reaped.
        if let Some(child) = child.as_mut() {
            let _ = child.wait().await;
        }
    };
    let _ = tokio::time::timeout(Duration::from_millis(budgets::SETTLE_GRACE_MS), settle).await;

    let mut state = state.borrow_mut();
    let outcome = state.outcome.clone();
    let stop_reason = state.stop_reason;
    let status = match stop_reason {
        Some(StopReason::TimedOut) => "timed_out",
        Some(StopReason::Cancelled) => "cancelled",
        Some(StopReason::Quota) => "failed",
        None if outcome.as_ref().is_some_and(|outcome| outcome.ok) => "completed",
        None => "failed",
    };
    let total_ms = (state.budget.active_ms() + state.budget.waited_ms).round() as u64;
    let root = state.root_id();
    state.node(vec![
        ("nodeId", json!(root)),
        ("type", json!("execution")),
        ("status", json!(status)),
        ("durationMs", json!(total_ms)),
    ]);
    let error = match stop_reason {
        Some(StopReason::TimedOut) => Some((
            "Timeout".to_owned(),
            format!(
                "Active execution budget of {}s exceeded",
                (timeout_ms / 1000.0).round()
            ),
        )),
        Some(StopReason::Cancelled) => Some(("Cancelled".to_owned(), "Cancelled".to_owned())),
        Some(StopReason::Quota) => Some((
            "QuotaExceeded".to_owned(),
            format!(
                "Stopped: the script kept calling past its quotas ({} operations, {MAX_SCOPES} tools.par calls)",
                budgets::INTERNAL_CALLS
            ),
        )),
        None => outcome
            .as_ref()
            .filter(|outcome| !outcome.ok)
            .and_then(|outcome| outcome.error.clone()),
    };
    let completed = status == "completed";
    let ok = outcome.as_ref().filter(|outcome| outcome.ok && completed);
    ExecutionReport {
        status,
        value: ok.and_then(|outcome| outcome.value.clone()),
        value_is_string: ok.is_some_and(|outcome| outcome.value.is_some() && outcome.string),
        store: ok.and_then(|outcome| outcome.store.clone()),
        store_read: !outcome.as_ref().is_some_and(|outcome| outcome.not_loaded),
        error,
        console: std::mem::take(&mut state.console),
        console_truncated: state.console_truncated,
        operations: state.records.clone(),
        summary: state.summary(true),
        trace: state.trace.clone(),
        trace_truncated: state.trace_truncated,
        active_ms: state.budget.active_ms().round() as u64,
        waited_ms: state.budget.waited_ms.round() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times_as_javascript_does() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_760_000_000_123), "2025-10-09T08:53:20.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn checks_the_guest_outcome_field_by_field() {
        let ok = checked_outcome(&json!({ "ok": true, "value": "x", "string": true }));
        assert!(ok.ok && ok.string && !ok.not_loaded);
        assert_eq!(ok.value.as_deref(), Some("x"));
        let malformed = checked_outcome(&json!({ "ok": true, "value": 1, "loaded": false }));
        assert!(!malformed.ok && !malformed.not_loaded);
        assert_eq!(
            malformed.error,
            Some((
                "ScriptError".to_owned(),
                "The script returned a malformed value".to_owned()
            ))
        );
        let forged = checked_outcome(&json!({ "ok": false, "error": { "code": "Root" } }));
        assert_eq!(
            forged.error,
            Some(("ScriptError".to_owned(), "Script failed".to_owned()))
        );
        let denied = checked_outcome(
            &json!({ "ok": false, "loaded": false, "error": { "code": "ApprovalDenied", "message": "no" } }),
        );
        assert!(denied.not_loaded);
        assert_eq!(
            denied.error,
            Some(("ApprovalDenied".to_owned(), "no".to_owned()))
        );
        assert!(checked_outcome(&Value::Null).error.is_some());
    }

    #[test]
    fn keeps_only_stores_within_their_limits() {
        assert_eq!(
            store_of(Some(&json!("{\"a\":1}"))).as_deref(),
            Some("{\"a\":1}")
        );
        assert_eq!(store_of(Some(&json!("[1]"))), None);
        assert_eq!(store_of(Some(&json!("null"))), None);
        assert_eq!(store_of(Some(&json!("{\"\":1}"))), None);
        assert_eq!(
            store_of(Some(&json!(format!("{{\"{}\":1}}", "k".repeat(201))))),
            None
        );
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(budgets::STORE_VALUE_CHARS));
        assert_eq!(store_of(Some(&json!(big))), None);
        assert_eq!(store_of(Some(&json!(1))), None);
        assert_eq!(store_of(None), None);
    }

    #[test]
    fn cuts_utf8_as_buffers_did() {
        assert_eq!(truncate_utf8("abc", 5), "abc");
        assert_eq!(truncate_utf8("abc", 2), "ab");
        assert_eq!(truncate_utf8("aé", 2), "a\u{fffd}");
    }
}
