//! `background-task` (`agent/features/background/index.ts`): the
//! `background_task` tool (reached from `ptc` scripts), the `/bg` command,
//! the status line and side panel, the `background_output` and
//! `background_stop` RPC commands, and wake-ups: finished tasks and
//! monitor matches are coalesced into one steering message while the agent
//! is idle.
//!
//! Panel updates: TS flushed `panelChanged` in a microtask. The feature
//! flushes where those microtasks ran relative to the lines around them:
//! at the end of a synchronous stretch (a command, a tool call, a driver's
//! callbacks), and after the RPC response when a command awaited first.

pub mod manager;

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::sync::LazyLock;

use indexmap::IndexMap;
use pirc_policy::truncate_output;
use serde_json::{Map, Value, json};

use crate::LocalBoxFuture;
use crate::agent::{Agent, Delivery};
use crate::feature::{Feature, FeatureCommand, off_in_mode};
use crate::tools::js::{self, JsRegex, js_regex};
use crate::tools::result_schema::{bool_, by_action, int, nullable, obj, one_of_strings, str_};
use crate::tools::{ToolContext, ToolResult, ToolSpec, spec_tool, typed};
use crate::ui::NotifyLevel;
use manager::{
    Hooks, MATCH_LIMIT, Outcome, StartOptions, TaskInfo, TaskManager, TaskStatus, WaitResult,
};

const HELP: &str = "/bg or /bg list — List tasks
/bg start <shell command> — Run in the background
/bg tty <shell command> — Run on a pseudo-terminal (accepts input)
/bg write <id> <text> — Send a line of input to a tty task
/bg output <id> [lines] — Show recent output (default: 200 lines)
/bg stop <id> — Stop the process group
/bg stop-all — Stop all tasks
Aborting a run does not stop background tasks; closing the session does.
Tasks run with the current user's permissions, not in a sandbox.";
/// Matched lines kept per task between wakeups.
const PENDING_MATCHES: usize = 20;
const MATCH_CHARS: usize = 500;

/// Node's `stripVTControlCharacters` pattern (`getAnsiRegExp`), which Bun
/// shares.
fn vt_controls() -> &'static JsRegex {
    js_regex!(
        "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
        "g"
    )
}

/// `clean`: terminal control sequences and control characters (but tab
/// and newline) removed.
pub fn clean(text: &str) -> String {
    let stripped = if text.contains(['\u{1b}', '\u{9b}']) {
        vt_controls().replace_all(text, "")
    } else {
        text.to_owned()
    };
    stripped
        .chars()
        .filter(|c| !matches!(c, '\0'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}'))
        .collect()
}

/// `summary(task)`: one line for lists and notices.
pub fn summary(task: &TaskInfo) -> String {
    let exit = match task.exit_code {
        Some(Some(code)) => format!(" (exit {code})"),
        _ => String::new(),
    };
    let tty = if task.tty { " · tty" } else { "" };
    let monitor = match &task.notify_on {
        Some(pattern) if !pattern.is_empty() => format!(
            " · notify_on /{pattern}/ ({} matches)",
            task.matches.unwrap_or(0)
        ),
        _ => String::new(),
    };
    // `.replace(/\s+/g, ' ')`.
    let mut command = String::new();
    let mut space = false;
    for c in clean(&task.command).chars() {
        if js::is_space(c) {
            space = true;
            continue;
        }
        if space {
            command.push(' ');
            space = false;
        }
        command.push(c);
    }
    if space {
        command.push(' ');
    }
    format!(
        "{} · {}{exit}{tty}{monitor} · {}",
        task.id,
        task.status.as_str(),
        js::head16(&command, 180)
    )
}

/// `tailLines(text, lines)`.
fn tail_lines(text: &str, lines: usize) -> String {
    let parts: Vec<&str> = text.split('\n').collect();
    parts[parts.len().saturating_sub(lines)..].join("\n")
}

/// `taskData(task)`: a task as the typed result shows it.
fn task_data(task: &TaskInfo) -> Value {
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(task.id));
    out.insert(
        "command".to_owned(),
        json!(js::head16(&clean(&task.command), 2000)),
    );
    out.insert("cwd".to_owned(), json!(task.cwd));
    out.insert("status".to_owned(), json!(task.status.as_str()));
    out.insert("logPath".to_owned(), json!(task.log_path));
    out.insert("startedAt".to_owned(), json!(task.started_at));
    if let Some(pid) = task.pid {
        out.insert("pid".to_owned(), json!(pid));
    }
    if let Some(code) = &task.exit_code {
        out.insert("exitCode".to_owned(), json!(code));
    }
    if let Some(signal) = &task.signal {
        out.insert("signal".to_owned(), json!(signal));
    }
    if task.tty {
        out.insert("tty".to_owned(), json!(true));
    }
    if let Some(pattern) = &task.notify_on {
        out.insert("notifyOn".to_owned(), json!(pattern));
    }
    if let Some(matches) = task.matches {
        out.insert("matches".to_owned(), json!(matches));
    }
    if let Some(ended) = &task.ended_at {
        out.insert("endedAt".to_owned(), json!(ended));
    }
    if let Some(error) = &task.error {
        out.insert("error".to_owned(), json!(error));
    }
    Value::Object(out)
}

