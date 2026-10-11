//! `ChildProcess` (`features/team/team.ts`): the JSONL RPC client for one
//! child agent process, which leads its own process group.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::process::Stdio;
use std::rc::Rc;
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::tools::bash::kill_group;
use crate::tools::js;

/// A JSONL line longer than this (unconsumed output) stops the child.
const STDOUT_LIMIT: usize = 16 * 1024 * 1024;
/// UTF-16 units of stderr kept.
const STDERR_KEEP: usize = 8192;
/// Dialogs a child may not open: they are cancelled, never approved.
const DIALOGS: [&str; 4] = ["confirm", "select", "input", "editor"];

/// A one-time event that tasks can wait for.
#[derive(Default)]
struct Done {
    done: Cell<bool>,
    notify: Notify,
}

impl Done {
    fn set(&self) {
        self.done.set(true);
        self.notify.notify_waiters();
    }

    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.done.get() {
                return;
            }
            notified.await;
        }
    }
}

type Settler = oneshot::Sender<Result<Value, String>>;

/// `ChildProcess`.
pub struct ChildProcess {
    pub pid: Option<u32>,
    stdin: RefCell<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    pending: Rc<RefCell<HashMap<String, Settler>>>,
    exited: Rc<Done>,
    stopping: Cell<bool>,
    stopped: Rc<Done>,
}

impl ChildProcess {
    /// Start `argv` in `cwd` with exactly `env`, in a process group of its
    /// own (`detached`). `on_event` gets the child's events, the cancelled
    /// dialogs (`team_dialog_cancelled`) and finally `team_exit`.
    pub fn spawn(
        argv: &[String],
        cwd: &str,
        env: &[(String, String)],
        on_event: Rc<dyn Fn(Value)>,
    ) -> Result<Rc<Self>, String> {
        let (program, args) = argv.split_first().ok_or("No command")?;
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let pid = child.id();
        let (Some(mut stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err("No pipes to the child".to_owned());
        };
        let (sender, mut lines) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::task::spawn_local(async move {
            while let Some(line) = lines.recv().await {
                if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
                    return;
                }
            }
        });
        let process = Rc::new(Self {
            pid,
            stdin: RefCell::new(Some(sender)),
            pending: Rc::new(RefCell::new(HashMap::new())),
            exited: Rc::new(Done::default()),
            stopping: Cell::new(false),
            stopped: Rc::new(Done::default()),
        });
        let stderr_text = Rc::new(RefCell::new(String::new()));
        tokio::task::spawn_local(read_stderr(stderr, stderr_text.clone()));
        let read = Rc::new(Done::default());
        {
            let weak = Rc::downgrade(&process);
            let pending = process.pending.clone();
            let on_event = on_event.clone();
            let read = read.clone();
            tokio::task::spawn_local(async move {
                read_stdout(stdout, weak, pending, on_event).await;
                read.set();
            });
        }
        let pending = process.pending.clone();
        let exited = process.exited.clone();
        tokio::task::spawn_local(async move {
            let status = child.wait().await.ok();
            // Whatever the child left in its process group (a busy ptc
            // script process cannot notice its parent is gone) ends with
            // it. Only the group, which outlives its reaped leader while
            // members remain.
            if let Some(pgid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
                let _ = kill(Pid::from_raw(-pgid), Signal::SIGKILL);
            }
            // Lines the child wrote before it exited come first.
            let _ = tokio::time::timeout(Duration::from_secs(1), read.wait()).await;
            let settlers: Vec<Settler> = pending.borrow_mut().drain().map(|(_, s)| s).collect();
            for settler in settlers {
                let _ = settler.send(Err("Agent exited".to_owned()));
            }
            exited.set();
            use std::os::unix::process::ExitStatusExt;
            let code = status.and_then(|status| status.code());
            let signal = status
                .and_then(|status| status.signal())
                .and_then(|signal| Signal::try_from(signal).ok())
                .map(Signal::as_str);
            let stderr = stderr_text.borrow();
            on_event(json!({
                "type": "team_exit",
                "code": code,
                "signal": signal,
                "stderr": js::tail16(js::trim(&stderr), 2000),
            }));
        });
        Ok(process)
    }

    /// `write(value)`: one JSONL line to the child; nothing once stdin is
    /// closed.
    pub fn write(&self, value: &Value) {
        let mut line = js::stringify(value).into_bytes();
        line.push(b'\n');
        if let Some(sender) = self.stdin.borrow().as_ref() {
            let _ = sender.send(line);
        }
    }

