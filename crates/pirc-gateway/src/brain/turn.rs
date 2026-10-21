//! One room's conversation with the brain: its `pirc-agent` session, the
//! reply it streams into the room, and what people said, made into the
//! brain's input.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use pirc_agent::agent::{Agent, AgentOptions, Delivery};
use pirc_agent::config::{AgentConfig, HooksConfig, Limits};
use pirc_agent::host::{HostProfile, ModelCatalog};
use pirc_agent::session_store::SessionStore;
use pirc_agent::stream::StreamFn;
use pirc_agent::tools::Tool;
use pirc_protocol::{AssistantContent, AssistantDelta, Message as AgentMessage, StopReason, Usage};
use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::loop_tools::LoopsFeature;
use super::memory::{BrainPromoter, MemoryFeature, RoomMemory};
use super::source_tools::SourcesFeature;
use super::store::{brain_dir, room_dir};
use super::ui::BrainUi;
use super::waking::WakeFeature;
use super::worker_tools::WorkerFeature;
use crate::app::AppState;
use crate::db::rooms::{HOST_FACE_ID, Message, MessageKind, Pending, RoomStore, Speaker};
use crate::error::ApiResult;
use crate::util::now_ms;

/// The least time between two writes of a streaming reply.
const STREAM_WRITE_MS: i64 = 250;

/// What a room's agent did, as its events tell it.
#[derive(Default)]
pub struct Progress {
    /// User messages admitted to the conversation so far.
    pub admitted: Cell<u64>,
    /// User messages handed to the agent so far (each `say`).
    pub said: Cell<u64>,
    /// The latest reply of the turn ended so; `None` before any.
    pub last_stop: Cell<Option<StopReason>>,
    /// Its error message, or a warning the agent gave.
    pub last_error: RefCell<Option<String>>,
    /// Token usage of the turn's replies.
    pub usage: RefCell<Option<Usage>>,
    /// The wake this turn is, while it runs: its replies are shown to
    /// nobody, only what it says with `speak` (plans/rewrite/05).
    pub wake: RefCell<Option<crate::wake::Wake>>,
    /// The wake said something in the room.
    pub spoke: Cell<bool>,
    /// Wakes whoever waits on the fields above.
    pub changed: Notify,
}

impl Progress {
    /// Start counting a new turn.
    pub fn reset_turn(&self) {
        self.last_stop.set(None);
        self.last_error.borrow_mut().take();
        self.usage.borrow_mut().take();
    }
}

/// A room's agent.
pub struct RoomAgent {
    pub agent: Rc<Agent>,
    pub progress: Rc<Progress>,
    pub memory: Rc<RoomMemory>,
}

