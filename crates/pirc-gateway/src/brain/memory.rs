//! The brain's memory (plans/rewrite/03-memory.md), from a room's agent:
//!
//! - preferences, small and always in the prompt ([`sections`]);
//! - facts, searchable and never in the prompt as a whole: the brain
//!   writes them without asking (`remember`), observational memory's
//!   dropper hands over what it lets go ([`Promoter`]), and before each
//!   turn the facts closest to what was said come along ("You may
//!   remember", [`sections`]);
//! - forgetting, on the person's word (`forget`).
//!
//! Who a memory came from is the gateway's to say, never the model's: a
//! fact's origin is `user` when nothing but people's messages came since
//! the last one, else the latest tool it read (`tool:<name>`; what a
//! worker reported is `tool:delegation`); a
//! preference needs a quote of what a person said, which also says whose
//! it is; forgetting needs one too, so nothing the brain reads can make it
//! forget. Each memory written is said in the room as a line that undoes
//! it.

use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::time::Instant;

use pirc_agent::LocalBoxFuture;
use pirc_agent::agent::Agent;
use pirc_agent::context::PromptSection;
use pirc_agent::feature::Feature;
use pirc_agent::features::memory::Promoter;
use pirc_agent::features::memory::ledger::Observation;
use pirc_agent::features::memory::serialize::{entry_origin, user_text};
use pirc_agent::origins::{current_origins, quote_words};
use pirc_agent::session_store::{EntryData, SessionEntry};
use pirc_agent::tools::{Tool, ToolContext, ToolResult};
use pirc_protocol::Message as AgentMessage;
use serde_json::{Map, Value, json};
use tokio::runtime::Handle;

use crate::app::AppState;
use crate::db::rooms::HOST_FACE_ID;
use crate::error::ApiError;
use crate::memory::lines::{self, Remembered};
use crate::memory::text::clip;
use crate::memory_records::person::{self, NewFact};
use crate::memory_records::{self, Scopes};

/// The tools that write memory or open loops: their results are not where
/// a memory came from.
pub(super) const WRITING_TOOLS: [&str; 17] = [
    "remember",
    "save_preference",
    "forget",
    "open_loop",
    "close_loop",
    "touch_loop",
    "update_loop",
    "reopen_loop",
    "call_worker",
    "stop_worker",
    // The faces' and rooms' tools (plan 10) only say what the brain did.
    "speak_as",
    "topic",
    "create_face",
    "update_face",
    "move_room",
    "create_room",
    "archive_room",
];
/// What a worker reported (its report, or `worker_status`): one origin,
/// `tool:delegation`, whichever way it came.
const FROM_WORKERS: [&str; 2] = ["custom:worker-report", "tool:worker_status"];
const DELEGATION: &str = "tool:delegation";
/// A quote must come from people's last this many messages.
const QUOTE_MESSAGES: usize = 3;
/// Facts recalled before a turn, at most, and their length.
const RECALLED: usize = 6;
const RECALLED_CHARS: usize = 300;
/// The time recall may take before a turn; slower, it is left out.
const RECALL_BUDGET_MS: u128 = 200;

/// A room's memory: who is talking there, for the tools, the promoter and
/// the prompt, and the face the brain speaks as (plans/rewrite/10-faces.md):
/// what it writes and opens is labelled with it.
pub struct RoomMemory {
    pub(super) app: AppState,
    pub(super) room_id: String,
    /// The people of the room's latest turn, in the order they spoke.
    speakers: RefCell<Vec<String>>,
    /// The face the brain speaks as now.
    face: RefCell<String>,
    /// The people's messages the turn took, and the messages it wrote.
    turn_messages: RefCell<Vec<String>>,
    /// What the turn was about (`topic`), once the brain said.
    topic: RefCell<Option<super::moving::Topic>>,
}

impl RoomMemory {
    pub fn new(app: AppState, room_id: &str) -> Rc<Self> {
        Rc::new(Self {
            app,
            room_id: room_id.to_owned(),
            speakers: RefCell::default(),
            face: RefCell::new(HOST_FACE_ID.to_owned()),
            turn_messages: RefCell::default(),
            topic: RefCell::default(),
        })
    }

