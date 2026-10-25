//! `TaskManager` (`agent/features/background/manager.ts`), the port of Pi's
//! background-task manager: `bash -c` commands in their own process group
//! with pipes (no stdin) or, with `tty`, on a pseudo-terminal that accepts
//! input; either can watch its output for a pattern and report matching
//! lines.
//!
//! Each task has a driver (a local task) that owns the child, reads its
//! output and runs the timers TS ran with `setTimeout`; everything else
//! changes the task's state synchronously, as the TS methods did, and wakes
//! the driver. Callbacks into the feature run with no borrow held.

use std::cell::{Cell, RefCell};
use std::fs::File;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::time::Duration;

use indexmap::IndexMap;
use nix::sys::signal::Signal;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::time::{Instant, sleep, sleep_until};

use crate::signal::AbortSignal;
use crate::tools::bash::{GroupGuard, StreamDecoder, kill_group};
use crate::tools::js::{self, JsRegex, js_regex};

/// `TaskStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Running,
    Stopping,
    Completed,
    Failed,
    Stopped,
    TimedOut,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::TimedOut => "timed_out",
        }
    }
}

/// Why a task was stopped (`reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    Stopped,
    TimedOut,
}

/// `TaskInfo`.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskInfo {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub status: TaskStatus,
    pub pid: Option<u32>,
    /// `undefined` until the shell exited; `null` when a signal ended it.
    pub exit_code: Option<Option<i32>>,
    pub signal: Option<Option<String>>,
    pub log_path: String,
    /// Runs on a pseudo-terminal and accepts input.
    pub tty: bool,
    /// Output lines matching this pattern are reported (monitor mode).
    pub notify_on: Option<String>,
    /// Monitor matches so far.
    pub matches: Option<u32>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub error: Option<String>,
}

impl TaskInfo {
    /// The object as TS built it (keys in the order they were set).
    pub fn to_map(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("id".to_owned(), json!(self.id));
        out.insert("command".to_owned(), json!(self.command));
        out.insert("cwd".to_owned(), json!(self.cwd));
        out.insert("status".to_owned(), json!(self.status.as_str()));
        if let Some(pid) = self.pid {
            out.insert("pid".to_owned(), json!(pid));
        }
        out.insert("logPath".to_owned(), json!(self.log_path));
        if self.tty {
            out.insert("tty".to_owned(), json!(true));
        }
        if let Some(pattern) = &self.notify_on {
            out.insert("notifyOn".to_owned(), json!(pattern));
        }
        if let Some(matches) = self.matches {
            out.insert("matches".to_owned(), json!(matches));
        }
        out.insert("startedAt".to_owned(), json!(self.started_at));
        if let Some(error) = &self.error {
            out.insert("error".to_owned(), json!(error));
        }
        if let Some(code) = &self.exit_code {
            out.insert("exitCode".to_owned(), json!(code));
        }
        if let Some(signal) = &self.signal {
            out.insert("signal".to_owned(), json!(signal));
        }
        if let Some(ended) = &self.ended_at {
            out.insert("endedAt".to_owned(), json!(ended));
        }
        out
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.to_map())
    }
}

/// `WaitResult['outcome']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Finished,
    TimedOut,
    Aborted,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::TimedOut => "timed_out",
            Self::Aborted => "aborted",
        }
    }
}

/// `WaitResult`.
#[derive(Clone, Debug)]
pub struct WaitResult {
    pub outcome: Outcome,
    pub task: TaskInfo,
}

const TAIL_LIMIT: usize = 1024 * 1024;
const LOG_LIMIT: usize = 10 * 1024 * 1024;
pub const ACTIVE_LIMIT: usize = 8;
const HISTORY_LIMIT: usize = 100;
const LINE_LIMIT: usize = 4096;
const INPUT_LIMIT: usize = 64 * 1024;
/// Monitor matches reported per task before the monitor switches itself off.
pub const MATCH_LIMIT: u32 = 200;
/// How long a stopped group gets between SIGTERM and SIGKILL, and a
/// finished shell's leftovers to release its pipes.
const KILL_DELAY: Duration = Duration::from_millis(500);
/// How long a terminal drains after its shell exited.
const DRAIN_DELAY: Duration = Duration::from_millis(50);

