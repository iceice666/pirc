//! Interactive shells for the side panel (`node/terminals.ts`). Owner:
//! **panels**. Not a sandbox: a terminal has the node account's rights, and
//! agents cannot reach it.
//!
//! A PTY ([`pty`]: its master close-on-exec from the start, security audit
//! S9) running `/bin/sh -c 'exec "$0" -l' <shell>` as a session leader with
//! the terminal as its controlling tty; the environment `without_secrets` plus
//! `SSH_AUTH_SOCK`, `TERM=xterm-256color`, `COLORTERM=truecolor`,
//! `PIRC_TERMINAL=1`, `HOME`. Limits: 4 live terminals per session, 24 in
//! all; 20..500 columns, 5..200 rows; 256 KiB of scrollback in whole
//! chunks; input over 65,536 UTF-16 units dropped; exited terminals kept
//! 30 minutes. Closing sends SIGHUP to the process group, SIGKILL 2 s later.
//!
//! Each terminal has three tasks: one reads the PTY (scrollback, then
//! `output` to its listeners), one writes it (input and resizes, in order),
//! one waits for the shell: then, 50 ms later (to drain what the PTY still
//! holds), the PTY closes and listeners get `exit`. Output reaches
//! listeners while the terminal's lock is held, so an attach sees each byte
//! either in its replay or as output, never both nor neither; exits reach
//! them without it, so a listener may detach then.

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use nix::sys::signal::Signal;
use pirc_agent::tools::bash::kill_group;
use serde::Serialize;
use tokio::sync::{mpsc, watch};

use crate::error::{ApiError, ApiResult};
use crate::services::WeakNode;

mod pty;

const SCROLLBACK_BYTES: usize = 256 * 1024;
const PER_SESSION: usize = 4;
const TOTAL: usize = 24;
const EXITED_RETENTION: Duration = Duration::from_secs(30 * 60);
/// Input longer than this (UTF-16 units) is dropped.
const INPUT_MAX_UNITS: usize = 65_536;
/// What the PTY may still hold when the shell exits.
const DRAIN: Duration = Duration::from_millis(50);
/// SIGHUP, then SIGKILL this much later.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// `TerminalInfo`, as the REST routes and the `ready` frame show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    /// 8 hex digits.
    pub id: String,
    pub session_id: String,
    /// The shell's file name.
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at: i64,
    /// `None` while it runs, or when a signal ended it.
    pub exit_code: Option<i32>,
    pub exited: bool,
}

/// What a terminal tells its listeners.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    Output(String),
    /// The shell's exit code; `None` when a signal ended it or the terminal
    /// was closed.
    Exit(Option<i32>),
}

pub type Listener = Arc<dyn Fn(&TerminalEvent) + Send + Sync>;

/// `TerminalManager`.
pub struct Terminals {
    node: WeakNode,
    registry: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    /// By id, in creation order (`list`).
    terminals: IndexMap<String, Arc<Entry>>,
    closing: bool,
    next_listener: u64,
}

struct Entry {
    pid: Option<u32>,
    state: Mutex<EntryState>,
    pty: mpsc::UnboundedSender<PtyCommand>,
    /// True once the shell exited.
    exited: watch::Receiver<bool>,
}

struct EntryState {
    info: TerminalInfo,
    /// Retained output (raw bytes) for replay on attach.
    scrollback: VecDeque<Vec<u8>>,
    scrollback_bytes: usize,
    listeners: Vec<(u64, Listener)>,
    decoder: Utf8Stream,
}

enum PtyCommand {
    Write(Vec<u8>),
    Resize { rows: u16, cols: u16 },
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Entry {
    fn state(&self) -> MutexGuard<'_, EntryState> {
        lock(&self.state)
    }
}

/// `defaultShell`: the configured shell or `$SHELL` when absolute, else
/// `/bin/sh`.
pub fn default_shell(preferred: Option<&str>, shell: Option<&str>) -> String {
    [preferred, shell]
        .into_iter()
        .flatten()
        .find(|shell| shell.starts_with('/'))
        .unwrap_or("/bin/sh")
        .to_owned()
}

/// `clamp(value, min, max, fallback)`: floored, the fallback for a
/// non-number.
pub(crate) fn clamp(value: f64, min: u16, max: u16, fallback: u16) -> u16 {
    let number = if value.is_finite() {
        value.floor()
    } else {
        f64::from(fallback)
    };
    number.clamp(f64::from(min), f64::from(max)) as u16
}

/// What [`Terminals::attach`] gives: the terminal now and its retained
/// output, decoded on its own (a split code point at its start is U+FFFD).
pub struct Attached {
    pub info: TerminalInfo,
    pub replay: String,
    /// For [`Terminals::detach`].
    pub listener: u64,
}