    /// A new turn's people (its batches' senders).
    pub fn set_speakers(&self, speakers: Vec<String>) {
        *self.speakers.borrow_mut() = speakers;
    }

    /// A new turn, as `face`.
    pub fn start_turn(&self, face: &str) {
        *self.face.borrow_mut() = face.to_owned();
        self.turn_messages.borrow_mut().clear();
        self.topic.borrow_mut().take();
    }

    /// The face the brain speaks as now.
    pub fn face(&self) -> String {
        self.face.borrow().clone()
    }

    pub fn set_face(&self, face: &str) {
        *self.face.borrow_mut() = face.to_owned();
    }

    /// Messages of the turn: what people said, what it wrote.
    pub fn add_turn_messages(&self, ids: &[String]) {
        let mut messages = self.turn_messages.borrow_mut();
        for id in ids {
            if !messages.contains(id) {
                messages.push(id.clone());
            }
        }
    }

    /// The turn's messages, as they stand (people's and the brain's own).
    pub(super) fn turn_messages(&self) -> Vec<String> {
        self.turn_messages.borrow().clone()
    }

    pub fn set_topic(&self, topic: super::moving::Topic) {
        *self.topic.borrow_mut() = Some(topic);
    }

    /// The turn's topic, if the brain said it.
    pub fn current_topic(&self) -> Option<String> {
        self.topic.borrow().as_ref().map(|topic| topic.name.clone())
    }

    /// The turn's topic and its messages, once it ends.
    pub fn take_topic(&self) -> Option<(super::moving::Topic, Vec<String>)> {
        let topic = self.topic.borrow_mut().take()?;
        Some((topic, self.turn_messages.borrow().clone()))
    }

    fn speakers(&self) -> Vec<String> {
        self.speakers.borrow().clone()
    }

    /// Whom a memory without a quote belongs to: the turn's first speaker,
    /// else whoever spoke last in the room.
    pub(super) fn owner(&self) -> Option<String> {
        if let Some(first) = self.speakers.borrow().first() {
            return Some(first.clone());
        }
        self.app
            .db
            .lock()
            .query_row(
                "SELECT user FROM room_messages WHERE room_id=? AND speaker='user' AND user IS NOT NULL ORDER BY seq DESC LIMIT 1",
                [&self.room_id],
                |row| row.get(0),
            )
            .ok()
    }
}

// ---------- the prompt ----------

/// The memory sections of a turn's prompt: the speakers' preferences, and
/// the facts closest to what they said (`said`, their messages without
/// the names).
pub fn sections(app: &AppState, speakers: &[String], said: &str) -> Vec<PromptSection> {
    let mut sections = Vec::new();
    let mut preferences = Vec::new();
    {
        let conn = app.db.lock();
        let store = crate::memory::store(app, &conn);
        for user in speakers {
            match store.list(user, Some("active")) {
                Ok(list) => preferences.extend(
                    list.into_iter()
                        .map(|preference| (user.clone(), preference.id, preference.content)),
                ),
                Err(error) => crate::log::warn(&format!(
                    "brain: cannot read preferences: {}",
                    error.message
                )),
            }
        }
    }
    let mut text = String::from(
        "## Preferences\n\nHow the people here want things, on their own word (`save_preference` only when they say so or say yes to your offer; `forget` when they ask).",
    );
    if preferences.is_empty() {
        text.push_str("\n\n(none yet)");
    }
    for (user, id, content) in &preferences {
        let whose = if speakers.len() > 1 {
            format!(" ({user})")
        } else {
            String::new()
        };
        text.push_str(&format!("\n- [{id}]{whose} {content}"));
    }
    sections.push(PromptSection::new(
        "memory:preferences",
        "Preferences",
        "memory",
        text,
    ));
    let started = Instant::now();
    let recalled = if said.trim().is_empty() || speakers.is_empty() {
        Vec::new()
    } else {
        match memory_records::search_facts(app, speakers, said, RECALLED, Scopes::Person) {
            Ok(hits) => hits,
            Err(error) if error.status == 400 => Vec::new(),
            Err(error) => {
                crate::log::warn(&format!("brain: recall failed: {}", error.message));
                Vec::new()
            }
        }
    };
    let elapsed = started.elapsed().as_millis();
    if elapsed > RECALL_BUDGET_MS {
        crate::log::warn(&format!(
            "brain: recall took {elapsed} ms (budget {RECALL_BUDGET_MS} ms); left out"
        ));
    } else if !recalled.is_empty() {
        let mut text = String::from(
            "## You may remember\n\nFacts found by the words used; they may be stale or beside the point. Only `from user` is the person's own word; `memory_search` finds more.",
        );
        for hit in &recalled {
            let field = |key: &str| hit.get(key).and_then(Value::as_str).unwrap_or_default();
            text.push_str(&format!(
                "\n- [{}] ({}, from {}) {}",
                field("id"),
                field("date"),
                field("origin"),
                clip(field("content"), RECALLED_CHARS),
            ));
        }
        sections.push(PromptSection::new(
            "memory:recalled",
            "You may remember",
            "memory",
            text,
        ));
    }
    sections
}

