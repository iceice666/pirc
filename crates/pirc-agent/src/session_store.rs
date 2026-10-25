//! The append-only `session.jsonl` (`agent/session-store.ts`), kept
//! field-for-field compatible with the TS agent's v1 (the historical TS-node
//! interoperability baseline; docs/development/historical-records.md).
//!
//! Every entry has a stable id and parent id; the active branch is the chain
//! ending at the most recently appended (or last read) entry.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use pirc_protocol::{Message, UserBlock, UserContent};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::messages::js;

/// Session entry of one `ptc` operation (`OPERATION_ENTRY`).
pub const OPERATION_ENTRY: &str = "ptc.operation";
/// The `ptc` script store after a completed script changed it (`PTC_STORE_ENTRY`).
pub const PTC_STORE_ENTRY: &str = "ptc.store";
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
    /// An entry type this version does not know (or a known one with fields
    /// it cannot read), kept as it was read without `id`, `parentId` and
    /// `timestamp`.
    Other(Map<String, Value>),
}

impl EntryData {
    /// The entry's `type`.
    pub fn type_name(&self) -> &str {
        match self {
            Self::Session { .. } => "session",
            Self::Message(_) => "message",
            Self::Custom { .. } => "custom",
            Self::Compaction { .. } => "compaction",
            Self::ModelChange { .. } => "model_change",
            Self::ThinkingLevelChange { .. } => "thinking_level_change",
            Self::SessionInfo { .. } => "session_info",
            Self::Other(map) => map.get("type").and_then(Value::as_str).unwrap_or(""),
        }
    }

    /// The fields as TS writes them: `type` first, then the entry's fields
    /// in the order the TS agent builds them.
    fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        let mut put = |key: &str, value: Value| {
            map.insert(key.to_owned(), value);
        };
        if !matches!(self, Self::Other(_)) {
            put("type", Value::from(self.type_name()));
        }
        match self {
            Self::Session { session_id, cwd } => {
                put("version", Value::from(1));
                put("sessionId", Value::from(session_id.as_str()));
                put("cwd", Value::from(cwd.as_str()));
            }
            Self::Message(message) => {
                put(
                    "message",
                    serde_json::to_value(message).unwrap_or(Value::Null),
                );
            }
            Self::Custom { custom_type, data } => {
                put("customType", Value::from(custom_type.as_str()));
                put("data", data.clone());
            }
            Self::Compaction {
                summary,
                first_kept_entry_id,
                tokens_before,
                details,
            } => {
                put("summary", Value::from(summary.as_str()));
                put(
                    "firstKeptEntryId",
                    Value::from(first_kept_entry_id.as_str()),
                );
                put("tokensBefore", Value::from(*tokens_before));
                if let Some(details) = details {
                    put("details", details.clone());
                }
            }
            Self::ModelChange { provider, model_id } => {
                put("provider", Value::from(provider.as_str()));
                put("modelId", Value::from(model_id.as_str()));
            }
            Self::ThinkingLevelChange { thinking_level } => {
                put("thinkingLevel", Value::from(thinking_level.as_str()));
            }
            Self::SessionInfo { name, source } => {
                put("name", Value::from(name.as_str()));
                if let Some(source) = source {
                    put("source", Value::from(source.as_str()));
                }
            }
            Self::Other(other) => {
                for (key, value) in other {
                    put(key, value.clone());
                }
            }
        }
        map
    }

    /// Read the fields of an entry (without `id`, `parentId`, `timestamp`).
    fn from_map(map: Map<String, Value>) -> Self {
        Self::typed(&map).unwrap_or(Self::Other(map))
    }

    fn typed(map: &Map<String, Value>) -> Option<Self> {
        let text = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(match map.get("type")?.as_str()? {
            "session" => Self::Session {
                session_id: text("sessionId")?,
                cwd: text("cwd")?,
            },
            "message" => Self::Message(Message::deserialize(map.get("message")?).ok()?),
            "custom" => Self::Custom {
                custom_type: text("customType")?,
                data: map.get("data").cloned().unwrap_or(Value::Null),
            },
            "compaction" => Self::Compaction {
                summary: text("summary")?,
                first_kept_entry_id: text("firstKeptEntryId")?,
                tokens_before: map.get("tokensBefore").and_then(number_u64)?,
                details: map.get("details").cloned(),
            },
            "model_change" => Self::ModelChange {
                provider: text("provider")?,
                model_id: text("modelId")?,
            },
            "thinking_level_change" => Self::ThinkingLevelChange {
                thinking_level: text("thinkingLevel")?,
            },
            "session_info" => Self::SessionInfo {
                name: text("name")?,
                source: match map.get("source") {
                    None => None,
                    Some(value) => Some(value.as_str()?.to_owned()),
                },
            },
            _ => return None,
        })
    }
}

fn number_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
}

/// `SessionEntry`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionEntry {
    /// Empty for a line that had no string id (TS: `undefined`).
    pub id: String,
    pub parent_id: Option<String>,
    pub timestamp: u64,
    pub data: EntryData,
}

impl SessionEntry {
    /// The JSON TS writes: `{...entry, id, parentId, timestamp}`.
    pub fn to_value(&self) -> Value {
        let mut map = self.data.to_map();
        map.insert("id".to_owned(), Value::from(self.id.as_str()));
        map.insert(
            "parentId".to_owned(),
            self.parent_id.as_deref().map_or(Value::Null, Value::from),
        );
        map.insert("timestamp".to_owned(), Value::from(self.timestamp));
        Value::Object(map)
    }

