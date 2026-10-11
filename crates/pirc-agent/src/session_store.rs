//! The append-only `session.jsonl` (`agent/session-store.ts`), kept
//! field-for-field compatible with the TS agent's v1 (the TS node reads it
//! while the Rust agent runs under it; plans/rust-rewrite.md, M4).

use std::path::PathBuf;

use pirc_protocol::Message;
use serde_json::{Map, Value};

/// Session entry of one `ptc` operation (`OPERATION_ENTRY`).
pub const OPERATION_ENTRY: &str = "ptc.operation";
/// `SESSION_FILE`.
pub const SESSION_FILE: &str = "session.jsonl";

/// What an entry is (`SessionEntry` without `id`, `parentId`, `timestamp`).
#[derive(Clone, Debug, PartialEq)]
pub enum EntryData {
    Session {
        session_id: String,
        cwd: String,
    },
    Message(Message),
    /// Extension state; never sent to the model.
    Custom {
        custom_type: String,
        data: Value,
    },
    Compaction {
        summary: String,
        first_kept_entry_id: String,
        tokens_before: u64,
        details: Option<Value>,
    },
    ModelChange {
        provider: String,
        model_id: String,
    },
    ThinkingLevelChange {
        thinking_level: String,
    },
    SessionInfo {
        name: String,
        source: Option<String>,
    },
    /// An entry type this version does not know, kept as it was read.
    Other(Map<String, Value>),
}

/// `SessionEntry`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub timestamp: u64,
    pub data: EntryData,
}

/// `SessionStore`.
pub struct SessionStore {
    pub dir: PathBuf,
    pub file: PathBuf,
}

impl SessionStore {
    /// Open (or create, 0700) the directory and read its session.
    pub fn open(dir: PathBuf, cwd: &str) -> Result<Self, String> {
        let _ = (dir, cwd);
        todo!("M4 store: SessionStore::open")
    }

    pub fn session_id(&self) -> String {
        todo!("M4 store: sessionId")
    }

    /// `isNew`: only the header so far.
    pub fn is_new(&self) -> bool {
        todo!("M4 store: isNew")
    }

    /// `append(entry)`: written (0600) before it is returned.
    pub fn append(&mut self, data: EntryData) -> Result<SessionEntry, String> {
        let _ = data;
        todo!("M4 store: append")
    }

    pub fn get(&self, id: &str) -> Option<&SessionEntry> {
        let _ = id;
        todo!("M4 store: get")
    }

    /// Entries on the active branch, root first.
    pub fn branch(&self) -> Vec<SessionEntry> {
        todo!("M4 store: branch")
    }

    /// Every message on the branch (UI history), compacted ones included.
    pub fn all_messages(&self) -> Vec<Message> {
        todo!("M4 store: allMessages")
    }

    /// What the model sees: the latest compaction summary, then messages
    /// from its `firstKeptEntryId` on, with their entry ids.
    pub fn context_entries(&self) -> Vec<(String, Message)> {
        todo!("M4 store: contextEntries")
    }
}