/// A task with its command cut to 180 UTF-16 units (`details`).
fn task_detail(task: &TaskInfo) -> Value {
    let mut map = task.to_map();
    map.insert("command".to_owned(), json!(js::head16(&task.command, 180)));
    Value::Object(map)
}

/// A task without its log path, its command cleaned and cut to `limit`
/// (the panel and the RPC commands).
fn task_public(task: &TaskInfo, limit: Option<usize>) -> Value {
    let mut map = task.to_map();
    map.shift_remove("logPath");
    let command = clean(&task.command);
    let command = match limit {
        Some(limit) => js::head16(&command, limit).to_owned(),
        None => command,
    };
    map.insert("command".to_owned(), json!(command));
    Value::Object(map)
}

/// `unescapeInput`: `\n`, `\r`, `\t`, `\e`, `\xHH`, `\uHHHH` and `\\` in
/// typed `/bg write` text. A lone surrogate becomes U+FFFD, as writing it
/// to the terminal did.
pub fn unescape_input(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    let ascii = |unit: u16| u8::try_from(unit).ok().map(char::from);
    let hex = |digits: &[u16]| -> Option<u16> {
        let text: String = digits
            .iter()
            .map(|unit| ascii(*unit))
            .collect::<Option<_>>()?;
        if !text.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        u16::from_str_radix(&text, 16).ok()
    };
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        if units[at] == u16::from(b'\\') && at + 1 < units.len() {
            let next = ascii(units[at + 1]);
            let simple = match next {
                Some('n') => Some(u16::from(b'\n')),
                Some('r') => Some(u16::from(b'\r')),
                Some('t') => Some(u16::from(b'\t')),
                Some('e') => Some(0x1b),
                Some('\\') => Some(u16::from(b'\\')),
                _ => None,
            };
            if let Some(unit) = simple {
                out.push(unit);
                at += 2;
                continue;
            }
            let width = match next {
                Some('x') => 2,
                Some('u') => 4,
                _ => 0,
            };
            if width > 0
                && at + 2 + width <= units.len()
                && let Some(unit) = hex(&units[at + 2..at + 2 + width])
            {
                out.push(unit);
                at += 2 + width;
                continue;
            }
        }
        out.push(units[at]);
        at += 1;
    }
    String::from_utf16_lossy(&out)
}

/// `Number.isInteger(lines) && 1 <= lines <= 2000`.
fn check_lines(lines: f64) -> Result<usize, String> {
    if lines.fract() != 0.0 || !(1.0..=2000.0).contains(&lines) {
        return Err("lines must be an integer from 1 to 2000.".to_owned());
    }
    Ok(lines as usize)
}

/// What a monitor matched since the last wake-up, per task.
struct Matched {
    task: TaskInfo,
    lines: Vec<String>,
    dropped: usize,
}