impl Terminals {
    pub fn new(node: WeakNode) -> Self {
        Self {
            node,
            registry: Arc::default(),
        }
    }

    fn registry(&self) -> MutexGuard<'_, Registry> {
        lock(&self.registry)
    }

    /// Every terminal of the session, exited ones too.
    pub fn list(&self, session_id: &str) -> Vec<TerminalInfo> {
        let entries: Vec<Arc<Entry>> = self.registry().terminals.values().cloned().collect();
        entries
            .iter()
            .map(|entry| entry.state().info.clone())
            .filter(|info| info.session_id == session_id)
            .collect()
    }

    /// Start a shell in `cwd` (409 `conflict` past the limits, 503 while
    /// the node shuts down, 500 `runner_unavailable` "Could not start
    /// shell: ..." when it cannot start).
    pub fn create(
        &self,
        session_id: &str,
        cwd: &Path,
        cols: Option<i64>,
        rows: Option<i64>,
    ) -> ApiResult<TerminalInfo> {
        let node = self.node.upgrade().ok_or_else(ApiError::internal)?;
        let shell = default_shell(node.config.terminal_shell.as_deref(), node.env.get("SHELL"));
        let mut env = pirc_config::env_allowlist::without_secrets(&node.env, &[]);
        // Only the human types here, and on macOS the ssh-agent socket comes
        // from launchd, not a profile: `git push` over ssh needs it.
        if let Some(socket) = node.env.get("SSH_AUTH_SOCK").filter(|s| !s.is_empty()) {
            env.insert("SSH_AUTH_SOCK".into(), socket.into());
        }
        let home = node
            .env
            .get("HOME")
            .map_or_else(|| node.env.home().display().to_string(), str::to_owned);
        env.insert("HOME".into(), home);
        self.spawn(
            session_id,
            cwd,
            cols.map_or(f64::NAN, |cols| cols as f64),
            rows.map_or(f64::NAN, |rows| rows as f64),
            &shell,
            env,
        )
    }

    /// `create` with the shell and its environment chosen.
    fn spawn(
        &self,
        session_id: &str,
        cwd: &Path,
        cols: f64,
        rows: f64,
        shell: &str,
        mut env: BTreeMap<String, String>,
    ) -> ApiResult<TerminalInfo> {
        let mut registry = self.registry();
        if registry.closing {
            return Err(ApiError::runner_unavailable("Gateway is shutting down"));
        }
        let live: Vec<String> = registry
            .terminals
            .values()
            .map(|entry| entry.state())
            .filter(|state| !state.info.exited)
            .map(|state| state.info.session_id.clone())
            .collect();
        if live.iter().filter(|id| *id == session_id).count() >= PER_SESSION {
            return Err(ApiError::conflict(format!(
                "At most {PER_SESSION} terminals per session"
            )));
        }
        if live.len() >= TOTAL {
            return Err(ApiError::conflict("Too many open terminals"));
        }
        // Opening a new terminal discards this session's exited ones.
        registry.terminals.retain(|_, entry| {
            let state = entry.state();
            !(state.info.exited && state.info.session_id == session_id)
        });
        let cols = clamp(cols, 20, 500, 80);
        let rows = clamp(rows, 5, 200, 24);
        let id = crate::util::uuid()[..8].to_owned();
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("PIRC_TERMINAL".into(), "1".into());

        let (pty, slave) = pty::open(rows, cols).map_err(|error| {
            crate::log::error(&format!("terminal: no PTY: {error}"));
            ApiError::internal()
        })?;
        // Through /bin/sh and exec: spawned directly, some shells (fish,
        // zsh) come up without the PTY as their controlling terminal and
        // lose job control. It is a session leader (Bun's `detached`), so a
        // hangup to the group reaches its jobs too.
        let child = pty::spawn(slave, shell, cwd, &env).map_err(|error| {
            ApiError::new(
                500,
                "runner_unavailable",
                format!(
                    "Could not start shell: {}",
                    pirc_agent::tools::js::fs_error(&error, "posix_spawn", Some("/bin/sh"))
                ),
            )
        })?;
        let (exited_tx, exited) = watch::channel(false);
        let (commands, receiver) = mpsc::unbounded_channel();
        let info = TerminalInfo {
            id: id.clone(),
            session_id: session_id.to_owned(),
            title: shell.rsplit('/').next().unwrap_or("shell").to_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            created_at: crate::util::now_ms(),
            exit_code: None,
            exited: false,
        };
        let entry = Arc::new(Entry {
            pid: child.id(),
            state: Mutex::new(EntryState {
                info: info.clone(),
                scrollback: VecDeque::new(),
                scrollback_bytes: 0,
                listeners: Vec::new(),
                decoder: Utf8Stream::default(),
            }),
            pty: commands,
            exited,
        });
        registry.terminals.insert(id, entry.clone());
        drop(registry);
        run(
            Arc::downgrade(&self.registry),
            entry,
            child,
            pty,
            receiver,
            exited_tx,
        );
        Ok(info)
    }

    fn lookup(&self, session_id: &str, id: &str) -> ApiResult<Arc<Entry>> {
        self.registry()
            .terminals
            .get(id)
            .filter(|entry| entry.state().info.session_id == session_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("Terminal not found"))
    }

    /// Subscribe `listener`; `ready` gets the terminal and its replay before
    /// any output reaches the listener.
    pub fn attach(
        &self,
        session_id: &str,
        id: &str,
        listener: Listener,
        ready: impl FnOnce(&TerminalInfo, &str),
    ) -> ApiResult<Attached> {
        let entry = self.lookup(session_id, id)?;
        let listener_id = {
            let mut registry = self.registry();
            registry.next_listener += 1;
            registry.next_listener
        };
        let mut state = entry.state();
        state.listeners.push((listener_id, listener));
        // Decoded on its own (TS): a split code point at its start is
        // dropped as U+FFFD, not mangled.
        let bytes: Vec<u8> = state.scrollback.iter().flatten().copied().collect();
        let mut decoder = Utf8Stream::default();
        let mut replay = decoder.decode(&bytes);
        replay.push_str(&decoder.finish());
        let info = state.info.clone();
        ready(&info, &replay);
        Ok(Attached {
            info,
            replay,
            listener: listener_id,
        })
    }

    /// Unsubscribe (the terminal lives on; nothing when it is gone).
    pub fn detach(&self, id: &str, listener: u64) {
        let entry = self.registry().terminals.get(id).cloned();
        if let Some(entry) = entry {
            entry
                .state()
                .listeners
                .retain(|(known, _)| *known != listener);
        }
    }

    /// Type into the terminal (ignored once it exited, or past the limit).
    pub fn input(&self, session_id: &str, id: &str, data: &str) -> ApiResult<()> {
        let entry = self.lookup(session_id, id)?;
        if entry.state().info.exited || data.encode_utf16().count() > INPUT_MAX_UNITS {
            return Ok(());
        }
        let _ = entry.pty.send(PtyCommand::Write(data.as_bytes().to_vec()));
        Ok(())
    }

    /// Resize, clamped; a non-number keeps that dimension.
    pub fn resize(&self, session_id: &str, id: &str, cols: f64, rows: f64) -> ApiResult<()> {
        let entry = self.lookup(session_id, id)?;
        let mut state = entry.state();
        if state.info.exited {
            return Ok(());
        }
        state.info.cols = clamp(cols, 20, 500, state.info.cols);
        state.info.rows = clamp(rows, 5, 200, state.info.rows);
        let _ = entry.pty.send(PtyCommand::Resize {
            rows: state.info.rows,
            cols: state.info.cols,
        });
        Ok(())
    }

    /// 404 `not_found` "Terminal not found".
    pub fn close(&self, session_id: &str, terminal_id: &str) -> ApiResult<()> {
        let entry = self.lookup(session_id, terminal_id)?;
        self.registry().terminals.shift_remove(terminal_id);
        kill(&entry);
        Ok(())
    }

    /// Close every terminal of a session; the entries closed.
    fn close_session(&self, session_id: &str) -> Vec<Arc<Entry>> {
        let entries: Vec<Arc<Entry>> = {
            let mut registry = self.registry();
            let ids: Vec<String> = registry
                .terminals
                .iter()
                .filter(|(_, entry)| entry.state().info.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| registry.terminals.shift_remove(id))
                .collect()
        };
        for entry in &entries {
            kill(entry);
        }
        entries
    }

    /// Close a session's terminals and wait for their processes to exit
    /// (chat deletion, before its files go).
    pub async fn dispose_session(&self, session_id: &str) {
        for entry in self.close_session(session_id) {
            let mut exited = entry.exited.clone();
            let _ = exited.wait_for(|exited| *exited).await;
        }
    }

    /// Node shutdown: refuse new terminals, kill every one, wait for none.
    pub fn shutdown(&self) {
        let entries: Vec<Arc<Entry>> = {
            let mut registry = self.registry();
            registry.closing = true;
            registry
                .terminals
                .drain(..)
                .map(|(_, entry)| entry)
                .collect()
        };
        for entry in &entries {
            kill(entry);
        }
    }
}