    /// One parsed line. A JSON value that is not an object is kept as an
    /// entry without id, as TS kept it; `null` is an error, as it was in TS.
    pub fn from_value(value: Value) -> Result<Self, String> {
        let mut map = match value {
            Value::Object(map) => map,
            Value::Null => return Err("null is not an object (evaluating 'entry.id')".to_owned()),
            _ => {
                return Ok(Self {
                    id: String::new(),
                    parent_id: None,
                    timestamp: 0,
                    data: EntryData::Other(Map::new()),
                });
            }
        };
        let id = match map.shift_remove("id") {
            Some(Value::String(id)) => id,
            _ => String::new(),
        };
        let parent_id = match map.shift_remove("parentId") {
            Some(Value::String(parent)) => Some(parent),
            _ => None,
        };
        let timestamp = map
            .shift_remove("timestamp")
            .as_ref()
            .and_then(number_u64)
            .unwrap_or(0);
        Ok(Self {
            id,
            parent_id,
            timestamp,
            data: EntryData::from_map(map),
        })
    }

    /// The message of a `message` entry.
    pub fn message(&self) -> Option<&Message> {
        match &self.data {
            EntryData::Message(message) => Some(message),
            _ => None,
        }
    }
}

impl Serialize for SessionEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SessionEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_value(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Validate complete records before exposing any source or coverage boundary.
/// Unknown extension types remain readable; malformed known records fail closed.
pub fn validate_values(values: &[Value]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for (index, value) in values.iter().enumerate() {
        let entry = SessionEntry::from_value(value.clone())?;
        if matches!(&entry.data, EntryData::Other(_))
            && matches!(
                value["type"].as_str(),
                Some(
                    "session"
                        | "message"
                        | "custom"
                        | "compaction"
                        | "model_change"
                        | "thinking_level_change"
                        | "session_info"
                )
            )
        {
            return Err("invalid_session_record".into());
        }
        if entry.id.is_empty() || !ids.insert(entry.id.clone()) {
            return Err("invalid_session_id".into());
        }
        if index == 0 {
            if !matches!(entry.data,EntryData::Session{ref session_id,..} if !session_id.is_empty())
                || entry.parent_id.is_some()
                || value.get("version").and_then(Value::as_u64) != Some(1)
            {
                return Err("invalid_session_header".into());
            }
        } else if matches!(entry.data, EntryData::Session { .. })
            || entry
                .parent_id
                .as_ref()
                .is_none_or(|id| !ids.contains(id) || *id == entry.id)
        {
            return Err("invalid_session_parent".into());
        }
    }
    Ok(())
}
pub fn parse_entries(text: &str) -> Result<Vec<SessionEntry>, String> {
    let parsed = crate::journal::parse(text.as_bytes())?;
    validate_values(&parsed.values)?;
    parsed
        .values
        .into_iter()
        .map(SessionEntry::from_value)
        .collect()
}

/// `chainOf(byId, leafId)`: entries on the chain ending at `leaf`, root
/// first. (A parent cycle, which TS would follow forever, ends the chain.)
fn chain_of<'a>(
    by_id: &HashMap<String, usize>,
    entries: &'a [SessionEntry],
    leaf: Option<&str>,
) -> Vec<&'a SessionEntry> {
    let lookup = |id: Option<&str>| {
        id.filter(|id| !id.is_empty())
            .and_then(|id| by_id.get(id))
            .map(|&index| &entries[index])
    };
    let mut chain = Vec::new();
    let mut cursor = lookup(leaf);
    while let Some(entry) = cursor {
        if chain.len() > entries.len() {
            break;
        }
        chain.push(entry);
        cursor = lookup(entry.parent_id.as_deref());
    }
    chain.reverse();
    chain
}

fn index_of(entries: &[SessionEntry]) -> HashMap<String, usize> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.id.clone(), index))
        .collect()
}

/// `readSessionBranch(dir)`: a session's active branch without opening a
/// store (never writes).
pub fn read_session_branch(dir: &Path) -> Result<Vec<SessionEntry>, String> {
    let file = dir.join(SESSION_FILE);
    if !file.exists() {
        return Ok(Vec::new());
    }
    let entries = parse_entries(&js::read_text(&file)?)?;
    let by_id = index_of(&entries);
    let leaf = entries.last().map(|entry| entry.id.as_str());
    Ok(chain_of(&by_id, &entries, leaf)
        .into_iter()
        .cloned()
        .collect())
}

fn summary_message(summary: &str, tokens_before: u64, timestamp: u64) -> Message {
    Message::CompactionSummary {
        summary: summary.to_owned(),
        tokens_before,
        timestamp,
    }
}

/// `historyOf(branch)`: every message on a branch (for UI history),
/// compacted ones included, with compaction summaries where they happened.
pub fn history_of(branch: &[SessionEntry]) -> Vec<Message> {
    branch
        .iter()
        .filter_map(|entry| match &entry.data {
            EntryData::Message(message) => Some(message.clone()),
            EntryData::Compaction {
                summary,
                tokens_before,
                ..
            } => Some(summary_message(summary, *tokens_before, entry.timestamp)),
            _ => None,
        })
        .collect()
}