impl RoomAgent {
    pub async fn open(
        app: &AppState,
        room_id: &str,
        (stream, tools): (Rc<dyn StreamFn>, Vec<Rc<dyn Tool>>),
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self, String> {
        let home = brain_dir(&app.config.state_dir).display().to_string();
        let store = SessionStore::open(room_dir(&app.config.state_dir, room_id), &home)?;
        let progress = Rc::new(Progress::default());
        let memory = RoomMemory::new(app.clone(), room_id);
        let reply = RefCell::new(Reply::new(
            app.clone(),
            room_id.to_owned(),
            progress.clone(),
        ));
        let agent = Agent::new(AgentOptions {
            config: config(&home),
            role: None,
            store,
            emit: Rc::new(move |event: Value| reply.borrow_mut().on_event(&event)),
            ui: Rc::new(BrainUi::new(progress.clone())),
            has_ui: false,
            tools,
            // Observational memory compacts the room's conversation, and
            // what its dropper lets go becomes facts.
            features: vec![
                pirc_agent::features::memory::feature_with(Rc::new(BrainPromoter(memory.clone()))),
                Rc::new(MemoryFeature {
                    memory: memory.clone(),
                    runtime: runtime.clone(),
                }),
                Rc::new(LoopsFeature {
                    memory: memory.clone(),
                }),
                Rc::new(WakeFeature {
                    memory: memory.clone(),
                    progress: progress.clone(),
                }),
                Rc::new(WorkerFeature {
                    memory: memory.clone(),
                    progress: progress.clone(),
                    runtime: runtime.clone(),
                }),
                Rc::new(SourcesFeature {
                    memory: memory.clone(),
                    runtime: runtime.clone(),
                }),
            ],
            acquire_write: None,
            allowed_tools: None,
            stream: Some(stream),
            models: Some(Rc::new(Catalog(app.clone()))),
            host: HostProfile::Brain,
        });
        agent.refresh_models().await;
        agent.init().await?;
        Ok(Self {
            agent,
            progress,
            memory,
        })
    }

    /// Hand people's words to the agent, with custom messages right after
    /// them (how workers ended): a run starts, or the running one is
    /// steered. The ticket is admitted once `progress.admitted` reaches it.
    pub fn say_with(&self, text: String, notes: Vec<Delivery>) -> u64 {
        let ticket = self.progress.said.get() + 1;
        self.progress.said.set(ticket);
        self.agent.say_with(text, Vec::new(), notes);
        ticket
    }
}

/// The gateway's public catalog, as nodes get it.
struct Catalog(AppState);

impl ModelCatalog for Catalog {
    fn models(&self) -> Option<pirc_protocol::Models> {
        serde_json::from_value(self.0.public_models()).ok()
    }
}

/// An agent without a workspace: the worker-only fields stay empty, and the
/// base prompt is replaced before each turn (`identity::sections`).
fn config(home: &str) -> AgentConfig {
    AgentConfig {
        config_dir: home.to_owned(),
        workspace: home.to_owned(),
        models: crate::app::empty_models(),
        default_model: None,
        allowed_paths: Vec::new(),
        protected_paths: Vec::new(),
        project_root: home.to_owned(),
        warnings: Vec::new(),
        path_policy: Default::default(),
        sandboxed: false,
        env: Vec::new(),
        hooks: HooksConfig::default(),
        limits: Limits::default(),
        features: Default::default(),
        role_dirs: Vec::new(),
        system_prompt: Vec::new(),
        mode: brain_mode(),
    }
}

/// The work mode without a repository: observational memory keeps no
/// workspace ledger for the brain (its facts go to the gateway).
fn brain_mode() -> pirc_protocol::mode::Mode {
    let mut mode = pirc_protocol::mode::default_work();
    mode.workspace_memory = false;
    mode.repository = false;
    mode
}

/// The reply being streamed into the room: one room message per assistant
/// message that has text, `streaming: true` until it ends.
struct Reply {
    app: AppState,
    room_id: String,
    progress: Rc<Progress>,
    message_id: Option<String>,
    text: String,
    written_at: i64,
}

impl Reply {
    fn new(app: AppState, room_id: String, progress: Rc<Progress>) -> Self {
        Self {
            app,
            room_id,
            progress,
            message_id: None,
            text: String::new(),
            written_at: 0,
        }
    }

    fn on_event(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str) {
            Some("message_update") => {
                let delta = event
                    .get("assistantMessageEvent")
                    .and_then(|delta| serde_json::from_value::<AssistantDelta>(delta.clone()).ok());
                if let Some(AssistantDelta::TextDelta { delta, .. }) = delta
                    && !self.waking()
                {
                    self.text.push_str(&delta);
                    if now_ms() - self.written_at >= STREAM_WRITE_MS {
                        self.write(true);
                    }
                }
            }
            Some("message_end") => {
                let message = event.get("message").and_then(|message| {
                    serde_json::from_value::<AgentMessage>(message.clone()).ok()
                });
                match message {
                    Some(AgentMessage::Assistant(message)) => self.end(&message),
                    Some(AgentMessage::User { .. }) => {
                        let progress = &self.progress;
                        progress.admitted.set(progress.admitted.get() + 1);
                        progress.changed.notify_waiters();
                    }
                    _ => {}
                }
            }
            Some("agent_end") => self.progress.changed.notify_waiters(),
            _ => {}
        }
    }

    /// A wake's replies are shown to nobody.
    fn waking(&self) -> bool {
        self.progress.wake.borrow().is_some()
    }

