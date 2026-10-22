//! Workspace memory mirrored to the gateway for the assistant's search
//! (`node/memory-mirror.ts`). Owner: **panels**.
//!
//! Ledgers `<workspace memory dir>/<16 hex>.jsonl` (not recursive) are sent
//! as complete lines from the offset the gateway acknowledged, at most
//! [`pirc_protocol::MIRROR_CHUNK_BYTES`] per frame (a longer single line up
//! to 8 MiB), through `LinkSender::send_agent_frame`; a shrunken ledger
//! starts over with `reset`. Items lose their paths: a session directory
//! becomes the node session id (a cached lookup by `private_session_path`),
//! git loses its worktree. One frame per ledger in flight (60 s), a scan
//! every `config.memory_mirror_ms`, an immediate next chunk on each ack.
//! Golden cases: `memory-mirror.test.ts`.
//!
//! Like TS, the work is synchronous: `connect` scans before it returns, so
//! the frames go out before the link's `activity` (recorded).

use std::collections::HashMap;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use pirc_agent::features::memory::workspace::WorkspaceItem;
use pirc_agent::tools::js::{trim, truthy};
use pirc_protocol::{MIRROR_CHUNK_BYTES, NodeMessage};
use regex_lite::Regex;
use rusqlite::OptionalExtension as _;
use serde_json::{Map, Value, json};

use crate::services::WeakNode;

/// A frame the gateway never acknowledged is sent again after this long.
const ACK_TIMEOUT: Duration = Duration::from_secs(60);
/// A single line longer than a chunk is read whole, up to this size.
const LINE_MAX_BYTES: usize = 8 * 1024 * 1024;

static LEDGER_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9a-f]{16})\.jsonl$").expect("ledger regex"));

pub struct MemoryMirror {
    node: WeakNode,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Registered with the gateway (TS: `send` set).
    connected: bool,
    acked: HashMap<String, u64>,
    /// Ledgers with a frame on its way, and when it was sent.
    sent: HashMap<String, (Instant, u64)>,
    timer: Option<tokio::task::JoinHandle<()>>,
    /// Session directory → node session id, or `None` when no session of
    /// this node wrote it. Never invalidated (TS), so a session created
    /// later keeps `None` for its directory until the node restarts.
    sessions: HashMap<String, Option<String>>,
    verified: HashMap<String, (u64, String)>,
}

/// What a pass reads and sends with: the node's in production, stand-ins
/// in tests.
struct Io<'a> {
    dir: &'a Path,
    send: &'a dyn Fn(&NodeMessage) -> bool,
    /// The node session whose `private_session_path` is the directory.
    lookup: &'a dyn Fn(&str) -> Option<String>,
}

