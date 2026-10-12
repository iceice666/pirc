//! `pirc-node ptc-guest` (`agent/ptc/guest.ts`): one `ptc` execution in a
//! fresh QuickJS realm with no module loader, filesystem, network, timers or
//! environment — only the `tools` SDK, `attachments` (queue an operation's
//! image by handle), a bounded `console`, `PtcError` and the script store.
//!
//! The realm is the boundary; the process around it exists so the agent can
//! always end a script: a busy script never stalls the agent, and SIGKILL
//! stops even what QuickJS cannot interrupt (a backtracking regular
//! expression). The agent starts it with an empty environment, inside the
//! same OS sandbox, and it hardens itself before reading the script
//! (`crate::harden`: seccomp, rlimits, no inherited descriptors; Rust-only,
//! security audit S6). This side keeps no authority and no records: every
//! operation is a request to the host (crate::protocol), which validates,
//! authorizes and accounts for it (the agent's `ptc::runtime`).
//!
//! `tools.par` scopes: a continuation runs in the scope of the operation
//! whose result resumed it, and par workers enter their scope explicitly, so
//! an operation belongs to the par that started it (for cancellation and
//! trace) without an async-context API.
//!
//! The guest drives QuickJS's job queue itself, as guest.ts did with
//! `executePendingJobs`: after each result it runs every job, then tells the
//! host whether the script now only waits (`idle`), which is when the
//! host's active-time budget may pause.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, IsTerminal, Write};
use std::process::ExitCode;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::context::EvalOptions;
use rquickjs::function::This;
use rquickjs::prelude::Rest;
use rquickjs::promise::PromiseState;
use rquickjs::{Coerced, Context, Ctx, Function, Object, Persistent, Promise, Runtime, Value};
use serde_json::{Map, Value as Json, json};

use crate::contracts::{ERROR_CODES, budgets};
use crate::protocol::{ROOT_SCOPE, guest_limits, head16, len16, well_formed_json};

/// The guest SDK (guest.ts's `PRELUDE`); `__ptc` is captured and removed
/// before the script runs.
const PRELUDE: &str = include_str!("prelude.js");

fn prelude() -> String {
    PRELUDE
        .replace(
            "${BUDGETS.concurrentOperations}",
            &budgets::CONCURRENT_OPERATIONS.to_string(),
        )
        .replace("${BUDGETS.parScopes}", &budgets::PAR_SCOPES.to_string())
        .replace(
            "${BUDGETS.storeTotalChars}",
            &budgets::STORE_TOTAL_CHARS.to_string(),
        )
        .replace(
            "${BUDGETS.storeValueChars}",
            &budgets::STORE_VALUE_CHARS.to_string(),
        )
}

/// One message to the host. A host that went away has nothing left to hear:
/// the guest ends ('disconnect' in guest.ts).
fn post(message: &Json) {
    let mut line = message.to_string();
    line.push('\n');
    let mut out = std::io::stdout().lock();
    if out
        .write_all(line.as_bytes())
        .and_then(|()| out.flush())
        .is_err()
    {
        std::process::exit(0);
    }
}

/// `failure(message)`.
fn failure(message: &str) -> Json {
    json!({ "ok": false, "error": { "code": "ScriptError",
        "message": format!("Script runtime failed: {message}") } })
}

struct Scope {
    parent: String,
    open: bool,
}