    fn end(&mut self, message: &pirc_protocol::AssistantMessage) {
        let text: String = message
            .content
            .iter()
            .filter_map(|block| match block {
                AssistantContent::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        if !text.is_empty() {
            self.text = text;
        }
        if !self.text.is_empty() && !self.waking() {
            self.write(false);
        }
        self.message_id = None;
        self.text.clear();
        let progress = &self.progress;
        progress.last_stop.set(Some(message.stop_reason));
        if let Some(error) = &message.error_message {
            *progress.last_error.borrow_mut() = Some(error.clone());
        }
        let mut usage = progress.usage.borrow_mut();
        *usage = Some(match usage.take() {
            None => message.usage.clone(),
            Some(sum) => add_usage(sum, &message.usage),
        });
        drop(usage);
        progress.changed.notify_waiters();
    }

    fn write(&mut self, streaming: bool) {
        self.written_at = now_ms();
        let body = if streaming {
            json!({ "text": self.text, "streaming": true })
        } else {
            json!({ "text": self.text })
        };
        let result = {
            let db = self.app.db.lock();
            match &self.message_id {
                None => db
                    .post_message(
                        &self.room_id,
                        Speaker::Face(HOST_FACE_ID),
                        MessageKind::Text,
                        &body,
                    )
                    .map(|message| (message, true)),
                Some(id) => db
                    .update_message(&self.room_id, id, &body, false)
                    .map(|message| (message, false)),
            }
        };
        match result {
            Ok((message, true)) => {
                self.message_id = Some(message.id.clone());
                self.app.room_message(&message);
                room_changed(&self.app, &self.room_id);
            }
            Ok((message, false)) => self.app.room_message_updated(&message),
            // E.g. the room was archived meanwhile: the reply stays in the
            // brain's conversation only.
            Err(error) => crate::log::warn(&format!(
                "brain: cannot write its reply in {}: {}",
                self.room_id, error.message
            )),
        }
    }
}

fn add_usage(mut sum: Usage, more: &Usage) -> Usage {
    sum.input += more.input;
    sum.output += more.output;
    sum.cache_read += more.cache_read;
    sum.cache_write += more.cache_write;
    sum.total_tokens += more.total_tokens;
    sum
}

/// A line from the host in a room (a turn that failed or was stopped).
pub fn post_line(app: &AppState, room_id: &str, text: &str) {
    let posted = app.db.lock().post_message(
        room_id,
        Speaker::Face(HOST_FACE_ID),
        MessageKind::Line,
        &json!({ "text": text }),
    );
    match posted {
        Ok(message) => {
            app.room_message(&message);
            room_changed(app, room_id);
        }
        Err(error) => crate::log::warn(&format!(
            "brain: cannot write a line in {room_id}: {}",
            error.message
        )),
    }
}

/// A new message moved the room up the list.
fn room_changed(app: &AppState, room_id: &str) {
    if let Ok(room) = app.db.lock().get_room(room_id) {
        app.room_changed(&room);
    }
}

/// What people said in a room, as one input of the brain: each message on
/// its own line(s) as `name: text`, in the order the room got them, with
/// attachments named (the brain cannot open them yet). Ids of messages
/// that are gone are skipped.
pub fn compose(conn: &Connection, room_id: &str, batches: &[Pending]) -> ApiResult<String> {
    let mut messages: Vec<Message> = Vec::new();
    for id in batches.iter().flat_map(|batch| &batch.message_ids) {
        match conn.get_message(room_id, id) {
            Ok(message) => messages.push(message),
            Err(error) if error.status == 404 => {}
            Err(error) => return Err(error),
        }
    }
    messages.sort_by_key(|message| message.seq);
    Ok(messages
        .iter()
        .map(|message| {
            let who = message.user.as_deref().unwrap_or("someone");
            let mut line = format!(
                "{who}: {}",
                message
                    .body
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            );
            for attachment in message
                .body
                .get("attachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let name = attachment
                    .get("filename")
                    .and_then(Value::as_str)
                    .or_else(|| attachment.get("mimeType").and_then(Value::as_str))
                    .unwrap_or("file");
                let kind = attachment
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("file");
                line.push_str(&format!(" [attached {kind}: {name}]"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::db::rooms::{GENERAL_ROOM_ID, RoomInputStore};

    #[test]
    fn composes_the_batches_in_room_order() {
        let db = Db::memory();
        let conn = db.lock();
        for (user, text) in [("ann", "hi"), ("bob", "hello\nthere"), ("ann", "and")] {
            conn.send_user_message(GENERAL_ROOM_ID, user, text, &[], false)
                .unwrap();
        }
        let pending = conn.list_pending().unwrap();
        // Bob's batch is listed second but his message came between Ann's.
        let text = compose(&conn, GENERAL_ROOM_ID, &pending).unwrap();
        assert_eq!(text, "ann: hi\nbob: hello\nthere\nann: and");
        let missing = Pending {
            message_ids: vec!["msg_gone".into()],
            ..pending[0].clone()
        };
        assert_eq!(compose(&conn, GENERAL_ROOM_ID, &[missing]).unwrap(), "");
    }
}