/// The feature's state (the TS closure).
struct Background {
    agent: RefCell<Weak<Agent>>,
    closed: Cell<bool>,
    notice_pending: Cell<bool>,
    completed: RefCell<Vec<TaskInfo>>,
    matched: RefCell<IndexMap<String, Matched>>,
    manager: TaskManager,
}

impl Background {
    fn new() -> Rc<Self> {
        Rc::new_cyclic(|weak: &Weak<Background>| {
            let on_finish = weak.clone();
            let on_match = weak.clone();
            let env = weak.clone();
            let settled = weak.clone();
            Background {
                agent: RefCell::new(Weak::new()),
                closed: Cell::new(false),
                notice_pending: Cell::new(false),
                completed: RefCell::new(Vec::new()),
                matched: RefCell::new(IndexMap::new()),
                manager: TaskManager::new(Hooks {
                    on_finish: Some(Box::new(move |task| {
                        if let Some(state) = on_finish.upgrade() {
                            state.finished(task);
                        }
                    })),
                    on_match: Some(Box::new(move |task, line| {
                        if let Some(state) = on_match.upgrade() {
                            state.matched(task, &line);
                        }
                    })),
                    // `{...process.env, ...config.env}`: the agent's own
                    // environment is inherited.
                    env: Some(Box::new(move || {
                        env.upgrade()
                            .and_then(|state| state.agent())
                            .map(|agent| agent.config().env.clone())
                            .unwrap_or_default()
                    })),
                    settled: Some(Box::new(move || {
                        if let Some(agent) = settled.upgrade().and_then(|state| state.agent()) {
                            agent.flush_panel();
                        }
                    })),
                }),
            }
        })
    }

    fn agent(&self) -> Option<Rc<Agent>> {
        self.agent.borrow().upgrade()
    }

    fn set_agent(&self, agent: &Rc<Agent>) {
        *self.agent.borrow_mut() = Rc::downgrade(agent);
    }

    fn require_open(&self) -> Result<(), String> {
        if self.closed.get() {
            return Err("Background task runtime has shut down.".to_owned());
        }
        Ok(())
    }

    /// `refresh`: the panel section and the status line.
    fn refresh(&self) {
        let Some(agent) = self.agent() else {
            return;
        };
        if self.closed.get() {
            return;
        }
        agent.panel_changed("background");
        if !agent.has_ui() {
            return;
        }
        let running = self
            .manager
            .list()
            .iter()
            .filter(|task| matches!(task.status, TaskStatus::Running | TaskStatus::Stopping))
            .count();
        let text = format!("BG {running}");
        agent
            .ui()
            .set_status("background-task", (running > 0).then_some(text.as_str()));
    }