impl MemoryMirror {
    pub fn new(node: WeakNode) -> Self {
        Self {
            node,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Run `work` with the node's I/O; nothing once the node is gone.
    fn with_io(&self, work: impl FnOnce(&mut State, &Io<'_>)) {
        let Some(node) = self.node.upgrade() else {
            return;
        };
        let send = |message: &NodeMessage| node.link.send_agent_frame(message);
        let lookup = |dir: &str| -> Option<String> {
            node.db
                .lock()
                .query_row(
                    "SELECT id FROM sessions WHERE private_session_path=?",
                    [dir],
                    |row| row.get(0),
                )
                .optional()
                .unwrap_or_else(|error| {
                    crate::log::error(&format!("memory mirror session lookup: {error}"));
                    None
                })
        };
        let io = Io {
            dir: &node.config.workspace_memory_dir,
            send: &send,
            lookup: &lookup,
        };
        work(&mut self.lock(), &io);
    }

    /// The link registered: the gateway's acknowledged offsets by ledger
    /// key; start scanning.
    pub fn connect(&self, mirrors: IndexMap<String, u64>) {
        {
            let mut state = self.lock();
            state.connected = true;
            state.acked = mirrors.into_iter().collect();
            state.sent.clear();
            state.verified.clear();
            if state.timer.is_none()
                && let Some(node) = self.node.upgrade()
            {
                let period = Duration::from_millis(node.config.memory_mirror_ms.max(1));
                let weak = self.node.clone();
                state.timer = Some(tokio::spawn(async move {
                    let mut interval =
                        tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    loop {
                        interval.tick().await;
                        let Some(node) = weak.upgrade() else {
                            return;
                        };
                        node.mirror.scan();
                    }
                }));
            }
        }
        self.scan();
    }

    /// `memory_mirror_ack`: the gateway stored up to `watermark`; send what
    /// follows, if anything.
    pub fn receive(&self, ledger_key: &str, watermark: u64) {
        self.with_io(|state, io| state.receive(io, ledger_key, watermark));
    }

    /// Mirror every ledger that has something new.
    pub fn scan(&self) {
        self.with_io(|state, io| state.scan(io));
    }

    /// The link dropped or the node closes: stop scanning.
    pub fn disconnect(&self) {
        let mut state = self.lock();
        state.connected = false;
        state.sent.clear();
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
    }
}

impl State {
    fn receive(&mut self, io: &Io<'_>, key: &str, watermark: u64) {
        let previous = self.acked.get(key).copied().unwrap_or(0);
        if watermark < previous {
            return;
        }
        self.acked.insert(key.to_owned(), watermark);
        // A non-advancing/rejected frame waits for the existing retry timer; no immediate loop.
        if self
            .sent
            .get(key)
            .is_some_and(|(_, expected)| watermark < *expected)
        {
            return;
        }
        self.sent.remove(key);
        self.mirror(io, key);
    }

    fn scan(&mut self, io: &Io<'_>) {
        if !self.connected {
            return;
        }
        // `readdirSync` order; a missing directory is nothing to do.
        let Ok(entries) = std::fs::read_dir(io.dir) else {
            return;
        };
        let names: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        for name in names {
            if let Some(key) = LEDGER_FILE.captures(&name).and_then(|c| c.get(1)) {
                self.mirror(io, key.as_str());
            }
        }
    }

    fn mirror(&mut self, io: &Io<'_>, key: &str) {
        if !self.connected
            || self
                .sent
                .get(key)
                .is_some_and(|sent| sent.0.elapsed() < ACK_TIMEOUT)
        {
            return;
        }
        let file = io.dir.join(format!("{key}.jsonl"));
        let Ok(size) = std::fs::metadata(&file).map(|m| m.len()) else {
            return;
        };
        let mut from = self.acked.get(key).copied().unwrap_or(0);
        // Shrank: replaced or truncated, so the gateway starts it over.
        let reset = size < from;
        if reset {
            from = 0;
        }
        // Reject shrink rather than replacing gateway revocations with an older ledger.
        if reset {
            return;
        }
        let Ok(raw) = std::fs::read(&file) else {
            return;
        };
        if raw.len() as u64 != size {
            return;
        }
        let Ok(snapshot) = pirc_agent::workspace_journal::parse(&raw) else {
            return;
        };
        if snapshot.control.is_none() && file.with_extension("lock").is_dir() {
            return;
        }
        let hash = pirc_agent::journal::digest(&raw);
        if size == from && self.verified.get(key) == Some(&(size, hash.clone())) {
            return;
        }

        let Ok(bytes) = read(&file, from, (size - from).min(MIRROR_CHUNK_BYTES as u64)) else {
            return;
        };
        // Complete lines only: one being written now goes with a later scan.
        let mut end = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |at| at + 1);
        let mut text = String::from_utf8_lossy(&bytes[..end]).into_owned();
        if end == 0 && bytes.len() == MIRROR_CHUNK_BYTES {
            let Ok(whole) = read(&file, from, (size - from).min(LINE_MAX_BYTES as u64)) else {
                return;
            };
            end = whole
                .iter()
                .position(|b| *b == b'\n')
                .map_or(0, |at| at + 1);
            text = String::from_utf8_lossy(&whole[..end]).into_owned();
        }
        if end == 0 && size != from && !reset {
            return;
        }
        let mut lines: Vec<Value> = parse_lines(&text)
            .iter()
            .map(|line| self.convert(io, line))
            .collect();
        let end_offset = from + end as u64;
        if raw.len() < end_offset as usize || raw.len() < from as usize {
            return;
        }
        let Ok(legacy) = pirc_agent::workspace_journal::projection(&raw[..from as usize]) else {
            return;
        };
        let marker = json!({"type":"integrity","version":2,"end":end_offset,"digest":pirc_agent::journal::digest(&raw[..end_offset as usize]),"previousDigest":pirc_agent::journal::digest(&raw[..from as usize]),"legacyProjection":legacy});
        lines.push(marker);
        self.sent
            .insert(key.to_owned(), (Instant::now(), end_offset));
        let delivered = (io.send)(&NodeMessage::MemoryMirror {
            ledger_key: key.to_owned(),
            offset: from,
            end: from + end as u64,
            reset: reset.then_some(true),
            lines,
        });
        if !delivered {
            self.sent.remove(key);
        } else {
            self.verified.insert(key.into(), (size, hash));
        }
    }

    /// A ledger line without paths (`MirroredLine`).
    fn convert(&mut self, io: &Io<'_>, line: &Line) -> Value {
        match line {
            Line::Recorded(items) => json!({
                "type": "recorded",
                "items": items.iter().map(|item| self.item(io, item)).collect::<Vec<_>>(),
            }),
            Line::Retired { ids, forgotten } => json!({
                "type": "retired",
                "ids": ids,
                "reason": if *forgotten { "forgotten" } else { "superseded" },
            }),
            Line::Cleared => json!({ "type": "cleared" }),
        }
    }

    /// `MirroredItem`: the stored values as they are, but the session
    /// directory replaced by the node session and git without its worktree.
    fn item(&mut self, io: &Io<'_>, item: &WorkspaceItem) -> Value {
        let raw = item.raw.as_object().cloned().unwrap_or_default();
        let mut out = Map::new();
        for key in ["id", "content", "relevance", "timestamp"] {
            if let Some(value) = raw.get(key) {
                out.insert(key.into(), value.clone());
            }
        }
        if let Some(session_id) = self.node_session(io, &item.session_dir) {
            out.insert("sessionId".into(), json!(session_id));
        }
        if let Some(git) = raw.get("git").filter(|git| truthy(Some(git))) {
            let mut kept = Map::new();
            if let Some(head) = git.get("head") {
                kept.insert("head".into(), head.clone());
            }
            if let Some(branch) = git.get("branch").filter(|branch| truthy(Some(branch))) {
                kept.insert("branch".into(), branch.clone());
            }
            if let Some(dirty) = git.get("dirty") {
                kept.insert("dirty".into(), dirty.clone());
            }
            out.insert("git".into(), Value::Object(kept));
        }
        if let Some(ids) = raw.get("sourceMemoryIds") {
            out.insert("sourceMemoryIds".into(), ids.clone());
        }
        if let Some(origins) = raw.get("origins").filter(|origins| truthy(Some(origins))) {
            out.insert("origins".into(), origins.clone());
        }
        Value::Object(out)
    }

    fn node_session(&mut self, io: &Io<'_>, session_dir: &str) -> Option<String> {
        self.sessions
            .entry(session_dir.to_owned())
            .or_insert_with(|| (io.lookup)(session_dir))
            .clone()
    }
}

/// A ledger line as `parseWorkspaceLines` keeps it: recorded items that
/// are items, retired ids as stored.
enum Line {
    Recorded(Vec<WorkspaceItem>),
    Retired { ids: Value, forgotten: bool },
    Cleared,
}

/// `parseWorkspaceLines`: blank and torn lines and unknown types skipped.
fn parse_lines(text: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        if trim(line).is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value["type"] == "workspace.commit" {
            if value["clear"] == true {
                out.push(Line::Cleared);
            }
            for (field, forgotten) in [("retire", false), ("forget", true)] {
                if value[field].as_array().is_some_and(|a| !a.is_empty()) {
                    out.push(Line::Retired {
                        ids: value[field].clone(),
                        forgotten,
                    });
                }
            }
            if let Some(items) = value["add"].as_array().filter(|a| !a.is_empty()) {
                out.push(Line::Recorded(
                    items.iter().filter_map(WorkspaceItem::parse).collect(),
                ));
            }
            continue;
        }
        match value.get("type").and_then(Value::as_str) {
            Some("recorded") => {
                if let Some(items) = value.get("items").and_then(Value::as_array) {
                    out.push(Line::Recorded(
                        items.iter().filter_map(WorkspaceItem::parse).collect(),
                    ));
                }
            }
            Some("retired") => {
                if let Some(ids) = value.get("ids").filter(|ids| ids.is_array()) {
                    out.push(Line::Retired {
                        ids: ids.clone(),
                        forgotten: value.get("reason").and_then(Value::as_str) == Some("forgotten"),
                    });
                }
            }
            Some("cleared") => out.push(Line::Cleared),
            _ => {}
        }
    }
    out
}

/// Up to `length` bytes of `file` from `from` (fewer at its end).
fn read(file: &PathBuf, from: u64, length: u64) -> std::io::Result<Vec<u8>> {
    let mut handle = std::fs::File::open(file)?;
    handle.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::with_capacity(length as usize);
    handle.take(length).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests;