/// `historyWithOperations(branch)`: `historyOf` plus each `ptc` operation,
/// in session order, as a tool result with `parentToolCallId` and `args`
/// (as JSON, since such a message is not a model [`Message`]).
pub fn history_with_operations(branch: &[SessionEntry]) -> Vec<Value> {
    let mut out = Vec::new();
    for entry in branch {
        if let EntryData::Custom { custom_type, data } = &entry.data
            && custom_type == OPERATION_ENTRY
        {
            let Some(data) = data.as_object() else {
                continue;
            };
            let (Some(tool_call_id), Some(parent_tool_call_id), Some(tool_name), Some(content)) = (
                data.get("toolCallId").and_then(Value::as_str),
                data.get("parentToolCallId").and_then(Value::as_str),
                data.get("toolName").and_then(Value::as_str),
                data.get("content").filter(|content| content.is_array()),
            ) else {
                continue;
            };
            let mut message = Map::new();
            message.insert("role".to_owned(), Value::from("toolResult"));
            message.insert("toolCallId".to_owned(), Value::from(tool_call_id));
            message.insert("toolName".to_owned(), Value::from(tool_name));
            message.insert(
                "parentToolCallId".to_owned(),
                Value::from(parent_tool_call_id),
            );
            let args = data
                .get("args")
                .filter(|args| args.is_object() || args.is_array())
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            message.insert("args".to_owned(), args);
            message.insert("content".to_owned(), content.clone());
            if let Some(details) = data.get("details") {
                message.insert("details".to_owned(), details.clone());
            }
            message.insert(
                "isError".to_owned(),
                Value::from(data.get("isError") == Some(&Value::Bool(true))),
            );
            let timestamp = match data.get("timestamp") {
                Some(Value::Number(number)) => Value::Number(number.clone()),
                _ => Value::from(entry.timestamp),
            };
            message.insert("timestamp".to_owned(), timestamp);
            out.push(Value::Object(message));
        } else {
            out.extend(
                history_of(std::slice::from_ref(entry))
                    .iter()
                    .map(|message| serde_json::to_value(message).unwrap_or(Value::Null)),
            );
        }
    }
    out
}

/// History with stable entry identities and user-message version selectors.
/// Read all entries because inactive sibling versions are not on the active chain.
pub fn read_session_history(dir: &Path) -> Result<Vec<Value>, String> {
    let file = dir.join(SESSION_FILE);
    if !file.exists() {
        return Ok(Vec::new());
    }
    let entries = parse_entries(&js::read_text(&file)?)?;
    let store = SessionStore {
        dir: dir.to_path_buf(),
        file,
        by_id: index_of(&entries),
        leaf_id: entries.last().map(|entry| entry.id.clone()),
        entries,
        writer: None,
        disk_hash: String::new(),
        write_failed: false,
    };
    let mut siblings: HashMap<Option<String>, Vec<Value>> = HashMap::new();
    for entry in &store.entries {
        if let EntryData::Message(Message::User { content, .. }) = &entry.data {
            siblings.entry(entry.parent_id.clone()).or_default().push(serde_json::json!({"entryId": entry.id, "text": user_text(content), "selected": false}));
        }
    }
    let mut out = Vec::new();
    for entry in store.branch() {
        for mut message in history_with_operations(std::slice::from_ref(&entry)) {
            if let Some(object) = message.as_object_mut() {
                object.insert("entryId".into(), Value::from(entry.id.as_str()));
                if matches!(entry.data, EntryData::Message(Message::User { .. })) {
                    let mut branches = siblings.get(&entry.parent_id).cloned().unwrap_or_default();
                    for version in &mut branches {
                        version["selected"] =
                            Value::Bool(version["entryId"].as_str() == Some(entry.id.as_str()));
                    }
                    object.insert("branches".into(), Value::Array(branches));
                }
            }
            out.push(message);
        }
    }
    Ok(out)
}

fn user_text(content: &UserContent) -> String {
    match content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                UserBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// Append a replacement user message without deleting any old continuation.
/// Call only after the session's runner has been stopped and evicted.
pub fn edit_session_message(
    dir: &Path,
    entry_id: &str,
    text: &str,
    effective_approval_mode: Option<&str>,
) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("Message must not be empty".into());
    }
    let mut store = SessionStore::open(dir.to_path_buf(), "")?;
    let entry = store
        .branch()
        .into_iter()
        .find(|entry| entry.id == entry_id)
        .ok_or("Message is not on the active branch")?;
    let EntryData::Message(Message::User { content, .. }) = entry.data else {
        return Err("Only user messages can be edited".into());
    };
    let content = match content {
        UserContent::Text(_) => UserContent::Text(text.to_owned()),
        UserContent::Blocks(blocks) => {
            let mut replacement = vec![UserBlock::Text {
                text: text.to_owned(),
                text_signature: None,
            }];
            replacement.extend(
                blocks
                    .into_iter()
                    .filter(|block| matches!(block, UserBlock::Image { .. })),
            );
            UserContent::Blocks(replacement)
        }
    };
    let settings = branch_settings(&store.branch(), effective_approval_mode)?;
    atomic_branch_mutation(&mut store, |store| {
        store.leaf_id = entry.parent_id;
        let id = store
            .append(EntryData::Message(Message::User {
                content,
                timestamp: crate::now_ms(),
            }))?
            .id;
        for data in settings {
            store.append(data)?;
        }
        Ok(id)
    })
}