    /// `flush`: coalesce finished tasks and monitor matches into one
    /// wake-up while idle.
    fn flush(&self) {
        let Some(agent) = self.agent() else {
            return;
        };
        if self.closed.get() || self.notice_pending.get() || agent.is_running() {
            return;
        }
        if self.completed.borrow().is_empty() && self.matched.borrow().is_empty() {
            return;
        }
        let tasks = std::mem::take(&mut *self.completed.borrow_mut());
        let matches: Vec<Matched> = std::mem::take(&mut *self.matched.borrow_mut())
            .into_values()
            .collect();
        self.notice_pending.set(true);
        let mut parts = Vec::new();
        if !matches.is_empty() {
            let shown: Vec<String> = matches
                .iter()
                .map(|m| {
                    let lines: Vec<String> =
                        m.lines.iter().map(|line| format!("  {line}")).collect();
                    let dropped = if m.dropped > 0 {
                        format!(
                            "\n  [{} more matching line{}; use output]",
                            m.dropped,
                            if m.dropped == 1 { "" } else { "s" }
                        )
                    } else {
                        String::new()
                    };
                    let off = if m.task.matches.unwrap_or(0) >= MATCH_LIMIT {
                        format!("\n  [Monitor switched off after {MATCH_LIMIT} matches]")
                    } else {
                        String::new()
                    };
                    format!(
                        "{} /{}/:\n{}{dropped}{off}",
                        m.task.id,
                        m.task.notify_on.as_deref().unwrap_or(""),
                        lines.join("\n")
                    )
                })
                .collect();
            parts.push(format!(
                "Background output matched (notify_on):\n{}",
                shown.join("\n")
            ));
        }
        if !tasks.is_empty() {
            let shown: Vec<String> = tasks
                .iter()
                .map(|task| {
                    let exit = match task.exit_code {
                        Some(Some(code)) => format!(" (exit {code})"),
                        _ => String::new(),
                    };
                    format!("{} · {}{exit}", task.id, task.status.as_str())
                })
                .collect();
            parts.push(format!(
                "{} background task{} finished:\n{}",
                tasks.len(),
                if tasks.len() == 1 { "" } else { "s" },
                shown.join("\n")
            ));
        }
        parts.push("Use background_task list/output to inspect results.".to_owned());
        let status = match tasks.as_slice() {
            [task] => task.status.as_str(),
            [] => "matched",
            _ => "completed",
        };
        let details = json!({
            "status": status,
            "tasks": tasks.iter().map(TaskInfo::to_json).collect::<Vec<_>>(),
            "matches": matches.iter().map(|m| json!({
                "id": m.task.id, "lines": m.lines, "dropped": m.dropped,
            })).collect::<Vec<_>>(),
        });
        let custom_type = if tasks.is_empty() {
            "background-task-output"
        } else {
            "background-task-finished"
        };
        let _ = agent.deliver(
            Delivery {
                custom_type: custom_type.to_owned(),
                content: parts.join("\n"),
                display: true,
                details: Some(details),
            },
            true,
            false,
        );
    }

    /// The manager's `onFinish`.
    fn finished(&self, task: TaskInfo) {
        if self.closed.get() {
            return;
        }
        self.refresh();
        let level = if matches!(task.status, TaskStatus::Failed | TaskStatus::TimedOut) {
            NotifyLevel::Warning
        } else {
            NotifyLevel::Info
        };
        let message = format!("Background task: {}", summary(&task));
        self.completed.borrow_mut().push(task);
        if let Some(agent) = self.agent() {
            agent.ui().notify(&message, level);
        }
        self.flush();
    }

    /// The manager's `onMatch`.
    fn matched(&self, task: TaskInfo, line: &str) {
        if self.closed.get() {
            return;
        }
        {
            let mut matched = self.matched.borrow_mut();
            let entry = matched.entry(task.id.clone()).or_insert_with(|| Matched {
                task: task.clone(),
                lines: Vec::new(),
                dropped: 0,
            });
            entry.task = task;
            if entry.lines.len() < PENDING_MATCHES {
                entry
                    .lines
                    .push(js::head16(&clean(line), MATCH_CHARS).to_owned());
            } else {
                entry.dropped += 1;
            }
        }
        self.refresh();
        self.flush();
    }

    /// `outputOf(id, lines)`: the text for the model and the typed fields.
    fn output_of(&self, id: &str, lines: Option<f64>) -> Result<(String, Value), String> {
        let lines = check_lines(lines.unwrap_or(200.0))?;
        let task = self.manager.get(id)?;
        let raw = clean(&self.manager.output(id, lines)?);
        let markers: Vec<&str> = raw
            .split('\n')
            .filter(|line| {
                line.starts_with("[Output truncated:") || line.starts_with("[Log truncated:")
            })
            .collect();
        let markers = markers.join("\n");
        let (tail, truncated) = truncate_output(&tail_lines(&raw, lines), 48 * 1024);
        let cut = if truncated {
            format!(
                "[Display truncated]\n{}",
                if markers.is_empty() {
                    String::new()
                } else {
                    format!("{markers}\n")
                }
            )
        } else {
            String::new()
        };
        let text = format!(
            "{}\ncwd: {}\nLog (capped at 10 MiB): {}\n{cut}{tail}",
            summary(&task),
            task.cwd,
            task.log_path
        );
        Ok((
            text,
            json!({ "task": task_data(&task), "output": tail, "truncated": truncated }),
        ))
    }