/// Tell listeners the terminal ended, then SIGHUP its process group and
/// SIGKILL it 2 s later unless it exited (the exit handler closes the PTY).
fn kill(entry: &Arc<Entry>) {
    let (listeners, exited) = {
        let mut state = entry.state();
        (std::mem::take(&mut state.listeners), state.info.exited)
    };
    for (_, listener) in listeners {
        listener(&TerminalEvent::Exit(None));
    }
    if exited {
        return;
    }
    kill_group(entry.pid, Signal::SIGHUP);
    let pid = entry.pid;
    let mut exited = entry.exited.clone();
    tokio::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(KILL_GRACE) => kill_group(pid, Signal::SIGKILL),
            _ = exited.wait_for(|exited| *exited) => {}
        }
    });
}

/// Append output to the scrollback (whole chunks dropped from the front
/// past the limit, never the last one) and hand it to the listeners.
fn output(entry: &Entry, chunk: &[u8]) {
    let mut state = entry.state();
    state.scrollback.push_back(chunk.to_vec());
    state.scrollback_bytes += chunk.len();
    while state.scrollback_bytes > SCROLLBACK_BYTES && state.scrollback.len() > 1 {
        let dropped = state.scrollback.pop_front().map_or(0, |chunk| chunk.len());
        state.scrollback_bytes -= dropped;
    }
    let data = state.decoder.decode(chunk);
    if !data.is_empty() {
        let event = TerminalEvent::Output(data);
        for (_, listener) in &state.listeners {
            listener(&event);
        }
    }
}