/// Select a user variant and its most recently appended continuation.
/// The custom entry durably selects that chain while remaining invisible to models.
pub fn select_session_branch(
    dir: &Path,
    entry_id: &str,
    effective_approval_mode: Option<&str>,
) -> Result<(), String> {
    let mut store = SessionStore::open(dir.to_path_buf(), "")?;
    let target = store.get(entry_id).ok_or("Unknown message")?;
    if !matches!(target.data, EntryData::Message(Message::User { .. })) {
        return Err("Only user message versions can be selected".into());
    }
    // Only a visible version selector may change the conversation.
    if !store.branch().iter().any(|entry| {
        entry.parent_id == target.parent_id
            && matches!(entry.data, EntryData::Message(Message::User { .. }))
    }) {
        return Err("Message version is not on the active branch".into());
    }
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for entry in &store.entries {
        if let Some(parent) = entry.parent_id.as_deref() {
            children.entry(parent).or_default().push(&entry.id);
        }
    }
    let mut descendants = HashSet::new();
    let mut pending = vec![entry_id];
    while let Some(id) = pending.pop() {
        if descendants.insert(id)
            && let Some(next) = children.get(id)
        {
            pending.extend(next.iter().copied());
        }
    }
    let leaf = store
        .entries
        .iter()
        .rev()
        .find(|entry| descendants.contains(entry.id.as_str()))
        .map(|entry| entry.id.clone())
        .ok_or("Unknown branch")?;
    let settings = branch_settings(&store.branch(), effective_approval_mode)?;
    atomic_branch_mutation(&mut store, |store| {
        store.leaf_id = Some(leaf);
        store.append(EntryData::Custom {
            custom_type: "pirc.branch_selection".into(),
            data: Value::Null,
        })?;
        for data in settings {
            store.append(data)?;
        }
        Ok(())
    })
}

fn branch_settings(
    branch: &[SessionEntry],
    effective_approval_mode: Option<&str>,
) -> Result<Vec<EntryData>, String> {
    if effective_approval_mode
        .is_some_and(|mode| !matches!(mode, "read-only" | "auto" | "full-access"))
    {
        return Err("Unknown approval mode".into());
    }
    let mut settings = Vec::new();
    for kind in ["model_change", "thinking_level_change"] {
        if let Some(entry) = branch
            .iter()
            .rev()
            .find(|entry| entry.data.type_name() == kind)
        {
            settings.push(entry.data.clone());
        }
    }
    if let Some(role) = branch.iter().rev().find(|entry| matches!(&entry.data, EntryData::Custom { custom_type, .. } if custom_type == "agent.role")) {
        settings.push(role.data.clone());
    }
    // No explicit current mode must never restore a historical elevated mode.
    settings.push(
        effective_approval_mode
            .map(|mode| EntryData::Custom {
                custom_type: crate::auto_mode::APPROVAL_MODE_ENTRY.into(),
                data: serde_json::json!({"mode": mode}),
            })
            .or_else(|| {
                branch.iter().rev().find_map(|entry| match &entry.data {
                    EntryData::Custom { custom_type, .. }
                        if custom_type == crate::auto_mode::APPROVAL_MODE_ENTRY =>
                    {
                        Some(entry.data.clone())
                    }
                    _ => None,
                })
            })
            .unwrap_or_else(|| EntryData::Custom {
                custom_type: crate::auto_mode::APPROVAL_MODE_ENTRY.into(),
                data: serde_json::json!({"mode": "read-only"}),
            }),
    );
    Ok(settings)
}