    fn list_text(&self) -> String {
        let lines: Vec<String> = self.manager.list().iter().map(summary).collect();
        if lines.is_empty() {
            "No background tasks.".to_owned()
        } else {
            lines.join("\n")
        }
    }

    /// `/bg`.
    async fn command(&self, agent: &Rc<Agent>, args: &str) -> Result<(), String> {
        self.set_agent(agent);
        self.require_open()?;
        let args = js::trim(args);
        let (action, rest) = match args.find(js::is_space) {
            _ if args.is_empty() => ("list", ""),
            Some(at) => (&args[..at], args[at..].trim_start_matches(js::is_space)),
            None => (args, ""),
        };
        // After an await TS answered the RPC first: the panel update then
        // comes after the response.
        let mut awaited = false;
        let text = match action {
            "start" | "tty" => {
                let workspace = agent.config().workspace.clone();
                let task = self.manager.start(StartOptions {
                    command: rest,
                    cwd: &workspace,
                    tty: action == "tty",
                    ..StartOptions::default()
                })?;
                format!("{}\nLog: {}", summary(&task), task.log_path)
            }
            "write" => {
                let usage = || "Usage: /bg write <id> <text>".to_owned();
                let at = rest.find(js::is_space).ok_or_else(usage)?;
                let input = rest[at..].trim_start_matches(js::is_space);
                if input.is_empty() {
                    return Err(usage());
                }
                let task = self
                    .manager
                    .write(&rest[..at], &format!("{}\n", unescape_input(input)))?;
                summary(&task)
            }
            "list" => self.list_text(),
            "output" => {
                // `rest.split(/\s+/)`; `rest` has no whitespace at its ends.
                let parts: Vec<&str> = if rest.is_empty() {
                    vec![""]
                } else {
                    rest.split(js::is_space)
                        .filter(|part| !part.is_empty())
                        .collect()
                };
                let (id, lines) = match parts.as_slice() {
                    [id] if !id.is_empty() => (*id, 200.0),
                    [id, lines] => (*id, crate::compaction::to_number(&json!(lines))),
                    _ => return Err("Usage: /bg output <id> [lines]".to_owned()),
                };
                self.output_of(id, Some(lines))?.0
            }
            "stop" => {
                let task = self.manager.stop(js::trim(rest)).await?;
                awaited = true;
                summary(&task)
            }
            "stop-all" => {
                let running: Vec<String> = self
                    .manager
                    .list()
                    .into_iter()
                    .filter(|task| {
                        matches!(task.status, TaskStatus::Running | TaskStatus::Stopping)
                    })
                    .map(|task| task.id)
                    .collect();
                self.manager.stop_all(&running).await?;
                awaited = true;
                "All background tasks stopped.".to_owned()
            }
            _ => HELP.to_owned(),
        };
        self.refresh();
        // Recorded for the model, without triggering a turn.
        agent.deliver(
            Delivery {
                custom_type: "background-task-command".to_owned(),
                content: text,
                display: true,
                details: None,
            },
            false,
            false,
        )?;
        if awaited {
            let agent = agent.clone();
            tokio::task::spawn_local(async move { agent.flush_panel() });
        } else {
            agent.flush_panel();
        }
        Ok(())
    }