/// What guest.ts kept in `run`'s closure.
struct State {
    /// The scope continuations run in now.
    current: String,
    /// The tree (closed scopes hand over to their parent).
    scopes: HashMap<String, Scope>,
    /// Promises waiting for a host result: their resolve and their scope.
    pending: HashMap<u64, (Persistent<Function<'static>>, String)>,
    next_id: u64,
    /// Results received so far (`idle` reports it).
    received: u64,
    console_bytes: usize,
    scope_count: usize,
    /// The script called `load()` (set from outside the realm).
    loaded: bool,
    finished: bool,
}

impl State {
    /// `effective(scope)`: the nearest open scope, from `scope` itself.
    fn effective(&self, scope: &str) -> String {
        let mut at = scope;
        while at != ROOT_SCOPE {
            let Some(info) = self.scopes.get(at) else {
                return ROOT_SCOPE.to_owned();
            };
            if info.open {
                return at.to_owned();
            }
            at = &info.parent;
        }
        ROOT_SCOPE.to_owned()
    }
}

type Shared = Rc<RefCell<State>>;

/// `stringArg(handle)`: the text of a string argument, else ''. A string
/// with a lone surrogate (no UTF-8 form) is made well-formed first, with
/// the realm's own `toWellFormed` as it was before the script ran.
fn string_arg<'js>(
    ctx: &Ctx<'js>,
    well_formed: &Persistent<Function<'static>>,
    value: Option<&Value<'js>>,
) -> String {
    let Some(text) = value.and_then(Value::as_string) else {
        return String::new();
    };
    if let Ok(text) = text.to_string() {
        return text;
    }
    well_formed
        .clone()
        .restore(ctx)
        .and_then(|f| f.call::<_, rquickjs::String>((This(text.clone()),)))
        .and_then(|text| text.to_string())
        .unwrap_or_default()
}

/// `String(dumped?.message ?? fallback)` of the pending exception.
fn exception_message(ctx: &Ctx<'_>, fallback: &str) -> String {
    let error = ctx.catch();
    let message = match error.as_object() {
        Some(object) => object.get::<_, Value>("message").ok(),
        None => None,
    };
    match message {
        Some(message) if !message.is_undefined() && !message.is_null() => {
            match message.get::<Coerced<String>>() {
                Ok(Coerced(text)) => text,
                Err(_) => fallback.to_owned(),
            }
        }
        _ => fallback.to_owned(),
    }
}

fn eval_options(filename: &str) -> EvalOptions {
    let mut options = EvalOptions::default();
    options.strict = false;
    options.filename = Some(filename.to_owned());
    options
}

/// Read one host message; `None` once the host is gone.
fn read_message(input: &mut impl BufRead) -> Option<Json> {
    loop {
        let mut line = String::new();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        if let Ok(message) = serde_json::from_str::<Json>(&line)
            && message.is_object()
        {
            return Some(message);
        }
    }
}

/// Entry of the internal `ptc-guest` command; only an agent starts it,
/// with its stdin and stdout as the channel.
pub fn run() -> ExitCode {
    if std::io::stdin().is_terminal() {
        eprintln!("ptc-guest must be started by a pirc agent");
        return ExitCode::from(2);
    }
    // Rust-only safeguard: die with the agent, whatever QuickJS is doing (the
    // interrupt handler below cannot stop a backtracking regular expression).
    // An agent already gone is caught by the interrupt handler's check.
    #[cfg(target_os = "linux")]
    let _ = nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL);
    // Rust-only (security audit S6): no file, process, socket or inherited
    // descriptor from here on, before any script is read. A guest that
    // cannot harden runs nothing.
    let hardened = crate::harden::harden();
    let mut input = std::io::stdin().lock();
    let start = loop {
        let Some(message) = read_message(&mut input) else {
            return ExitCode::SUCCESS;
        };
        if message["type"] == "start" {
            break message;
        }
    };
    if let Err(error) = hardened {
        post(&json!({ "type": "done",
            "outcome": failure(&format!("cannot harden the guest: {error}")) }));
        return ExitCode::SUCCESS;
    }
    if let Err(message) = execute(&start, &mut input) {
        post(&json!({ "type": "done", "outcome": failure(&message) }));
    }
    ExitCode::SUCCESS
}