// ---------- the promoter ----------

/// Observations the dropper lets go become the household's facts
/// (`om:promoted`), so leaving the prompt is not leaving memory.
pub struct BrainPromoter(pub Rc<RoomMemory>);

impl Promoter for BrainPromoter {
    fn promote(&self, observations: &[Observation]) -> Result<(), String> {
        let memory = &self.0;
        let Some(owner) = memory.owner() else {
            crate::log::warn(&format!(
                "brain: nobody to keep {} dropped observations of {} for",
                observations.len(),
                memory.room_id
            ));
            return Ok(());
        };
        let face = memory.face();
        let conn = memory.app.db.lock();
        for observation in observations {
            let mut sources = vec![observation.id.clone()];
            sources.extend(observation.source_entry_ids.iter().cloned());
            sources.truncate(50);
            let content = clip(&observation.content, crate::memory::store::ENTRY_MAX_CHARS);
            let fact = NewFact {
                content: &content,
                origin: "om:promoted",
                room_id: Some(&memory.room_id),
                face_id: Some(&face),
                source_entry_ids: &sources,
                actor: "om",
            };
            match person::remember(&conn, &owner, &fact) {
                Ok(_) => {}
                // Forgotten text stays forgotten; an empty one is nothing.
                Err(error) if error.status == 409 || error.status == 400 => {}
                Err(error) => return Err(error.message),
            }
        }
        drop(conn);
        memory.app.memory_changed(&owner);
        Ok(())
    }
}

// ---------- the tools ----------

/// The feature that gives a room's agent its memory tools.
pub struct MemoryFeature {
    pub memory: Rc<RoomMemory>,
    pub runtime: Handle,
}

impl Feature for MemoryFeature {
    fn name(&self) -> &'static str {
        "brain-memory"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        let shared = |kind: Kind| -> Rc<dyn Tool> {
            Rc::new(MemoryTool::new(
                kind,
                self.memory.clone(),
                Rc::downgrade(agent),
                self.runtime.clone(),
            ))
        };
        vec![
            shared(Kind::Remember),
            shared(Kind::Search),
            shared(Kind::RecallNote),
            shared(Kind::SavePreference),
            shared(Kind::Forget),
        ]
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Remember,
    Search,
    RecallNote,
    SavePreference,
    Forget,
}

struct MemoryTool {
    kind: Kind,
    memory: Rc<RoomMemory>,
    agent: Weak<Agent>,
    /// The gateway's main runtime, where node requests run.
    runtime: Handle,
    description: String,
    parameters: Map<String, Value>,
}

pub(super) fn object(properties: Value, required: &[&str]) -> Map<String, Value> {
    let Value::Object(schema) = json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    }) else {
        unreachable!("an object")
    };
    schema
}