    /// The `background_task` tool.
    async fn execute(
        &self,
        agent: &Rc<Agent>,
        args: &Map<String, Value>,
        ctx: &ToolContext,
    ) -> Result<ToolResult, String> {
        if ctx.signal.aborted() {
            return Err("The operation was aborted.".to_owned());
        }
        self.require_open()?;
        self.set_agent(agent);
        let string = |key: &str| args.get(key).and_then(Value::as_str);
        let number = |key: &str| args.get(key).and_then(Value::as_f64);
        let action = args.get("action").map(js::string_of).unwrap_or_default();
        let mut wait: Option<WaitResult> = None;
        let (text, data) = match action.as_str() {
            "start" => {
                let command = string("command").unwrap_or_default();
                if js::trim(command).is_empty() {
                    return Err("command is required for start.".to_owned());
                }
                let cwd = args
                    .get("cwd")
                    .filter(|cwd| !cwd.is_null())
                    .map_or_else(|| ".".to_owned(), js::string_of);
                let cwd = resolve(&ctx.cwd, cwd.strip_prefix('@').unwrap_or(&cwd));
                let task = self.manager.start(StartOptions {
                    command,
                    cwd: &cwd,
                    timeout: number("timeout"),
                    tty: args.get("tty") == Some(&Value::Bool(true)),
                    notify_on: string("notify_on"),
                })?;
                (
                    format!(
                        "{}\nLog: {}\nStarted in background; this is not a completion result.",
                        summary(&task),
                        task.log_path
                    ),
                    json!({ "task": task_data(&task) }),
                )
            }
            "list" => (
                self.list_text(),
                json!({ "tasks": self.manager.list().iter().map(task_data).collect::<Vec<_>>() }),
            ),
            _ => {
                let Some(id) = string("id").filter(|id| !id.is_empty()) else {
                    return Err("id is required.".to_owned());
                };
                match action.as_str() {
                    "wait" => {
                        let result = self
                            .manager
                            .wait(id, number("timeout"), Some(&ctx.signal))
                            .await?;
                        let notice = match result.outcome {
                            Outcome::Finished => "Wait finished; check task status and exit code.",
                            Outcome::TimedOut => "Wait timed out; the job was not stopped.",
                            Outcome::Aborted => "Wait cancelled; the job was not stopped.",
                        };
                        let (shown, fields) = self.output_of(id, number("lines"))?;
                        // The model saw the result; do not also wake it for this task.
                        if result.outcome == Outcome::Finished {
                            let mut completed = self.completed.borrow_mut();
                            if let Some(index) = completed.iter().position(|task| task.id == id) {
                                completed.remove(index);
                            }
                        }
                        let mut data = json!({ "outcome": result.outcome.as_str() });
                        merge(&mut data, fields);
                        wait = Some(result);
                        (format!("{notice}\n{shown}"), data)
                    }
                    "write" => {
                        let Some(input) = string("input").filter(|input| !input.is_empty()) else {
                            return Err("input is required for write.".to_owned());
                        };
                        let task = self.manager.write(id, input)?;
                        // Give the program a moment to react so the reply includes its response.
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        let (shown, fields) =
                            self.output_of(&task.id, Some(number("lines").unwrap_or(40.0)))?;
                        let sent = js::len16(input);
                        let mut data = json!({ "sent": sent });
                        merge(&mut data, fields);
                        (format!("Sent {sent} characters.\n{shown}"), data)
                    }
                    "monitor" => {
                        let task = self.manager.monitor(id, string("notify_on"))?;
                        self.matched.borrow_mut().shift_remove(&task.id);
                        let text = match &task.notify_on {
                            Some(pattern) => {
                                format!("{}\nMonitoring output for /{pattern}/.", summary(&task))
                            }
                            None => format!("{}\nMonitor cleared.", summary(&task)),
                        };
                        (text, json!({ "task": task_data(&task) }))
                    }
                    "stop" => {
                        let task = self.manager.stop(id).await?;
                        (summary(&task), json!({ "task": task_data(&task) }))
                    }
                    "output" => self.output_of(id, number("lines"))?,
                    other => return Err(format!("Unknown action {other}")),
                }
            }
        };
        self.refresh();
        let mut details = Map::new();
        if let Some(wait) = &wait {
            details.insert(
                "wait".to_owned(),
                json!({ "outcome": wait.outcome.as_str(), "task": task_detail(&wait.task) }),
            );
        }
        details.insert(
            "tasks".to_owned(),
            Value::Array(self.manager.list().iter().map(task_detail).collect()),
        );
        let mut out = json!({ "action": action });
        merge(&mut out, data);
        Ok(typed(text, out, Some(Value::Object(details)), false))
    }
}