/// `run(start)`: set the realm up, run the script, then feed it results
/// until it settles. `Err` is a runtime failure before the script could
/// report anything.
fn execute(start: &Json, input: &mut impl BufRead) -> Result<(), String> {
    let text = |value: &Json| value.as_str().unwrap_or_default().to_owned();
    let code = text(&start["code"]);
    let manifest = start["manifest"].clone();
    let store = match start["store"].as_str() {
        Some(store) => store.to_owned(),
        None => "{}".to_owned(),
    };
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(budgets::QUICKJS_HEAP_BYTES);
    runtime.set_max_stack_size(budgets::QUICKJS_STACK_BYTES);
    // A busy script cannot see its host vanish: stop when this process was
    // orphaned (checked about every 100 ms; QuickJS polls this often).
    let parent = std::os::unix::process::parent_id();
    let mut last_check = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        if last_check.elapsed() < Duration::from_millis(100) {
            return false;
        }
        last_check = Instant::now();
        std::os::unix::process::parent_id() != parent
    })));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    let state: Shared = Rc::new(RefCell::new(State {
        current: ROOT_SCOPE.to_owned(),
        scopes: HashMap::new(),
        pending: HashMap::new(),
        next_id: 0,
        received: 0,
        console_bytes: 0,
        scope_count: 0,
        loaded: false,
        finished: false,
    }));

    let finish = {
        let state = state.clone();
        move |mut outcome: Json| {
            let mut state = state.borrow_mut();
            if state.finished {
                return;
            }
            state.finished = true;
            // Tracked outside the realm, so a script cannot claim it never
            // read the store.
            if let Some(outcome) = outcome.as_object_mut() {
                if state.loaded {
                    outcome.remove("loaded");
                } else {
                    outcome.insert("loaded".to_owned(), Json::Bool(false));
                }
            }
            post(&json!({ "type": "done", "outcome": outcome }));
        }
    };

    let main = context.with(
        |ctx| -> Result<Result<Persistent<Promise<'static>>, String>, String> {
            let setup = |ctx: &Ctx<'_>| -> rquickjs::Result<()> {
                let to_well_formed: Function = ctx
                    .globals()
                    .get::<_, Object>("String")?
                    .get::<_, Object>("prototype")?
                    .get("toWellFormed")?;
                let well_formed = Persistent::save(ctx, to_well_formed);
                define_host(ctx, &state, &well_formed, &manifest.to_string(), &store)
            };
            setup(&ctx).map_err(|e| e.to_string())?;
            if ctx
                .eval_with_options::<(), _>(prelude(), eval_options("ptc-sdk.js"))
                .is_err()
            {
                return Err(exception_message(&ctx, "the SDK did not load"));
            }
            let evaluated = ctx.eval_with_options::<Promise, _>(
                format!("{code}\n;__ptc_finish(__ptc_main());"),
                eval_options("ptc.js"),
            );
            Ok(match evaluated {
                Ok(promise) => Ok(Persistent::save(&ctx, promise)),
                Err(_) => Err(exception_message(&ctx, "evaluation failed")),
            })
        },
    )?;
    let main = match main {
        Ok(main) => main,
        Err(message) => {
            finish(failure(&message));
            return Ok(());
        }
    };

    // Run every queued job, then report if the script settled; tell the
    // host whether the script is waiting (only then can its budget pause).
    let settle = || {
        if state.borrow().finished {
            return;
        }
        loop {
            match runtime.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => break,
                Err(job) => {
                    let message = job.0.with(|ctx| exception_message(&ctx, "unknown error"));
                    return finish(failure(&message));
                }
            }
        }
        let outcome = context.with(|ctx| -> Option<Json> {
            let promise = main.clone().restore(&ctx).ok()?;
            match promise.state() {
                PromiseState::Pending => None,
                // __ptc_finish never rejects unless the realm itself broke
                // (out of memory).
                PromiseState::Rejected => {
                    let _ = promise.result::<Value>();
                    Some(failure(&exception_message(&ctx, "unknown error")))
                }
                PromiseState::Resolved => Some(match promise.result::<rquickjs::String>() {
                    Some(Ok(text)) => match text.to_string() {
                        Ok(text) => checked(&text),
                        Err(error) => failure(&error.to_string()),
                    },
                    _ => failure(&exception_message(&ctx, "unknown error")),
                }),
            }
        });
        match outcome {
            Some(outcome) => finish(outcome),
            None => {
                let received = state.borrow().received;
                post(&json!({ "type": "idle", "received": received }));
            }
        }
    };
    settle();
    while !state.borrow().finished {
        let Some(message) = read_message(input) else {
            // The agent went away: nothing is left to report to.
            return Ok(());
        };
        if message["type"] != "result" {
            continue;
        }
        let Some(id) = message["id"].as_u64() else {
            continue;
        };
        let Some((resolve, scope)) = state.borrow_mut().pending.remove(&id) else {
            continue;
        };
        state.borrow_mut().received += 1;
        let json = text(&message["json"]);
        context.with(|ctx| {
            if let Ok(resolve) = resolve.restore(&ctx) {
                let _ = resolve.call::<_, ()>((json,));
            }
        });
        // Continuations resumed by this result run in its operation's scope.
        state.borrow_mut().current = scope;
        settle();
        state.borrow_mut().current = ROOT_SCOPE.to_owned();
    }
    Ok(())
}