/// The terminal's tasks: see the module documentation.
fn run(
    registry: Weak<Mutex<Registry>>,
    entry: Arc<Entry>,
    mut child: Box<dyn process_wrap::tokio::ChildWrapper>,
    pty: pty::Master,
    mut commands: mpsc::UnboundedReceiver<PtyCommand>,
    exited: watch::Sender<bool>,
) {
    let reader = Arc::new(pty);
    let writer = reader.clone();
    let reading = {
        let entry = entry.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0; 64 * 1024];
            // EOF or EIO once every holder of the terminal is gone.
            while let Ok(n @ 1..) = reader.read(&mut buffer).await {
                output(&entry, &buffer[..n]);
            }
        })
    };
    let writing = tokio::spawn(async move {
        while let Some(command) = commands.recv().await {
            match command {
                PtyCommand::Write(bytes) => {
                    let _ = writer.write_all(&bytes).await;
                }
                PtyCommand::Resize { rows, cols } => {
                    let _ = writer.resize(rows, cols);
                }
            }
        }
    });
    tokio::spawn(async move {
        let code = match child.wait().await {
            // A signal's death is `null` (TS: `signalCode`).
            Ok(status) => status.code(),
            Err(_) => None,
        };
        {
            let mut state = entry.state();
            state.info.exited = true;
            state.info.exit_code = code;
        }
        let _ = exited.send(true);
        // Drain what the PTY still holds, then close it and tell listeners.
        tokio::time::sleep(DRAIN).await;
        reading.abort();
        writing.abort();
        let listeners: Vec<Listener> = entry
            .state()
            .listeners
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            listener(&TerminalEvent::Exit(code));
        }
        // An exited terminal stays readable for a while, then its
        // scrollback is freed.
        tokio::time::sleep(EXITED_RETENTION).await;
        let Some(registry) = registry.upgrade() else {
            return;
        };
        let mut registry = lock(&registry);
        let id = entry.state().info.id.clone();
        if registry
            .terminals
            .get(&id)
            .is_some_and(|current| Arc::ptr_eq(current, &entry))
        {
            registry.terminals.shift_remove(&id);
        }
    });
}

/// `TextDecoder` (UTF-8, BOM stripped once) fed chunk by chunk
/// (`stream: true`): an incomplete sequence at a chunk's end waits for the
/// next one; invalid bytes are U+FFFD (maximal subparts, as WHATWG).
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
    bom_seen: bool,
}

impl Utf8Stream {
    pub(crate) fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        self.strip_bom(out)
    }

    /// The end of the stream: an incomplete sequence is U+FFFD.
    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        self.pending.clear();
        self.strip_bom("\u{FFFD}".to_owned())
    }

    fn strip_bom(&mut self, text: String) -> String {
        if self.bom_seen || text.is_empty() {
            return text;
        }
        self.bom_seen = true;
        match text.strip_prefix('\u{FEFF}') {
            Some(rest) => rest.to_owned(),
            None => text,
        }
    }
}

#[cfg(test)]
mod tests;