/// `{...a, ...b}` for objects.
fn merge(target: &mut Value, extra: Value) {
    if let (Value::Object(target), Value::Object(extra)) = (target, extra) {
        target.extend(extra);
    }
}

/// `path.resolve(cwd, p)`.
fn resolve(cwd: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        js::normalize(path)
    } else {
        js::join(cwd, path)
    };
    if joined.len() > 1 && joined.ends_with('/') {
        joined[..joined.len() - 1].to_owned()
    } else {
        joined
    }
}

static PARAMETERS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["start", "list", "output", "wait", "write", "monitor", "stop"],
            },
            "command": { "type": "string", "minLength": 1, "maxLength": 16000 },
            "cwd": {
                "type": "string",
                "description": "Working directory, relative to session cwd or absolute",
            },
            "timeout": {
                "type": "number",
                "exclusiveMinimum": 0,
                "maximum": 86400,
                "description": "Seconds: start job deadline (default unlimited), or wait deadline (default 60); wait timeout does not stop the job",
            },
            "id": { "type": "string" },
            "lines": { "type": "integer", "minimum": 1, "maximum": 2000 },
            "tty": {
                "type": "boolean",
                "description": "start: run on a pseudo-terminal that accepts input via write",
            },
            "notify_on": {
                "type": "string",
                "maxLength": 500,
                "description": "start/monitor: regular expression; matching output lines wake you. monitor without it clears the monitor",
            },
            "input": {
                "type": "string",
                "maxLength": 65536,
                "description": "write: raw text sent to the terminal; include \\n to press Enter",
            },
        },
        "required": ["action"],
        "additionalProperties": false,
    })
});

/// `BACKGROUND_RESULT`.
fn result_schema() -> Value {
    let task = obj(
        vec![
            ("id", str_(None)),
            ("command", str_(Some("Cut at 2000 characters"))),
            ("cwd", str_(None)),
            (
                "status",
                str_(Some(
                    "running, stopping, completed, failed, stopped or timed_out",
                )),
            ),
            ("pid", int(None)),
            ("exitCode", nullable(int(None))),
            ("signal", nullable(str_(None))),
            ("logPath", str_(None)),
            ("tty", bool_(None)),
            ("notifyOn", str_(None)),
            ("matches", int(None)),
            ("startedAt", str_(None)),
            ("endedAt", str_(None)),
            ("error", str_(None)),
        ],
        &[
            "pid", "exitCode", "signal", "tty", "notifyOn", "matches", "endedAt", "error",
        ],
    );
    let output = || {
        vec![
            (
                "output",
                str_(Some(
                    "The latest output lines (terminal control characters removed)",
                )),
            ),
            (
                "truncated",
                bool_(Some("Display cut; the whole log is at task.logPath")),
            ),
        ]
    };
    let with_output = |mut first: Vec<(&'static str, Value)>| {
        first.extend(output());
        first
    };
    by_action(vec![
        ("start", vec![("task", task.clone())], &[]),
        (
            "list",
            vec![("tasks", json!({ "type": "array", "items": task.clone() }))],
            &[],
        ),
        ("output", with_output(vec![("task", task.clone())]), &[]),
        (
            "wait",
            with_output(vec![
                (
                    "outcome",
                    one_of_strings(
                        &["finished", "timed_out", "aborted"],
                        Some("timed_out: the job still runs"),
                    ),
                ),
                ("task", task.clone()),
            ]),
            &[],
        ),
        (
            "write",
            with_output(vec![
                ("task", task.clone()),
                ("sent", int(Some("Characters sent"))),
            ]),
            &[],
        ),
        ("monitor", vec![("task", task.clone())], &[]),
        ("stop", vec![("task", task)], &[]),
    ])
}

/// `background_task`.
struct BackgroundTool {
    spec: ToolSpec,
    state: Rc<Background>,
    agent: Weak<Agent>,
}