impl MemoryTool {
    fn new(kind: Kind, memory: Rc<RoomMemory>, agent: Weak<Agent>, runtime: Handle) -> Self {
        let (description, parameters) = match kind {
            Kind::Remember => (
                "Remember a fact about the people here or their world (\"uses TLP for power management\", \"HW3 is due on 10/24\") for later turns, in any room. \
                 One fact per call, in a short sentence that stands on its own. No approval is needed: the room is shown a line \
                 (\"Noted: …\") they can undo, and the gateway records where it came from (what people said, or the tool you read it in). \
                 Do not remember what is already in Preferences or in the facts you were shown.",
                object(
                    json!({ "fact": { "type": "string", "description": "The fact, one sentence." } }),
                    &["fact"],
                ),
            ),
            Kind::Search => (
                "Search what you remembered: the people's facts (scope `person`, the default), the repositories' workspace notes \
                 and delegations (`repo`), or both (`all`). Words and Chinese phrases match; the most relevant come first. \
                 Each hit has its id, date and, for facts, where it came from (`user` is the person's own word).",
                object(
                    json!({
                        "query": { "type": "string", "description": "Words to look for." },
                        "scope": { "type": "string", "enum": ["person", "repo", "all"] },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 20 },
                    }),
                    &["query"],
                ),
            ),
            Kind::RecallNote => (
                "Read a repository's workspace note found by `memory_search` (scope `repo`) in full, with the work \
                 around it: its node reads the session that wrote it (the gateway's copy when the node is offline).",
                object(
                    json!({ "id": { "type": "string", "description": "The note's 12-character id." } }),
                    &["id"],
                ),
            ),
            Kind::SavePreference => (
                "Save a preference: how a person wants things (\"prefers short answers\", \"replies in Traditional Chinese\"). \
                 Preferences are always in your prompt, so keep them few and short. Only on a person's word: `quote` must be \
                 their own words from one of their last messages (their \"yes\" to your offer, or what they asked), which also \
                 says whose preference it is.",
                object(
                    json!({
                        "preference": { "type": "string", "description": "The preference, one short sentence." },
                        "quote": { "type": "string", "description": "The person's words, exactly as they wrote them." },
                    }),
                    &["preference", "quote"],
                ),
            ),
            Kind::Forget => (
                "Forget a fact or a preference for real, when a person asks (\"forget that\", \"don't keep that\"): it leaves \
                 memory, search and the room's line, and the same text is not kept again. `id` is the [id] shown with it; \
                 `quote` is the person's words asking for it, from one of their last messages.",
                object(
                    json!({
                        "id": { "type": "string" },
                        "quote": { "type": "string", "description": "The person's words, exactly as they wrote them." },
                    }),
                    &["id", "quote"],
                ),
            ),
        };
        Self {
            kind,
            memory,
            agent,
            runtime,
            description: description.to_owned(),
            parameters,
        }
    }

    async fn run(&self, args: Map<String, Value>) -> Result<ToolResult, String> {
        let Some(agent) = self.agent.upgrade() else {
            return Err("The room's conversation is closed".to_owned());
        };
        let text = |key: &str| -> Result<String, String> {
            args.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("`{key}` is required"))
        };
        let memory = &self.memory;
        let app = &memory.app;
        let branch = agent.branch();
        // Anyone of the household may have said the quote.
        let mut people: Vec<String> = app.config.auth.allowed_users.iter().cloned().collect();
        people.sort();
        let refused = |error: ApiError| Ok(ToolResult::error(error.message));
        match self.kind {
            Kind::Remember => {
                let fact = text("fact")?;
                let Some(owner) = memory.owner() else {
                    return Ok(ToolResult::error("Nobody has said anything here yet"));
                };
                let origin = origin_now(&branch, &agent.running_script_capabilities());
                let sources = turn_entry_ids(&branch);
                let written = person::remember(
                    &app.db.lock(),
                    &owner,
                    &NewFact {
                        content: &fact,
                        origin: &origin,
                        room_id: Some(&memory.room_id),
                        face_id: Some(&memory.face()),
                        source_entry_ids: &sources,
                        actor: &format!("face:{}", memory.face()),
                    },
                );
                let (fact, unchanged) = match written {
                    Ok(written) => written,
                    Err(error) => return refused(error),
                };
                if unchanged {
                    return Ok(ToolResult::text(format!(
                        "Already remembered [{}]: {}",
                        fact.id, fact.content
                    )));
                }
                lines::post(
                    app,
                    &memory.room_id,
                    Remembered::Fact,
                    (&fact.id, &fact.content, &fact.origin),
                    &owner,
                );
                app.memory_changed(&owner);
                Ok(ToolResult::text(format!(
                    "Remembered [{}] (from {}): {}",
                    fact.id, fact.origin, fact.content
                )))
            }
            Kind::Search => {
                let query = text("query")?;
                let scopes = match args.get("scope").and_then(Value::as_str) {
                    None => Scopes::Person,
                    Some(name) => Scopes::parse(name).ok_or("`scope` is person, repo or all")?,
                };
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map_or(8, |limit| limit.clamp(1, 20) as usize);
                let mut speakers = memory.speakers();
                if speakers.is_empty() {
                    speakers.extend(memory.owner());
                }
                let hits = match memory_records::search_facts(app, &speakers, &query, limit, scopes)
                {
                    Ok(hits) => hits,
                    Err(error) => return refused(error),
                };
                if hits.is_empty() {
                    return Ok(ToolResult::text("Nothing found."));
                }
                let lines: Vec<String> = hits.iter().map(hit_line).collect();
                Ok(ToolResult::text(lines.join("\n")))
            }
            Kind::RecallNote => {
                let id = text("id")?;
                let Some(owner) = memory.owner() else {
                    return Ok(ToolResult::error("Nobody has said anything here yet"));
                };
                let valid =
                    id.len() == 12 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
                if !valid {
                    return Ok(ToolResult::error(
                        "A note id is 12 lowercase hex characters",
                    ));
                }
                // Node requests run on the gateway's main runtime.
                let (app, runtime) = (app.clone(), self.runtime.clone());
                let task =
                    runtime.spawn(async move { crate::memory::recall(&app, &owner, &id).await });
                let _abort = super::stream::AbortOnDrop(task.abort_handle());
                match task.await {
                    Ok(Ok(result)) => Ok(ToolResult::text(
                        result
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )),
                    Ok(Err(error)) => refused(error),
                    Err(_) => Err("The note could not be read".to_owned()),
                }
            }
            Kind::SavePreference => {
                let preference = text("preference")?;
                let quote = text("quote")?;
                let Some((owner, entry_id)) = quoted(&branch, &quote, &people) else {
                    return Ok(ToolResult::error(
                        "That quote is not in what anyone here said in their last messages; ask them first",
                    ));
                };
                let change = crate::memory::store::Change {
                    actor: format!("face:{}", memory.face()),
                    origins: json!(["user"]),
                    sources: json!({ "roomId": memory.room_id, "entryIds": [entry_id], "quote": quote }),
                };
                let saved = {
                    let conn = app.db.lock();
                    crate::memory::store(app, &conn).add(
                        &owner,
                        &preference,
                        Some(&memory.room_id),
                        &change,
                    )
                };
                let (saved, unchanged) = match saved {
                    Ok(saved) => saved,
                    Err(error) => return refused(error),
                };
                if unchanged {
                    return Ok(ToolResult::text(format!(
                        "Already a preference [{}]: {}",
                        saved.id, saved.content
                    )));
                }
                lines::post(
                    app,
                    &memory.room_id,
                    Remembered::Preference,
                    (&saved.id, &saved.content, "user"),
                    &owner,
                );
                app.memory_changed(&owner);
                Ok(ToolResult::text(format!(
                    "Saved preference [{}] for {owner}: {}",
                    saved.id, saved.content
                )))
            }
            Kind::Forget => {
                let id = text("id")?;
                let quote = text("quote")?;
                let Some((owner, _)) = quoted(&branch, &quote, &people) else {
                    return Ok(ToolResult::error(
                        "That quote is not in what anyone here said in their last messages; forget only when asked",
                    ));
                };
                let forgotten = if id.starts_with('p') {
                    lines::forget_preference(app, &owner, &id)
                } else {
                    lines::forget_fact(app, &owner, &id, &format!("face:{}", memory.face()))
                        .map(drop)
                };
                match forgotten {
                    Ok(()) => Ok(ToolResult::text(format!("Forgot [{id}].",))),
                    Err(error) => refused(error),
                }
            }
        }
    }
}