/// `ANSI`: escape sequences removed from monitored lines.
fn ansi() -> &'static JsRegex {
    js_regex!(
        r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])",
        "g"
    )
}

/// `compileMonitor(pattern)`: the regex and its `source`.
pub fn compile_monitor(pattern: &str) -> Result<(JsRegex, String), String> {
    if pattern.is_empty() || js::len16(pattern) > 500 {
        return Err("notify_on must be a regular expression of 1–500 characters".to_owned());
    }
    let regex =
        JsRegex::new(pattern, "").map_err(|error| format!("Invalid notify_on pattern: {error}"))?;
    Ok((regex, pattern.to_owned()))
}

/// `text.split(/\r?\n|\r(?!\n)/)`.
fn split_lines(text: &str) -> Vec<String> {
    let mut lines = vec![String::new()];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                lines.push(String::new());
            }
            '\n' => lines.push(String::new()),
            c => lines.last_mut().expect("a line").push(c),
        }
    }
    lines
}

/// Environment variables for a new task.
pub type EnvFn = Box<dyn Fn() -> Vec<(String, String)>>;

/// What the manager tells its owner.
#[derive(Default)]
pub struct Hooks {
    /// A task finished (not during shutdown).
    pub on_finish: Option<Box<dyn Fn(TaskInfo)>>,
    /// A monitored task printed a line that matches its pattern.
    pub on_match: Option<Box<dyn Fn(TaskInfo, String)>>,
    /// Extra environment for new tasks (over the agent's own).
    pub env: Option<EnvFn>,
    /// A driver ran callbacks and ended its synchronous stretch (the
    /// feature flushes its panel changes here); not called when a finish
    /// woke a `wait`, whose continuation flushes itself.
    pub settled: Option<Box<dyn Fn()>>,
}

struct Monitor {
    pattern: Rc<JsRegex>,
    decoder: StreamDecoder,
    partial: String,
}

/// What the driver's timer does when it fires (`killTimer`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KillTimer {
    /// `requestStop`'s: SIGKILL the group, then finish.
    Kill,
    /// After the shell exited: finish even if leftovers hold the pipes.
    Disconnect,
}

struct State {
    info: TaskInfo,
    /// Input waiting to be written to the terminal.
    input: Vec<u8>,
    terminal_open: bool,
    file: Option<File>,
    monitor: Option<Monitor>,
    tail: Vec<u8>,
    bytes: usize,
    tail_truncated: bool,
    log_truncated: bool,
    timeout_at: Option<Instant>,
    kill_at: Option<(Instant, KillTimer)>,
    /// A terminal task closes this long after its shell exited.
    close_at: Option<Instant>,
    reason: Option<Reason>,
    finished: bool,
    /// `wait` calls in progress.
    waiting: usize,
    /// Run right after the finish callback (`stop(id).then(…)`).
    on_done: Vec<Box<dyn FnOnce()>>,
}

struct Record {
    state: RefCell<State>,
    /// Finished (`done`, `waiters`).
    done: Notify,
    /// Wakes the driver after a stop request or input.
    wake: Notify,
}

impl Record {
    fn info(&self) -> TaskInfo {
        self.state.borrow().info.clone()
    }

    fn finished(&self) -> bool {
        self.state.borrow().finished
    }

    /// Resolves once finished.
    async fn finish_signal(&self) {
        loop {
            let notified = self.done.notified();
            if self.finished() {
                return;
            }
            notified.await;
        }
    }
}

struct Inner {
    records: RefCell<IndexMap<String, Rc<Record>>>,
    directory: RefCell<Option<PathBuf>>,
    closing: Cell<bool>,
    hooks: Hooks,
    shell: String,
}

/// `TaskManager`.
#[derive(Clone)]
pub struct TaskManager(Rc<Inner>);

/// `start`'s options.
#[derive(Clone, Copy, Debug, Default)]
pub struct StartOptions<'a> {
    pub command: &'a str,
    pub cwd: &'a str,
    /// Seconds.
    pub timeout: Option<f64>,
    pub tty: bool,
    pub notify_on: Option<&'a str>,
}

impl TaskManager {
    pub fn new(hooks: Hooks) -> Self {
        Self::with_shell("bash", hooks)
    }