/// The outcome the realm produced, kept to its documented shape: the realm
/// chose it.
fn checked(text: &str) -> Json {
    let Ok(Json::Object(mut outcome)) = serde_json::from_str::<Json>(&well_formed_json(text))
    else {
        return failure("malformed outcome");
    };
    let ok = outcome.get("ok") == Some(&Json::Bool(true));
    if ok {
        if let Some(Json::String(value)) = outcome.get_mut("value")
            && len16(value) > guest_limits::VALUE_CHARS
        {
            *value = head16(value, guest_limits::VALUE_CHARS).to_owned();
        }
        // An oversized or malformed store never crosses the process boundary.
        let bad_store = match outcome.get("store") {
            None => false,
            Some(Json::String(store)) => len16(store) > budgets::STORE_TOTAL_CHARS + 2,
            Some(_) => true,
        };
        if bad_store {
            outcome.remove("store");
        }
    } else if let Some(Json::Object(error)) = outcome.get_mut("error") {
        let known = error
            .get("code")
            .and_then(Json::as_str)
            .is_some_and(|code| ERROR_CODES.contains(&code));
        if !known {
            error.insert("code".to_owned(), json!("ScriptError"));
        }
        let message = match error.get("message") {
            Some(Json::String(message)) => message.clone(),
            Some(other) => other.to_string(),
            None => "undefined".to_owned(),
        };
        error.insert("message".to_owned(), json!(head16(&message, 8192)));
    }
    Json::Object(outcome)
}