    /// `request(type, data, timeout)`: a command and its response's `data`.
    pub async fn request(
        &self,
        kind: &str,
        data: Map<String, Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = crate::random_uuid();
        let (sender, receiver) = oneshot::channel();
        if self.exited.done.get() {
            return Err("Agent exited".to_owned());
        }
        self.pending.borrow_mut().insert(id.clone(), sender);
        let mut command = data;
        command.insert("type".to_owned(), json!(kind));
        command.insert("id".to_owned(), json!(id));
        self.write(&Value::Object(command));
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Agent exited".to_owned()),
            Err(_) => {
                self.pending.borrow_mut().remove(&id);
                Err(format!("RPC {kind} timed out"))
            }
        }
    }

    /// `request` with the TS default of 30 s.
    pub async fn call(&self, kind: &str, data: Map<String, Value>) -> Result<Value, String> {
        self.request(kind, data, Duration::from_secs(30)).await
    }

    /// `stop()`: close stdin, SIGTERM the group, SIGKILL it after 1.5 s,
    /// and once more after the exit (a descendant may have ignored
    /// SIGTERM). Every caller waits for the same stop.
    pub async fn stop(&self) {
        if !self.stopping.replace(true) {
            self.stdin.borrow_mut().take();
            let pid = self.pid;
            kill_group(pid, Signal::SIGTERM);
            let exited = self.exited.clone();
            let stopped = self.stopped.clone();
            tokio::task::spawn_local(async move {
                if tokio::time::timeout(Duration::from_millis(1500), exited.wait())
                    .await
                    .is_err()
                {
                    kill_group(pid, Signal::SIGKILL);
                    exited.wait().await;
                }
                kill_group(pid, Signal::SIGKILL);
                stopped.set();
            });
        }
        self.stopped.wait().await;
    }
}

async fn read_stderr(mut stderr: tokio::process::ChildStderr, text: Rc<RefCell<String>>) {
    let mut buffer = vec![0u8; 8192];
    let mut partial: Vec<u8> = Vec::new();
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        partial.extend_from_slice(&buffer[..read]);
        // Decode up to the last complete UTF-8 sequence (`stream: true`).
        let valid = match std::str::from_utf8(&partial) {
            Ok(_) => partial.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => partial.len(),
        };
        let chunk = String::from_utf8_lossy(&partial[..valid]).into_owned();
        partial.drain(..valid);
        let mut text = text.borrow_mut();
        text.push_str(&chunk);
        let kept = js::tail16(&text, STDERR_KEEP).to_owned();
        *text = kept;
    }
}

async fn read_stdout(
    mut stdout: tokio::process::ChildStdout,
    process: std::rc::Weak<ChildProcess>,
    pending: Rc<RefCell<HashMap<String, Settler>>>,
    on_event: Rc<dyn Fn(Value)>,
) {
    let stop = |process: &std::rc::Weak<ChildProcess>| {
        if let Some(process) = process.upgrade() {
            tokio::task::spawn_local(async move { process.stop().await });
        }
    };
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > STDOUT_LIMIT {
            stop(&process);
            return;
        }
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
            if js::trim(&line).is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                stop(&process);
                return;
            };
            let kind = event.get("type").and_then(Value::as_str);
            if kind == Some("response") {
                let settler = event
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| pending.borrow_mut().remove(id));
                let Some(settler) = settler else {
                    continue;
                };
                let result = if event.get("success").is_some_and(|s| js::truthy(Some(s))) {
                    Ok(event.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    match event.get("error") {
                        Some(error) if js::truthy(Some(error)) => Err(js::string_of(error)),
                        _ => Err("RPC failed".to_owned()),
                    }
                };
                let _ = settler.send(result);
            } else if kind == Some("extension_ui_request")
                && event
                    .get("method")
                    .and_then(Value::as_str)
                    .is_some_and(|method| DIALOGS.contains(&method))
            {
                // Never auto-approve a child dialog, and never leave it hanging.
                if let Some(process) = process.upgrade() {
                    let mut answer = Map::new();
                    answer.insert("type".to_owned(), json!("extension_ui_response"));
                    if let Some(id) = event.get("id") {
                        answer.insert("id".to_owned(), id.clone());
                    }
                    answer.insert("cancelled".to_owned(), json!(true));
                    process.write(&Value::Object(answer));
                }
                let mut cancelled = Map::new();
                cancelled.insert("type".to_owned(), json!("team_dialog_cancelled"));
                if let Some(title) = event.get("title") {
                    cancelled.insert("title".to_owned(), title.clone());
                }
                on_event(Value::Object(cancelled));
            } else {
                on_event(event);
            }
        }
    }
}