impl Tool for MemoryTool {
    fn name(&self) -> &str {
        match self.kind {
            Kind::Remember => "remember",
            Kind::Search => "memory_search",
            Kind::RecallNote => "recall_note",
            Kind::SavePreference => "save_preference",
            Kind::Forget => "forget",
        }
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> &Map<String, Value> {
        &self.parameters
    }

    fn execute<'a>(
        &'a self,
        args: Map<String, Value>,
        _ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>> {
        Box::pin(self.run(args))
    }
}

/// A search hit as the model reads it.
fn hit_line(hit: &Value) -> String {
    let field = |key: &str| hit.get(key).and_then(Value::as_str).unwrap_or_default();
    let whence = match field("kind") {
        "fact" => format!("fact, from {}", field("origin")),
        "delegation" => format!("delegation to {}", field("workspace")),
        _ => format!("note of {}", field("workspace")),
    };
    let status = match field("status") {
        "active" | "completed" => String::new(),
        status => format!(", {status}"),
    };
    format!(
        "[{}] ({whence}, {}{status}) {}",
        field("id"),
        field("date"),
        field("content")
    )
}

/// Where what the brain knows now came from: `user` when only people's
/// messages came since the last one, else the latest tool result's origin.
pub(super) fn origin_now(branch: &[SessionEntry], running: &[String]) -> String {
    let origin = latest_origin(branch, running);
    if FROM_WORKERS.contains(&origin.as_str()) {
        DELEGATION.to_owned()
    } else {
        origin
    }
}

fn latest_origin(branch: &[SessionEntry], running: &[String]) -> String {
    let origins = current_origins(branch, running, &WRITING_TOOLS);
    let tools: Vec<&String> = origins
        .iter()
        .filter(|origin| *origin != "assistant")
        .collect();
    if tools.is_empty() {
        return "user".to_owned();
    }
    for entry in branch.iter().rev() {
        let EntryData::Message(message) = &entry.data else {
            continue;
        };
        match message {
            AgentMessage::User { .. } => break,
            AgentMessage::ToolResult { tool_name, .. }
                if WRITING_TOOLS.contains(&tool_name.as_str()) => {}
            AgentMessage::ToolResult { .. } | AgentMessage::Custom { .. } => {
                let origin = entry_origin(branch, message);
                if tools.iter().any(|known| **known == origin) {
                    return origin;
                }
            }
            _ => {}
        }
    }
    tools[0].clone()
}

/// The ids of this turn's entries so far: the last user message and what
/// came after it.
pub(super) fn turn_entry_ids(branch: &[SessionEntry]) -> Vec<String> {
    let start = branch
        .iter()
        .rposition(|entry| matches!(entry.data, EntryData::Message(AgentMessage::User { .. })))
        .unwrap_or(branch.len());
    branch[start..]
        .iter()
        .map(|entry| entry.id.clone())
        .take(20)
        .collect()
}

/// Who said `quote` in one of the last messages people sent (each
/// `name: text` line of the brain's input), and that message's entry: a
/// quote holds two characters or more, or is all the person wrote ("ok").
pub(super) fn quoted(
    branch: &[SessionEntry],
    quote: &str,
    speakers: &[String],
) -> Option<(String, String)> {
    let wanted = quote_words(quote);
    if wanted.is_empty() {
        return None;
    }
    let long = wanted.encode_utf16().count() >= 2;
    branch
        .iter()
        .rev()
        .filter_map(|entry| match &entry.data {
            EntryData::Message(AgentMessage::User { content, .. }) => {
                Some((entry.id.clone(), user_text(content)))
            }
            _ => None,
        })
        .take(QUOTE_MESSAGES)
        .find_map(|(entry_id, text)| {
            said_by(&text, speakers)
                .into_iter()
                .rev()
                .find(|(_, said)| {
                    let said = quote_words(said);
                    said == wanted || (long && said.contains(&wanted))
                })
                .map(|(who, _)| (who, entry_id))
        })
}

/// A brain input split into what each person said (`name: text` lines;
/// a line without a known name goes on the one before).
fn said_by(text: &str, speakers: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let speaker = speakers.iter().find(|name| {
            line.strip_prefix(name.as_str())
                .is_some_and(|rest| rest.starts_with(": "))
        });
        match (speaker, out.last_mut()) {
            (Some(name), _) => out.push((name.clone(), line[name.len() + 2..].to_owned())),
            (None, Some((_, said))) => {
                said.push('\n');
                said.push_str(line);
            }
            (None, None) => {}
        }
    }
    out
}