impl BackgroundTool {
    fn new(state: Rc<Background>, agent: &Rc<Agent>) -> Self {
        Self {
            spec: ToolSpec::new("background_task", PARAMETERS.clone(), Some(result_schema())),
            state,
            agent: Rc::downgrade(agent),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let agent = self
            .agent
            .upgrade()
            .ok_or_else(|| "Background task runtime has shut down.".to_owned())?;
        let result = self.state.execute(&agent, &args, &ctx).await;
        // TS's microtasks ran before the agent saw the result.
        agent.flush_panel();
        result
    }
}

spec_tool!(BackgroundTool, ptc: true);

/// `backgroundFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(BackgroundFeature {
        state: Background::new(),
    })
}

struct BackgroundFeature {
    state: Rc<Background>,
}

const RPC_TYPES: &[&str] = &["background_output", "background_stop"];

impl Feature for BackgroundFeature {
    fn name(&self) -> &'static str {
        "background-task"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn crate::tools::Tool>> {
        if off_in_mode(agent, "background") {
            return Vec::new();
        }
        vec![Rc::new(BackgroundTool::new(self.state.clone(), agent))]
    }

    fn commands(&self) -> Vec<FeatureCommand> {
        vec![FeatureCommand::new(
            "bg",
            "Background tasks: list / start / tty / write / output / stop / stop-all",
        )]
    }

    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        _name: &'a str,
        args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.state.command(agent, &args).await })
    }

    fn init<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.state.set_agent(agent);
            self.state.refresh();
            agent.flush_panel();
            Ok(())
        })
    }

    fn agent_settled<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.state.notice_pending.set(false);
            self.state.flush();
            Ok(())
        })
    }

    fn panel(&self, _agent: &Rc<Agent>) -> Option<Map<String, Value>> {
        let tasks: Vec<Value> = self
            .state
            .manager
            .list()
            .iter()
            .map(|task| task_public(task, Some(2000)))
            .collect();
        let mut out = Map::new();
        out.insert("backgroundTasks".to_owned(), Value::Array(tasks));
        Some(out)
    }

    fn rpc_types(&self) -> &'static [&'static str] {
        RPC_TYPES
    }

    fn rpc<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        kind: &'a str,
        command: &'a Value,
    ) -> LocalBoxFuture<'a, Result<Option<Value>, String>> {
        Box::pin(async move {
            let state = &self.state;
            let id = command
                .get("taskId")
                .filter(|id| !id.is_null())
                .map(js::string_of)
                .unwrap_or_default();
            if kind == "background_output" {
                let lines = match command.get("lines") {
                    None | Some(Value::Null) => 400.0,
                    Some(lines) => crate::compaction::to_number(lines),
                };
                let task = state.manager.get(&id)?;
                let lines = check_lines(lines)?;
                let raw = clean(&state.manager.output(&id, lines)?);
                let (output, _) = truncate_output(&tail_lines(&raw, lines), 64 * 1024);
                return Ok(Some(
                    json!({ "task": task_public(&task, None), "output": output }),
                ));
            }
            // `background_stop`: answers at once (status `stopping`); the
            // finish flows through the usual completion notice.
            state.set_agent(agent);
            state.require_open()?;
            let before = state.manager.get(&id)?;
            if before.status == TaskStatus::Running {
                let weak = Rc::downgrade(state);
                state.manager.stop_then(
                    &id,
                    Box::new(move || {
                        if let Some(state) = weak.upgrade() {
                            state.refresh();
                        }
                    }),
                )?;
                state.refresh();
            }
            let task = state.manager.get(&id)?;
            agent.flush_panel();
            Ok(Some(json!({ "task": task_public(&task, None) })))
        })
    }

    fn shutdown<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, ()> {
        Box::pin(async move {
            self.state.closed.set(true);
            if agent.has_ui() {
                agent.ui().set_status("background-task", None);
            }
            self.state.manager.shutdown().await;
        })
    }
}

#[cfg(test)]
mod tests;