/// Preserve the original bytes (including unknown/malformed lines), and publish
/// all branch entries with one rename. Requires the external session writer lock.
fn atomic_branch_mutation<T>(
    store: &mut SessionStore,
    mutate: impl FnOnce(&mut SessionStore) -> Result<T, String>,
) -> Result<T, String> {
    if crate::state_io::config().is_some() {
        return Err("branch_mutation_requires_host".into());
    }
    let original = store.file.clone();
    let temporary = store
        .dir
        .join(format!(".session-{}.tmp", crate::random_uuid()));
    let writer = store.writer.take().ok_or("writer_not_open")?;
    let expected = store.disk_hash.clone();
    let result = writer.transaction(|bytes| {
        if crate::journal::digest(bytes) != expected {
            return Err("session_stale_reopen".into());
        }
        let mut file = crate::state_io::create_new(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        store.file = temporary.clone();
        store.writer = Some(crate::journal::Journal::at_path(
            &temporary,
            validate_values,
        )?);
        store.disk_hash = expected;
        let value = mutate(store)?;
        file.sync_all().map_err(|e| e.to_string())?;
        crate::state_io::rename(&temporary, &original).map_err(|e| e.to_string())?;
        std::fs::File::open(&store.dir)
            .and_then(|f| f.sync_all())
            .map_err(|_| "commit_outcome_unknown_reopen")?;
        Ok((value, Vec::new()))
    });
    store.writer = None;
    store.file = original;
    let _ = std::fs::remove_file(&temporary);
    let _ = std::fs::remove_file(format!("{}.writer-mutex", temporary.display()));
    let _ = std::fs::remove_dir(format!("{}.writer-lock", temporary.display()));
    // Reload on either path: failed tentative branch entries must never remain in memory.
    let restored = SessionStore::open(store.dir.clone(), "")?;
    *store = restored;
    result
}

/// `contextEntriesOf(branch)`: what the model sees, the latest compaction
/// summary, then messages from its `firstKeptEntryId` on, with entry ids.
pub fn context_entries_of(branch: &[SessionEntry]) -> Vec<(String, Message)> {
    let snapshots = crate::handoff::valid_snapshots(branch);
    let latest = snapshots.last();
    let mut out = Vec::new();
    let mut start = 0;
    if let Some(entry) = latest
        && let EntryData::Compaction {
            summary,
            first_kept_entry_id,
            tokens_before,
            ..
        } = &entry.data
    {
        start = branch
            .iter()
            .position(|e| e.id == *first_kept_entry_id)
            .unwrap_or_else(|| branch.iter().position(|e| e.id == entry.id).unwrap() + 1);
        out.push((
            entry.id.clone(),
            summary_message(summary, *tokens_before, entry.timestamp),
        ));
    }
    out.extend(
        branch[start.min(branch.len())..]
            .iter()
            .filter_map(|e| e.message().map(|m| (e.id.clone(), m.clone()))),
    );
    out
}

/// `SessionStore`.
pub struct SessionStore {
    pub dir: PathBuf,
    pub file: PathBuf,
    entries: Vec<SessionEntry>,
    by_id: HashMap<String, usize>,
    leaf_id: Option<String>,
    writer: Option<crate::journal::Journal>,
    disk_hash: String,
    write_failed: bool,
}

impl SessionStore {
    /// Open (or create, 0700) the directory and read its session.
    pub fn open(dir: PathBuf, cwd: &str) -> Result<Self, String> {
        crate::state_io::create_dir_all(&dir)
            .map_err(|error| js::node_error(&error, "mkdir", Some(&dir)))?;
        let file = dir.join(SESSION_FILE);
        let mut store = Self {
            dir,
            file,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            writer: None,
            disk_hash: String::new(),
            write_failed: false,
        };
        let raw = if crate::state_io::config().is_some() {
            crate::state_io::session_open(&store.file).map_err(|e| e.to_string())?
        } else {
            let writer = crate::journal::Journal::at_path(&store.file, validate_values)?;
            let raw = writer.snapshot()?;
            store.writer = Some(writer);
            raw
        };
        store.disk_hash = crate::journal::digest(&raw);
        for entry in parse_entries(std::str::from_utf8(&raw).map_err(|_| "invalid_utf8")?)? {
            store.leaf_id = Some(entry.id.clone());
            store.by_id.insert(entry.id.clone(), store.entries.len());
            store.entries.push(entry);
        }
        if store.entries.is_empty() {
            store.append(EntryData::Session {
                session_id: crate::random_hex(8),
                cwd: cwd.to_owned(),
            })?;
        }
        Ok(store)
    }

    pub fn session_id(&self) -> String {
        match self.entries.first().map(|entry| &entry.data) {
            Some(EntryData::Session { session_id, .. }) => session_id.clone(),
            _ => "unknown".to_owned(),
        }
    }

    /// A write failed: every later append is refused until the session is
    /// reopened.
    pub fn write_failed(&self) -> bool {
        self.write_failed
    }

    /// `isNew`: only the header so far.
    pub fn is_new(&self) -> bool {
        self.entries.len() <= 1
    }

    /// `append(entry)`: written (0600) before it is returned.
    pub fn append(&mut self, data: EntryData) -> Result<SessionEntry, String> {
        let id = loop {
            let id = crate::random_hex(4);
            if !self.by_id.contains_key(&id) {
                break id;
            }
        };
        let entry = SessionEntry {
            id: id.clone(),
            // An empty leaf id (a line without one) is TS's `undefined`.
            parent_id: self.leaf_id.clone().filter(|leaf| !leaf.is_empty()),
            timestamp: crate::now_ms(),
            data,
        };
        let line = format!("{}\n", js::stringify(&entry.to_value()));
        if self.write_failed {
            return Err("commit_outcome_unknown_reopen".into());
        }
        let result = if let Some(writer) = &self.writer {
            writer.transaction(|raw| {
                if crate::journal::digest(raw) != self.disk_hash {
                    return Err("writer_stale_reopen".into());
                }
                let mut next = raw.to_vec();
                next.extend_from_slice(line.as_bytes());
                let parsed = crate::journal::parse(&next)?;
                validate_values(&parsed.values)?;
                Ok((crate::journal::digest(&next), line.as_bytes().to_vec()))
            })
        } else {
            let raw = std::fs::read(&self.file)
                .or_else(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        Ok(Vec::new())
                    } else {
                        Err(e)
                    }
                })
                .map_err(|_| "journal_read")?;
            if crate::journal::digest(&raw) != self.disk_hash {
                return Err("writer_stale_reopen".into());
            }
            let mut next = raw;
            next.extend_from_slice(line.as_bytes());
            crate::state_io::session_append(&self.file, &self.disk_hash, &entry.to_value())
                .map(|()| crate::journal::digest(&next))
                .map_err(|e| e.to_string())
        };
        match result {
            Ok(hash) => self.disk_hash = hash,
            Err(error) => {
                self.write_failed = true;
                return Err(error);
            }
        }
        self.by_id.insert(id.clone(), self.entries.len());
        self.entries.push(entry.clone());
        self.leaf_id = Some(id);
        Ok(entry)
    }

    pub fn get(&self, id: &str) -> Option<&SessionEntry> {
        self.by_id.get(id).map(|&index| &self.entries[index])
    }

    /// Entries on the active branch, root first.
    pub fn branch(&self) -> Vec<SessionEntry> {
        chain_of(&self.by_id, &self.entries, self.leaf_id.as_deref())
            .into_iter()
            .cloned()
            .collect()
    }

    /// `latest(type)`: the last entry of this `type` on the branch.
    pub fn latest(&self, type_name: &str) -> Option<SessionEntry> {
        chain_of(&self.by_id, &self.entries, self.leaf_id.as_deref())
            .into_iter()
            .rev()
            .find(|entry| entry.data.type_name() == type_name)
            .cloned()
    }

    /// `customEntries(customType)`: the branch's custom entries of a type.
    pub fn custom_entries(&self, custom_type: &str) -> Vec<SessionEntry> {
        chain_of(&self.by_id, &self.entries, self.leaf_id.as_deref())
            .into_iter()
            .filter(|entry| {
                matches!(&entry.data, EntryData::Custom { custom_type: kind, .. } if kind == custom_type)
            })
            .cloned()
            .collect()
    }

    /// Every message on the branch (UI history), compacted ones included.
    pub fn all_messages(&self) -> Vec<Message> {
        history_of(&self.branch())
    }

    /// What the model sees: the latest compaction summary, then messages
    /// from its `firstKeptEntryId` on, with their entry ids.
    pub fn context_entries(&self) -> Vec<(String, Message)> {
        context_entries_of(&self.branch())
    }

    /// `contextMessages()`.
    pub fn context_messages(&self) -> Vec<Message> {
        self.context_entries()
            .into_iter()
            .map(|(_, message)| message)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> EntryData {
        EntryData::Message(Message::User {
            content: pirc_protocol::UserContent::Text(text.to_owned()),
            timestamp: 1,
        })
    }

    #[test]
    fn edits_preserve_images_versions_and_selected_continuations() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let mut store = SessionStore::open(dir.to_path_buf(), "/work").unwrap();
        let original = store
            .append(EntryData::Message(Message::User {
                content: UserContent::Blocks(vec![
                    UserBlock::Text {
                        text: "old".into(),
                        text_signature: None,
                    },
                    UserBlock::Image {
                        data: "aGVsbG8=".into(),
                        mime_type: "image/png".into(),
                    },
                ]),
                timestamp: 1,
            }))
            .unwrap();
        store
            .append(EntryData::Custom {
                custom_type: crate::auto_mode::APPROVAL_MODE_ENTRY.into(),
                data: json!({"mode":"read-only"}),
            })
            .unwrap();
        let old_continuation = store.append(user("old continuation")).unwrap();
        drop(store);
        let edited = edit_session_message(dir, &original.id, "new", None).unwrap();
        let mut store = SessionStore::open(dir.to_path_buf(), "/work").unwrap();
        assert!(
            matches!(store.get(&edited).unwrap().message(), Some(Message::User { content: UserContent::Blocks(blocks), .. }) if blocks.len() == 2 && matches!(&blocks[1], UserBlock::Image { .. }))
        );
        let new_continuation = store.append(user("new continuation")).unwrap();
        drop(store);
        let history = read_session_history(dir).unwrap();
        assert_eq!(history[0]["branches"].as_array().unwrap().len(), 2);
        assert_eq!(history[0]["entryId"], edited);
        select_session_branch(dir, &original.id, None).unwrap();
        assert!(
            read_session_branch(dir)
                .unwrap()
                .iter()
                .any(|entry| entry.id == old_continuation.id)
        );
        assert!(edit_session_message(dir, &edited, "hidden", None).is_err());
        select_session_branch(dir, &edited, None).unwrap();
        let branch = read_session_branch(dir).unwrap();
        assert!(branch.iter().any(|entry| entry.id == new_continuation.id));
        assert_eq!(
            crate::auto_mode::recorded_approval_mode(&branch)
                .unwrap()
                .as_str(),
            "read-only"
        );
        assert!(edit_session_message(dir, &edited, "   ", None).is_err());
        assert!(select_session_branch(dir, "missing", None).is_err());
    }

    #[test]
    fn atomic_mutation_failure_preserves_original_bytes() {
        let root = tempfile::tempdir().unwrap();
        let mut store = SessionStore::open(root.path().to_path_buf(), "/work").unwrap();
        store.append(user("original")).unwrap();
        let original = std::fs::read(&store.file).unwrap();
        let result: Result<(), String> = atomic_branch_mutation(&mut store, |store| {
            store.append(user("never published"))?;
            Err("injected failure".into())
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&store.file).unwrap(), original);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 3);
    }

    #[test]
    fn preserves_effective_approval_and_current_role() {
        let root = tempfile::tempdir().unwrap();
        let mut store = SessionStore::open(root.path().to_path_buf(), "/work").unwrap();
        let original = store.append(user("original")).unwrap();
        store
            .append(EntryData::Custom {
                custom_type: "agent.role".into(),
                data: json!({"name":"reviewer","tools":["read"]}),
            })
            .unwrap();
        drop(store);
        edit_session_message(root.path(), &original.id, "edited", Some("auto")).unwrap();
        let branch = read_session_branch(root.path()).unwrap();
        assert_eq!(
            crate::auto_mode::recorded_approval_mode(&branch)
                .unwrap()
                .as_str(),
            "auto"
        );
        assert!(branch.iter().any(|entry| matches!(&entry.data, EntryData::Custom { custom_type, data } if custom_type == "agent.role" && data["name"] == "reviewer")));
    }

    #[test]
    fn history_read_does_not_create_session() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_session_history(root.path()).unwrap().is_empty());
        assert!(!root.path().join(SESSION_FILE).exists());
    }

    fn lines(store: &SessionStore) -> Vec<Value> {
        std::fs::read_to_string(&store.file)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn keys(value: &Value) -> Vec<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn writes_the_ts_shape_of_every_entry() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a/session");
        let mut store = SessionStore::open(dir.clone(), "/work").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&store.file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(store.is_new());
        assert_eq!(store.session_id().len(), 16);
        store.append(user("hi")).unwrap();
        store
            .append(EntryData::Custom {
                custom_type: "todo".into(),
                data: json!({"items": []}),
            })
            .unwrap();
        store
            .append(EntryData::Compaction {
                summary: "s".into(),
                first_kept_entry_id: "x".into(),
                tokens_before: 5,
                details: Some(json!({"files": 1.0})),
            })
            .unwrap();
        store
            .append(EntryData::ModelChange {
                provider: "p".into(),
                model_id: "m".into(),
            })
            .unwrap();
        store
            .append(EntryData::ThinkingLevelChange {
                thinking_level: "high".into(),
            })
            .unwrap();
        store
            .append(EntryData::SessionInfo {
                name: "n".into(),
                source: Some("user".into()),
            })
            .unwrap();
        assert!(!store.is_new());
        let written = lines(&store);
        let shapes: Vec<Vec<&str>> = written.iter().map(keys).collect();
        let tail = ["id", "parentId", "timestamp"];
        let with = |fields: &[&'static str]| [fields, &tail[..]].concat();
        assert_eq!(
            shapes,
            vec![
                with(&["type", "version", "sessionId", "cwd"]),
                with(&["type", "message"]),
                with(&["type", "customType", "data"]),
                with(&[
                    "type",
                    "summary",
                    "firstKeptEntryId",
                    "tokensBefore",
                    "details"
                ]),
                with(&["type", "provider", "modelId"]),
                with(&["type", "thinkingLevel"]),
                with(&["type", "name", "source"]),
            ]
        );
        assert_eq!(written[0]["version"], 1);
        assert_eq!(written[0]["parentId"], Value::Null);
        assert_eq!(written[0]["cwd"], "/work");
        for pair in written.windows(2) {
            assert_eq!(pair[1]["parentId"], pair[0]["id"]);
        }
        // Numbers are written as JSON.stringify writes them.
        let raw = std::fs::read_to_string(&store.file).unwrap();
        assert!(raw.contains(r#""details":{"files":1}"#));
        assert!(raw.ends_with('\n'));
    }

    #[test]
    fn malformed_known_sources_cannot_be_silently_covered() {
        let header = json!({"type":"session","version":1,"sessionId":"s","cwd":"/","id":"h","parentId":null});
        for invalid in [
            json!({"type":"message","message":{"role":"user","content":42}}),
            json!({"type":"compaction","summary":"lost source"}),
            json!({"type":"custom"}),
        ] {
            let mut invalid = invalid;
            invalid["id"] = json!("bad");
            invalid["parentId"] = json!("h");
            assert_eq!(
                validate_values(&[header.clone(), invalid]).unwrap_err(),
                "invalid_session_record"
            );
        }
        let future =
            json!({"type":"future.extension","payload":{"opaque":true},"id":"f","parentId":"h"});
        assert!(validate_values(&[header, future]).is_ok());
    }

    #[test]
    fn reads_every_shape_ts_wrote_and_skips_torn_lines() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("session");
        std::fs::create_dir(&dir).unwrap();
        let text = [
            r#"{"type":"session","version":1,"sessionId":"abc","cwd":"/w","id":"e1","parentId":null,"timestamp":1}"#,
            r#"{"type":"message","message":{"role":"user","content":"hello","timestamp":2},"id":"e2","parentId":"e1","timestamp":2}"#,
            r#"{"type":"label","target":"e2","id":"e3","parentId":"e2","timestamp":3}"#,
            "",
            "   ",
            r#"{"type":"session_info","name":"n","id":"e4","parentId":"e3","timestamp":4}"#,
            r#"{"type":"message","message":{"role":"assistant","#,
        ]
        .join("\n");
        std::fs::write(dir.join(SESSION_FILE), text).unwrap();
        let mut store = SessionStore::open(dir.clone(), "/elsewhere").unwrap();
        assert_eq!(store.session_id(), "abc");
        assert!(!store.is_new());
        let branch = store.branch();
        assert_eq!(
            branch.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["e1", "e2", "e3", "e4"]
        );
        let EntryData::Other(other) = &branch[2].data else {
            panic!("unknown types are kept");
        };
        assert_eq!(other.get("target"), Some(&json!("e2")));
        assert_eq!(branch[2].data.type_name(), "label");
        // Re-serialized, an unknown entry is what was read.
        assert_eq!(
            branch[2].to_value(),
            json!({"type":"label","target":"e2","id":"e3","parentId":"e2","timestamp":3})
        );
        assert_eq!(
            branch[3].data,
            EntryData::SessionInfo {
                name: "n".into(),
                source: None
            }
        );
        assert_eq!(store.latest("session_info").unwrap().id, "e4");
        assert_eq!(store.all_messages().len(), 1);
        let next = store.append(user("again")).unwrap();
        assert_eq!(next.parent_id.as_deref(), Some("e4"));
        assert_eq!(store.get(&next.id).unwrap().data, user("again"));
        // As in TS, the entry appended after a torn line without its newline
        // joins that line, so a reopened store no longer sees it.
        let reopened = SessionStore::open(dir.clone(), "/elsewhere").unwrap();
        assert_eq!(reopened.branch().len(), 5);
        assert!(reopened.get(&next.id).is_some());
        drop(reopened);
        let mut store = SessionStore::open(dir.clone(), "/elsewhere").unwrap();
        let last = store.append(user("third")).unwrap();
        let reopened = SessionStore::open(dir, "/elsewhere").unwrap();
        assert_eq!(reopened.branch().len(), 6);
        assert_eq!(
            reopened.get(&last.id).unwrap().parent_id.as_deref(),
            Some(next.id.as_str())
        );
    }

    #[test]
    fn a_trailing_line_without_an_id_leaves_an_empty_branch_as_in_ts() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("s");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join(SESSION_FILE),
            "{\"type\":\"session\",\"version\":1,\"sessionId\":\"a\",\"cwd\":\"/\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":1}\n5\n",
        )
        .unwrap();
        assert!(SessionStore::open(dir.clone(), "/").is_err());
        std::fs::write(dir.join(SESSION_FILE), "null\n").unwrap();
        assert!(SessionStore::open(dir, "/").is_err());
    }

    fn entry(id: &str, parent: Option<&str>, data: EntryData) -> SessionEntry {
        SessionEntry {
            id: id.into(),
            parent_id: parent.map(str::to_owned),
            timestamp: 7,
            data,
        }
    }

    #[test]
    fn context_starts_at_the_latest_compaction() {
        let compaction = |kept: &str| EntryData::Compaction {
            summary: format!("up to {kept}"),
            first_kept_entry_id: kept.into(),
            tokens_before: 10,
            details: None,
        };
        let branch = vec![
            entry(
                "header",
                None,
                EntryData::Session {
                    session_id: "session".into(),
                    cwd: "/work".into(),
                },
            ),
            entry("a", Some("header"), user("one")),
            entry("b", Some("a"), user("two")),
            entry("c", Some("b"), compaction("b")),
            entry("d", Some("c"), user("three")),
            entry("e", Some("d"), compaction("d")),
            entry("f", Some("e"), user("four")),
        ];
        let context = context_entries_of(&branch);
        let ids: Vec<&str> = context.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["e", "d", "f"]);
        assert_eq!(
            context[0].1,
            Message::CompactionSummary {
                summary: "up to d".into(),
                tokens_before: 10,
                timestamp: 7
            }
        );
        // A kept id not on the branch keeps what follows the compaction.
        let lost = vec![
            entry("a", None, user("one")),
            entry("b", Some("a"), compaction("zz")),
            entry("c", Some("b"), user("two")),
        ];
        let ids: Vec<String> = context_entries_of(&lost)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(ids, ["a", "c"]);
        // UI history keeps everything, with the summaries in place.
        let history = history_of(&branch);
        assert_eq!(history.len(), 6);
        assert!(matches!(history[2], Message::CompactionSummary { .. }));
    }

    #[test]
    fn history_nests_ptc_operations_before_their_result() {
        let op = |data: Value| EntryData::Custom {
            custom_type: OPERATION_ENTRY.into(),
            data,
        };
        let branch = vec![
            entry("a", None, user("go")),
            entry(
                "b",
                Some("a"),
                op(json!({
                    "parentToolCallId": "call_1", "toolCallId": "op_1", "toolName": "read",
                    "args": {"path": "x"}, "content": [{"type": "text", "text": "x"}],
                    "isError": false, "timestamp": 3
                })),
            ),
            entry(
                "c",
                Some("b"),
                op(
                    json!({"toolCallId": "op_2", "parentToolCallId": "call_1", "toolName": "ls",
                    "args": "bad", "content": [], "details": {"d": 1}}),
                ),
            ),
            entry("d", Some("c"), op(json!({"toolCallId": "op_3"}))),
            entry("e", Some("d"), op(Value::Null)),
            entry(
                "f",
                Some("e"),
                EntryData::Custom {
                    custom_type: "todo".into(),
                    data: json!({}),
                },
            ),
        ];
        let history = history_with_operations(&branch);
        assert_eq!(
            history,
            vec![
                json!({"role": "user", "content": "go", "timestamp": 1}),
                json!({"role": "toolResult", "toolCallId": "op_1", "toolName": "read",
                    "parentToolCallId": "call_1", "args": {"path": "x"},
                    "content": [{"type": "text", "text": "x"}], "isError": false, "timestamp": 3}),
                json!({"role": "toolResult", "toolCallId": "op_2", "toolName": "ls",
                    "parentToolCallId": "call_1", "args": {}, "content": [],
                    "details": {"d": 1}, "isError": false, "timestamp": 7}),
            ]
        );
        assert_eq!(
            keys(&history[2]),
            [
                "role",
                "toolCallId",
                "toolName",
                "parentToolCallId",
                "args",
                "content",
                "details",
                "isError",
                "timestamp"
            ]
        );
    }

    #[test]
    fn read_session_branch_never_writes() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_session_branch(root.path()).unwrap().is_empty());
        assert!(!root.path().join(SESSION_FILE).exists());
        let mut store = SessionStore::open(root.path().to_owned(), "/w").unwrap();
        store.append(user("x")).unwrap();
        let branch = read_session_branch(root.path()).unwrap();
        assert_eq!(branch, store.branch());
        // Round trip through serde.
        let value = serde_json::to_value(&branch[1]).unwrap();
        assert_eq!(
            serde_json::from_value::<SessionEntry>(value).unwrap(),
            branch[1]
        );
    }
}