    /// A manager running another bash (tests).
    pub fn with_shell(shell: &str, hooks: Hooks) -> Self {
        Self(Rc::new(Inner {
            records: RefCell::new(IndexMap::new()),
            directory: RefCell::new(None),
            closing: Cell::new(false),
            hooks,
            shell: shell.to_owned(),
        }))
    }

    /// `start`: needs a `LocalSet` (the driver is a local task).
    pub fn start(&self, options: StartOptions<'_>) -> Result<TaskInfo, String> {
        if self.0.closing.get() {
            return Err("Task manager is shut down".to_owned());
        }
        let command = options.command;
        if js::trim(command).is_empty() || js::len16(command) > 16000 || command.contains('\0') {
            return Err(
                "command must be a nonempty string of at most 16000 characters without NUL characters"
                    .to_owned(),
            );
        }
        if !options.cwd.starts_with('/') || !Path::new(options.cwd).is_dir() {
            return Err("cwd must be an existing absolute directory".to_owned());
        }
        if let Some(timeout) = options.timeout
            && (!timeout.is_finite() || timeout <= 0.0 || timeout * 1000.0 > 2_147_483_647.0)
        {
            return Err("timeout must be positive seconds, at most 2147483.647".to_owned());
        }
        let pattern = options.notify_on.map(compile_monitor).transpose()?;
        if self.active_count() >= ACTIVE_LIMIT {
            return Err(format!(
                "At most {ACTIVE_LIMIT} background tasks may be active"
            ));
        }
        {
            let mut records = self.0.records.borrow_mut();
            if records.len() >= HISTORY_LIMIT
                && let Some(oldest) = records
                    .iter()
                    .find(|(_, record)| record.finished())
                    .map(|(id, _)| id.clone())
            {
                records.shift_remove(&oldest);
            }
        }
        let directory = self.directory()?;
        let id = crate::random_uuid()[..8].to_owned();
        let log_path = directory.join(format!("{id}.log"));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&log_path)
            .map_err(|error| js::fs_error(&error, "open", Some(&log_path.display().to_string())))?;
        let env = self
            .0
            .hooks
            .env
            .as_ref()
            .map(|env| env())
            .unwrap_or_default();
        let spawned = if options.tty {
            spawn_tty(&self.0.shell, command, options.cwd, &env)
        } else {
            spawn_piped(&self.0.shell, command, options.cwd, &env)
        };
        let child = spawned.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!("Executable not found in $PATH: \"{}\"", self.0.shell)
            } else {
                error.to_string()
            }
        })?;
        let (pattern, source) = match pattern {
            Some((regex, source)) => (Some(regex), Some(source)),
            None => (None, None),
        };
        let info = TaskInfo {
            id: id.clone(),
            command: command.to_owned(),
            cwd: options.cwd.to_owned(),
            status: TaskStatus::Running,
            pid: child.pid(),
            exit_code: None,
            signal: None,
            log_path: log_path.display().to_string(),
            tty: options.tty,
            matches: source.as_ref().map(|_| 0),
            notify_on: source,
            started_at: now_iso(),
            ended_at: None,
            error: None,
        };
        let record = Rc::new(Record {
            state: RefCell::new(State {
                info: info.clone(),
                input: Vec::new(),
                terminal_open: options.tty,
                file: Some(file),
                monitor: pattern.map(|pattern| Monitor {
                    pattern: Rc::new(pattern),
                    decoder: StreamDecoder::default(),
                    partial: String::new(),
                }),
                tail: Vec::new(),
                bytes: 0,
                tail_truncated: false,
                log_truncated: false,
                timeout_at: options
                    .timeout
                    .map(|seconds| Instant::now() + Duration::from_secs_f64(seconds)),
                kill_at: None,
                close_at: None,
                reason: None,
                finished: false,
                waiting: 0,
                on_done: Vec::new(),
            }),
            done: Notify::new(),
            wake: Notify::new(),
        });
        self.0.records.borrow_mut().insert(id, record.clone());
        let manager = self.clone();
        tokio::task::spawn_local(async move { manager.drive(record, child).await });
        Ok(info)
    }

    /// The directory of the logs (`mkdtemp(<tmp>/pirc-background-XXXXXX)`).
    fn directory(&self) -> Result<PathBuf, String> {
        if let Some(directory) = self.0.directory.borrow().as_ref() {
            return Ok(directory.clone());
        }
        let base = std::env::temp_dir();
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        loop {
            let mut bytes = [0u8; 6];
            getrandom::fill(&mut bytes).expect("the system random number generator");
            let suffix: String = bytes
                .iter()
                .map(|b| CHARS[usize::from(*b) % CHARS.len()] as char)
                .collect();
            let path = base.join(format!("pirc-background-{suffix}"));
            match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => {
                    *self.0.directory.borrow_mut() = Some(path.clone());
                    return Ok(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(js::fs_error(
                        &error,
                        "mkdtemp",
                        Some(&format!("{}/pirc-background-XXXXXX", base.display())),
                    ));
                }
            }
        }
    }

    pub fn list(&self) -> Vec<TaskInfo> {
        self.0
            .records
            .borrow()
            .values()
            .map(|record| record.info())
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<TaskInfo, String> {
        Ok(self.lookup(id)?.info())
    }

    /// `activeCount`.
    pub fn active_count(&self) -> usize {
        self.0
            .records
            .borrow()
            .values()
            .filter(|record| !record.finished())
            .count()
    }

    fn lookup(&self, id: &str) -> Result<Rc<Record>, String> {
        self.0
            .records
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown background task: {id}"))
    }

    /// `output(id, lines)`: the retained tail's last lines, after notices of
    /// what was cut.
    pub fn output(&self, id: &str, lines: usize) -> Result<String, String> {
        if lines == 0 {
            return Err("lines must be a positive safe integer".to_owned());
        }
        let record = self.lookup(id)?;
        let state = record.state.borrow();
        let text = String::from_utf8_lossy(&state.tail);
        let mut parts: Vec<&str> = text.split('\n').collect();
        if parts.last() == Some(&"") {
            parts.pop();
        }
        let mut out: Vec<&str> = Vec::new();
        if state.tail_truncated {
            out.push("[Output truncated: showing the retained 1 MiB tail.]");
        }
        if state.log_truncated {
            out.push("[Log truncated: the log file contains only the first 10 MiB.]");
        }
        let keep = lines.min(parts.len());
        out.extend(&parts[parts.len() - keep..]);
        Ok(out.join("\n"))
    }

    /// `wait(id, {timeout, signal})`: until the task finishes, the timeout
    /// (seconds, default 60) passes or `signal` aborts.
    pub async fn wait(
        &self,
        id: &str,
        timeout: Option<f64>,
        signal: Option<&AbortSignal>,
    ) -> Result<WaitResult, String> {
        let record = self.lookup(id)?;
        let timeout = timeout.unwrap_or(60.0);
        if !timeout.is_finite() || timeout <= 0.0 || timeout > 86400.0 {
            return Err("wait timeout must be positive seconds, at most 86400".to_owned());
        }
        let result = |outcome| WaitResult {
            outcome,
            task: record.info(),
        };
        if signal.is_some_and(AbortSignal::aborted) {
            return Ok(result(Outcome::Aborted));
        }
        if record.finished() {
            return Ok(result(Outcome::Finished));
        }
        struct Waiting(Rc<Record>);
        impl Drop for Waiting {
            fn drop(&mut self) {
                self.0.state.borrow_mut().waiting -= 1;
            }
        }
        record.state.borrow_mut().waiting += 1;
        let _waiting = Waiting(record.clone());
        let aborted = async {
            match signal {
                Some(signal) => signal.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let outcome = tokio::select! {
            () = record.finish_signal() => Outcome::Finished,
            () = sleep(Duration::from_secs_f64(timeout)) => Outcome::TimedOut,
            () = aborted => Outcome::Aborted,
        };
        Ok(result(outcome))
    }

    /// `write(id, input)`: send input to a terminal task (keystrokes: `\n`
    /// for Enter, `\u0003` for Ctrl-C, `\u0004` for EOF).
    pub fn write(&self, id: &str, input: &str) -> Result<TaskInfo, String> {
        let record = self.lookup(id)?;
        if input.is_empty() || js::len16(input) > INPUT_LIMIT {
            return Err(format!("input must be 1–{INPUT_LIMIT} characters"));
        }
        let mut state = record.state.borrow_mut();
        if !state.info.tty {
            return Err(format!(
                "Task {id} has no terminal; start it with tty: true"
            ));
        }
        if state.finished || state.reason.is_some() || !state.terminal_open {
            return Err(format!("Task {id} is not running"));
        }
        state.input.extend_from_slice(input.as_bytes());
        let info = state.info.clone();
        drop(state);
        record.wake.notify_one();
        Ok(info)
    }

    /// `monitor(id, pattern)`: start, replace or (with `None`) clear a
    /// task's output monitor.
    pub fn monitor(&self, id: &str, pattern: Option<&str>) -> Result<TaskInfo, String> {
        let record = self.lookup(id)?;
        if record.finished() {
            return Err(format!("Task {id} has finished"));
        }
        let compiled = pattern.map(compile_monitor).transpose()?;
        let mut state = record.state.borrow_mut();
        match compiled {
            None => {
                state.monitor = None;
                state.info.notify_on = None;
            }
            Some((regex, source)) => {
                state.monitor = Some(Monitor {
                    pattern: Rc::new(regex),
                    decoder: StreamDecoder::default(),
                    partial: String::new(),
                });
                state.info.notify_on = Some(source);
                state.info.matches = Some(0);
            }
        }
        Ok(state.info.clone())
    }

    /// `stop(id)`: stop the process group and wait until the task finished.
    pub async fn stop(&self, id: &str) -> Result<TaskInfo, String> {
        let record = match self.lookup(id) {
            Ok(record) => record,
            Err(error) => {
                // An `async` method rejects; its caller sees it a turn later.
                tokio::task::yield_now().await;
                return Err(error);
            }
        };
        request_stop(&record, Reason::Stopped);
        if record.finished() {
            // `await record.done` takes a turn even when it is resolved.
            tokio::task::yield_now().await;
        } else {
            record.finish_signal().await;
        }
        Ok(record.info())
    }

    /// Stop these tasks together (`Promise.all(ids.map(stop))`): every stop
    /// is requested first.
    pub async fn stop_all(&self, ids: &[String]) -> Result<(), String> {
        let records = ids
            .iter()
            .map(|id| self.lookup(id))
            .collect::<Result<Vec<_>, _>>()?;
        for record in &records {
            request_stop(record, Reason::Stopped);
        }
        for record in &records {
            record.finish_signal().await;
        }
        Ok(())
    }

    /// `void stop(id).then(then)`: request the stop now; `then` runs right
    /// after the task's finish callback. The task must be running.
    pub fn stop_then(&self, id: &str, then: Box<dyn FnOnce()>) -> Result<(), String> {
        let record = self.lookup(id)?;
        request_stop(&record, Reason::Stopped);
        let mut state = record.state.borrow_mut();
        if state.finished {
            drop(state);
            then();
        } else {
            state.on_done.push(then);
        }
        Ok(())
    }

    /// `shutdown`: stop every task and wait for them; no finish callbacks.
    pub async fn shutdown(&self) {
        self.0.closing.set(true);
        let records: Vec<Rc<Record>> = self.0.records.borrow().values().cloned().collect();
        for record in &records {
            request_stop(record, Reason::Stopped);
        }
        for record in &records {
            record.finish_signal().await;
        }
    }

    /// The driver: output, exit, timers and input of one task, until it
    /// finished. Dropping it (the runtime ends) kills the process group.
    async fn drive(self, record: Rc<Record>, child: Spawned) {
        let pid = child.pid();
        // Kills leftovers when the task finished (or the driver is dropped).
        let _group = GroupGuard::new(pid);
        match child {
            Spawned::Piped(child) => self.drive_piped(&record, child, pid).await,
            Spawned::Tty(child, pty) => self.drive_tty(&record, child, pty, pid).await,
        }
    }

    async fn drive_piped(
        &self,
        record: &Rc<Record>,
        mut child: tokio::process::Child,
        pid: Option<u32>,
    ) {
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let mut out_buffer = vec![0u8; 65_536];
        let mut err_buffer = vec![0u8; 65_536];
        let mut exited = false;
        let mut pipes_seen = false;
        while !record.finished() {
            let (timeout_at, kill_at) = {
                let state = record.state.borrow();
                (state.timeout_at, state.kill_at)
            };
            let mut chunk: Option<(bool, usize)> = None;
            let wake = record.wake.notified();
            tokio::select! {
                read = async { stdout.as_mut().expect("stdout").read(&mut out_buffer).await }, if stdout.is_some() => {
                    match read {
                        Ok(0) | Err(_) => stdout = None,
                        Ok(n) => chunk = Some((true, n)),
                    }
                }
                read = async { stderr.as_mut().expect("stderr").read(&mut err_buffer).await }, if stderr.is_some() => {
                    match read {
                        Ok(0) | Err(_) => stderr = None,
                        Ok(n) => chunk = Some((false, n)),
                    }
                }
                status = child.wait(), if !exited => {
                    exited = true;
                    let reason = self.exited(record, status.ok());
                    // The shell exited; kill leftovers that still hold the pipes.
                    if reason.is_none() {
                        kill_group(pid, Signal::SIGKILL);
                        record.state.borrow_mut().kill_at =
                            Some((Instant::now() + KILL_DELAY, KillTimer::Disconnect));
                    }
                }
                () = async { sleep_until(timeout_at.expect("a deadline")).await }, if timeout_at.is_some() => {
                    record.state.borrow_mut().timeout_at = None;
                    request_stop(record, Reason::TimedOut);
                }
                () = async { sleep_until(kill_at.expect("a deadline").0).await }, if kill_at.is_some() => {
                    let kind = kill_at.expect("a deadline").1;
                    record.state.borrow_mut().kill_at = None;
                    if kind == KillTimer::Kill {
                        kill_group(pid, Signal::SIGKILL);
                    }
                    // `disconnectAndFinish`: the pipes are dropped with the driver.
                    self.finish_and_settle(record);
                }
                () = wake => {}
            }
            if let Some((is_stdout, n)) = chunk {
                let data = if is_stdout {
                    &out_buffer[..n]
                } else {
                    &err_buffer[..n]
                };
                self.append_and_settle(record, data);
            }
            // `pipes.then(…)`, registered when the shell exited.
            if exited && !pipes_seen && stdout.is_none() && stderr.is_none() {
                pipes_seen = true;
                let finish = {
                    let state = record.state.borrow();
                    state.reason.is_none() || state.kill_at.is_none()
                };
                if finish {
                    self.finish_and_settle(record);
                }
            }
        }
    }

    async fn drive_tty(
        &self,
        record: &Rc<Record>,
        mut child: tokio::process::Child,
        pty: pty_process::Pty,
        pid: Option<u32>,
    ) {
        let (mut reader, mut writer) = pty.into_split();
        let mut reading = true;
        let mut buffer = vec![0u8; 65_536];
        let mut exited = false;
        while !record.finished() {
            let (timeout_at, kill_at, close_at, input) = {
                let state = record.state.borrow();
                (
                    state.timeout_at,
                    state.kill_at,
                    state.close_at,
                    (!state.input.is_empty()).then(|| state.input.clone()),
                )
            };
            let mut chunk = None;
            let wake = record.wake.notified();
            tokio::select! {
                read = reader.read(&mut buffer), if reading => {
                    match read {
                        // EIO once the last process holding the terminal exited.
                        Ok(0) | Err(_) => reading = false,
                        Ok(n) => chunk = Some(n),
                    }
                }
                written = async { writer.write(input.as_deref().expect("input")).await }, if input.is_some() => {
                    let mut state = record.state.borrow_mut();
                    match written {
                        Ok(n) => {
                            state.input.drain(..n);
                        }
                        Err(_) => state.input.clear(),
                    }
                }
                status = child.wait(), if !exited => {
                    exited = true;
                    let reason = self.exited(record, status.ok());
                    // Kill leftovers, let the terminal drain, then close it.
                    if reason.is_none() {
                        kill_group(pid, Signal::SIGKILL);
                    }
                    record.state.borrow_mut().close_at = Some(Instant::now() + DRAIN_DELAY);
                }
                () = async { sleep_until(timeout_at.expect("a deadline")).await }, if timeout_at.is_some() => {
                    record.state.borrow_mut().timeout_at = None;
                    request_stop(record, Reason::TimedOut);
                }
                () = async { sleep_until(kill_at.expect("a deadline").0).await }, if kill_at.is_some() => {
                    record.state.borrow_mut().kill_at = None;
                    kill_group(pid, Signal::SIGKILL);
                    self.finish_and_settle(record);
                }
                () = async { sleep_until(close_at.expect("a deadline")).await }, if close_at.is_some() => {
                    self.finish_and_settle(record);
                }
                () = wake => {}
            }
            if let Some(n) = chunk {
                self.append_and_settle(record, &buffer[..n]);
            }
        }
    }

    /// `child.exited`: the codes; the stop reason, if any.
    fn exited(&self, record: &Record, status: Option<std::process::ExitStatus>) -> Option<Reason> {
        use std::os::unix::process::ExitStatusExt;
        let mut state = record.state.borrow_mut();
        state.timeout_at = None;
        let signal = status.and_then(|status| status.signal()).map(|number| {
            Signal::try_from(number)
                .map(|signal| signal.as_str().to_owned())
                .unwrap_or_else(|_| format!("SIG{number}"))
        });
        state.info.exit_code = Some(match &signal {
            Some(_) => None,
            None => Some(status.and_then(|status| status.code()).unwrap_or(-1)),
        });
        state.info.signal = Some(signal);
        state.reason
    }

    fn append_and_settle(&self, record: &Rc<Record>, data: &[u8]) {
        let matches = append(record, data);
        if !matches.is_empty() {
            self.report(matches);
            self.settled();
        }
    }

    fn report(&self, matches: Vec<(TaskInfo, String)>) {
        if let Some(on_match) = &self.0.hooks.on_match {
            for (task, line) in matches {
                on_match(task, line);
            }
        }
    }

    fn settled(&self) {
        if let Some(settled) = &self.0.hooks.settled {
            settled();
        }
    }

    fn finish_and_settle(&self, record: &Rc<Record>) {
        if self.finish(record) {
            self.settled();
        }
    }

    /// `finish`; whether the driver's stretch settles here (no `wait` was
    /// woken).
    fn finish(&self, record: &Rc<Record>) -> bool {
        let matches = {
            let mut state = record.state.borrow_mut();
            if state.finished {
                return false;
            }
            scan(&mut state, &[], true)
        };
        self.report(matches);
        let (info, waited, on_done) = {
            let mut state = record.state.borrow_mut();
            state.finished = true;
            state.terminal_open = false;
            state.timeout_at = None;
            state.kill_at = None;
            state.close_at = None;
            state.file = None;
            state.info.status = match state.reason {
                Some(Reason::Stopped) => TaskStatus::Stopped,
                Some(Reason::TimedOut) => TaskStatus::TimedOut,
                None if state.info.exit_code == Some(Some(0)) && state.info.error.is_none() => {
                    TaskStatus::Completed
                }
                None => TaskStatus::Failed,
            };
            state.info.ended_at = Some(now_iso());
            (
                state.info.clone(),
                state.waiting > 0,
                std::mem::take(&mut state.on_done),
            )
        };
        record.done.notify_waiters();
        if !self.0.closing.get()
            && let Some(on_finish) = &self.0.hooks.on_finish
        {
            on_finish(info);
        }
        for then in on_done {
            then();
        }
        !waited
    }
}

/// `requestStop`: SIGTERM now, SIGKILL and finish after [`KILL_DELAY`].
fn request_stop(record: &Record, reason: Reason) {
    let mut state = record.state.borrow_mut();
    request_stop_state(&mut state, reason);
    drop(state);
    record.wake.notify_one();
}

fn request_stop_state(state: &mut State, reason: Reason) {
    if state.finished || state.reason.is_some() {
        return;
    }
    state.reason = Some(reason);
    state.info.status = TaskStatus::Stopping;
    state.timeout_at = None;
    kill_group(state.info.pid, Signal::SIGTERM);
    state.kill_at = Some((Instant::now() + KILL_DELAY, KillTimer::Kill));
}

/// `append`: monitor, tail and log; the matches to report.
fn append(record: &Record, data: &[u8]) -> Vec<(TaskInfo, String)> {
    let mut state = record.state.borrow_mut();
    if state.finished {
        return Vec::new();
    }
    let matches = scan(&mut state, data, false);
    if state.tail.len() + data.len() > TAIL_LIMIT {
        state.tail_truncated = true;
    }
    if data.len() >= TAIL_LIMIT {
        state.tail = data[data.len() - TAIL_LIMIT..].to_vec();
    } else {
        let excess = (state.tail.len() + data.len()).saturating_sub(TAIL_LIMIT);
        state.tail.drain(..excess);
        state.tail.extend_from_slice(data);
    }
    if state.bytes + data.len() > LOG_LIMIT {
        state.log_truncated = true;
    }
    let writable = data.len().min(LOG_LIMIT - state.bytes.min(LOG_LIMIT));
    if writable > 0
        && let Some(file) = state.file.as_mut()
    {
        match file.write_all(&data[..writable]) {
            Ok(()) => state.bytes += writable,
            Err(error) => {
                state.info.error = Some(format!(
                    "Cannot write task log: Error: {}",
                    js::fs_error(&error, "write", None)
                ));
                state.file = None;
                request_stop_state(&mut state, Reason::Stopped);
                drop(state);
                record.wake.notify_one();
            }
        }
    }
    matches
}

/// `scan`: the monitored lines in `data` that match, with the task as it
/// was at each match.
fn scan(state: &mut State, data: &[u8], flush: bool) -> Vec<(TaskInfo, String)> {
    let Some(mut monitor) = state.monitor.take() else {
        return Vec::new();
    };
    let mut decoded = monitor.decoder.decode(data);
    if flush {
        decoded.push_str(&monitor.decoder.finish());
    }
    let text = std::mem::take(&mut monitor.partial) + &decoded;
    let mut lines = split_lines(&text);
    if !flush {
        monitor.partial = lines.pop().unwrap_or_default();
    }
    if js::len16(&monitor.partial) > LINE_LIMIT {
        lines.push(std::mem::take(&mut monitor.partial));
    }
    let mut out = Vec::new();
    let mut active = true;
    for raw in lines {
        let line = ansi().replace_all(&raw, "");
        let line = js::head16(&line, LINE_LIMIT).to_owned();
        if js::trim(&line).is_empty() || !monitor.pattern.test(&line) {
            continue;
        }
        let matches = state.info.matches.unwrap_or(0) + 1;
        state.info.matches = Some(matches);
        if matches >= MATCH_LIMIT {
            // Too chatty for wakeups: switch the monitor off.
            state.info.notify_on = None;
            active = false;
        }
        out.push((state.info.clone(), line));
        if !active {
            break;
        }
    }
    if active {
        state.monitor = Some(monitor);
    }
    out
}

fn now_iso() -> String {
    crate::iso_now()
}

enum Spawned {
    Piped(tokio::process::Child),
    Tty(tokio::process::Child, pty_process::Pty),
}

impl Spawned {
    fn pid(&self) -> Option<u32> {
        match self {
            Self::Piped(child) | Self::Tty(child, _) => child.id(),
        }
    }
}

/// `Bun.spawn(['bash', '-c', command], {stdin: 'ignore', stdout: 'pipe',
/// stderr: 'pipe', detached: true})`.
fn spawn_piped(
    shell: &str,
    command: &str,
    cwd: &str,
    env: &[(String, String)],
) -> std::io::Result<Spawned> {
    tokio::process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map(Spawned::Piped)
}

/// The same on a 200×50 `xterm-256color` terminal the shell controls (a
/// session of its own, like Bun's `terminal` with `detached`).
fn spawn_tty(
    shell: &str,
    command: &str,
    cwd: &str,
    env: &[(String, String)],
) -> std::io::Result<Spawned> {
    let io = |error: pty_process::Error| match error {
        pty_process::Error::Io(error) => error,
        other => std::io::Error::other(other.to_string()),
    };
    let (pty, pts) = pty_process::open().map_err(io)?;
    pty.resize(pty_process::Size::new(50, 200)).map_err(io)?;
    let child = pty_process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .env("TERM", "xterm-256color")
        .kill_on_drop(true)
        .spawn(pts)
        .map_err(io)?;
    Ok(Spawned::Tty(child, pty))
}

#[cfg(test)]
mod tests;