/// The `__ptc` host object the prelude captures: `manifest`, `store` and
/// the bridge functions.
fn define_host<'js>(
    ctx: &Ctx<'js>,
    state: &Shared,
    well_formed: &Persistent<Function<'static>>,
    manifest: &str,
    store: &str,
) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;
    host.set("manifest", manifest)?;
    host.set("store", store)?;
    let arg = {
        let well_formed = well_formed.clone();
        move |ctx: &Ctx<'js>, args: &Rest<Value<'js>>, index: usize| {
            string_arg(ctx, &well_formed, args.0.get(index))
        }
    };

    let (s, a) = (state.clone(), arg.clone());
    host.set(
        "call",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> rquickjs::Result<Promise<'js>> {
                let (promise, resolve, _) = Promise::new(&ctx)?;
                let name = a(&ctx, &args, 0);
                let args_json = a(&ctx, &args, 1);
                let (id, scope) = {
                    let mut state = s.borrow_mut();
                    state.next_id += 1;
                    let id = state.next_id;
                    let scope = state.effective(&state.current.clone());
                    state
                        .pending
                        .insert(id, (Persistent::save(&ctx, resolve), scope.clone()));
                    (id, scope)
                };
                // Oversized input never crosses to the host; it refuses the call.
                let oversize = len16(&args_json) > guest_limits::ARGS_CHARS;
                let mut message = Map::new();
                message.insert("type".to_owned(), json!("call"));
                message.insert("id".to_owned(), json!(id));
                message.insert(
                    "name".to_owned(),
                    json!(head16(&name, guest_limits::NAME_CHARS)),
                );
                message.insert(
                    "argsJson".to_owned(),
                    json!(if oversize { "" } else { args_json.as_str() }),
                );
                message.insert("scope".to_owned(), json!(scope));
                if oversize {
                    message.insert("oversize".to_owned(), json!(true));
                }
                post(&Json::Object(message));
                Ok(promise)
            },
        )?,
    )?;

    let (s, a) = (state.clone(), arg.clone());
    host.set(
        "attach",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> rquickjs::Result<Promise<'js>> {
                let (promise, resolve, _) = Promise::new(&ctx)?;
                let handle = a(&ctx, &args, 0);
                let id = {
                    let mut state = s.borrow_mut();
                    state.next_id += 1;
                    let id = state.next_id;
                    let scope = state.effective(&state.current.clone());
                    state
                        .pending
                        .insert(id, (Persistent::save(&ctx, resolve), scope));
                    id
                };
                post(&json!({ "type": "attach", "id": id, "handle": head16(&handle, 100) }));
                Ok(promise)
            },
        )?,
    )?;

    let s = state.clone();
    host.set(
        "loaded",
        Function::new(ctx.clone(), move || {
            s.borrow_mut().loaded = true;
        })?,
    )?;

    let (s, a) = (state.clone(), arg.clone());
    host.set(
        "log",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| {
            // The host bounds console output; stop sending past that bound.
            if s.borrow().console_bytes > budgets::CONSOLE_BYTES {
                return;
            }
            let text = a(&ctx, &args, 1);
            let text = head16(&text, budgets::CONSOLE_BYTES + 1);
            s.borrow_mut().console_bytes += text.len() + 1;
            let level = a(&ctx, &args, 0);
            let level = match head16(&level, 8) {
                "" => "log",
                level => level,
            };
            post(&json!({ "type": "log", "level": level, "text": text }));
        })?,
    )?;

    let s = state.clone();
    host.set(
        "scopeOpen",
        Function::new(ctx.clone(), move || -> String {
            let mut state = s.borrow_mut();
            if state.scope_count >= budgets::PAR_SCOPES {
                return String::new();
            }
            state.scope_count += 1;
            let scope = format!("par{}", state.scope_count);
            let parent = state.effective(&state.current.clone());
            state.scopes.insert(
                scope.clone(),
                Scope {
                    parent: parent.clone(),
                    open: true,
                },
            );
            post(&json!({ "type": "scope_open", "scope": scope, "parent": parent }));
            scope
        })?,
    )?;

    let (s, a) = (state.clone(), arg.clone());
    host.set(
        "enter",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> String {
                let scope = a(&ctx, &args, 0);
                let mut state = s.borrow_mut();
                let previous = state.current.clone();
                if state.scopes.contains_key(&scope) {
                    state.current = scope;
                }
                previous
            },
        )?,
    )?;

    let (s, a) = (state.clone(), arg.clone());
    host.set(
        "leave",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| {
            let scope = a(&ctx, &args, 0);
            let mut state = s.borrow_mut();
            state.current = if scope == ROOT_SCOPE || state.scopes.contains_key(&scope) {
                scope
            } else {
                ROOT_SCOPE.to_owned()
            };
        })?,
    )?;

    let (s, a) = (state.clone(), arg.clone());
    host.set(
        "scopeCancel",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| {
            let scope = a(&ctx, &args, 0);
            if s.borrow().scopes.contains_key(&scope) {
                post(&json!({ "type": "scope_cancel", "scope": scope }));
            }
        })?,
    )?;

    let (s, a) = (state.clone(), arg);
    host.set(
        "scopeClose",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| {
            let scope = a(&ctx, &args, 0);
            let status = if a(&ctx, &args, 1) == "completed" {
                "completed"
            } else {
                "failed"
            };
            let mut state = s.borrow_mut();
            let Some(info) = state.scopes.get_mut(&scope) else {
                return;
            };
            if !info.open {
                return;
            }
            info.open = false;
            post(&json!({ "type": "scope_close", "scope": scope, "status": status }));
        })?,
    )?;

    ctx.globals().set("__ptc", host)
}