/// What people said in a turn's input, without the names, for recall.
pub fn without_names(text: &str, speakers: &[String]) -> String {
    let parts = said_by(text, speakers);
    if parts.is_empty() {
        return text.to_owned();
    }
    parts
        .into_iter()
        .map(|(_, said)| said)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pirc_protocol::UserContent;

    fn user(id: &str, text: &str) -> SessionEntry {
        SessionEntry {
            id: id.to_owned(),
            parent_id: None,
            timestamp: 0,
            data: EntryData::Message(AgentMessage::User {
                content: UserContent::Text(text.to_owned()),
                timestamp: 0,
            }),
        }
    }

    #[test]
    fn a_quote_says_who_said_it() {
        let speakers = vec!["ann@x".to_owned(), "bob@x".to_owned()];
        let branch = vec![
            user(
                "e1",
                "ann@x: I use TLP on the laptop\nbob@x: and I use powertop",
            ),
            user("e2", "bob@x: ok"),
        ];
        assert_eq!(
            quoted(&branch, "I use TLP", &speakers),
            Some(("ann@x".to_owned(), "e1".to_owned()))
        );
        assert_eq!(
            quoted(&branch, "「use powertop」", &speakers),
            Some(("bob@x".to_owned(), "e1".to_owned()))
        );
        assert_eq!(
            quoted(&branch, "OK", &speakers),
            Some(("bob@x".to_owned(), "e2".to_owned())),
            "a short quote is all they wrote"
        );
        assert_eq!(quoted(&branch, "o", &speakers), None);
        assert_eq!(quoted(&branch, "use TLP and powertop", &speakers), None);
        assert_eq!(quoted(&branch, "TLP", &["carol@x".to_owned()]), None);
    }

    #[test]
    fn dropped_observations_become_searchable_facts() {
        let (app, _dir) = crate::memory::tests::app();
        let memory = RoomMemory::new(app.clone(), "room_general");
        let observation = |id: &str, content: &str| Observation {
            id: id.to_owned(),
            content: content.to_owned(),
            timestamp: "2026-10-20 10:00".to_owned(),
            relevance: pirc_agent::features::memory::ledger::Relevance::High,
            source_entry_ids: vec!["e1".to_owned()],
            origins: Some(vec!["user".to_owned()]),
            token_count: 10.0,
            raw: json!({}),
        };
        // Nobody spoke yet: nothing to keep them for, and they still go.
        BrainPromoter(memory.clone())
            .promote(&[observation("aaaaaaaaaaaa", "ignored")])
            .unwrap();
        memory.set_speakers(vec!["me@example.com".to_owned()]);
        BrainPromoter(memory.clone())
            .promote(&[
                observation("bbbbbbbbbbbb", "The user is moving to Tainan in December"),
                observation("cccccccccccc", "  "),
            ])
            .unwrap();
        let hits = memory_records::search_facts(
            &app,
            &["me@example.com".to_owned()],
            "搬家 Tainan",
            8,
            Scopes::Person,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["origin"], "om:promoted");
        let fact = person::get(
            &app.db.lock(),
            "me@example.com",
            hits[0]["id"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fact.source_entry_ids, json!(["bbbbbbbbbbbb", "e1"]));
        assert_eq!(
            person::history(&app.db.lock(), "me@example.com", &fact.id).unwrap()[0].actor,
            "om"
        );
    }

    #[test]
    fn what_a_worker_reported_is_from_the_delegation() {
        let custom = |id: &str, custom_type: &str| SessionEntry {
            id: id.to_owned(),
            parent_id: None,
            timestamp: 0,
            data: EntryData::Message(AgentMessage::Custom {
                custom_type: custom_type.to_owned(),
                content: "Worker report".to_owned(),
                display: false,
                details: None,
                timestamp: 0,
            }),
        };
        let branch = vec![
            user("e1", "ann@x: how did the tests go?"),
            custom("e2", "worker-report"),
        ];
        assert_eq!(origin_now(&branch, &[]), "tool:delegation");
        // Before the person's words, it is not what this turn knows from.
        let branch = vec![custom("e2", "worker-report"), user("e3", "ann@x: thanks")];
        assert_eq!(origin_now(&branch, &[]), "user");
    }

    #[test]
    fn names_are_taken_out_for_recall() {
        let speakers = vec!["ann@x".to_owned()];
        assert_eq!(
            without_names("ann@x: power\nstill on battery\nann@x: TLP?", &speakers),
            "power\nstill on battery\nTLP?"
        );
        assert_eq!(without_names("hello", &speakers), "hello");
    }
}
