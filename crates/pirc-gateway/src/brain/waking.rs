//! A wake turn (plans/rewrite/05-self-wake.md): what the brain is given
//! when it wakes up without anyone asking, and the tools around waking:
//! `speak` (the only way a wake says something in the room), and
//! `schedule_wake` / `cancel_wake` (coming back later to look at
//! something, said in the room with a line that cancels it).
//!
//! "Nothing writes unasked": a wake only reads and remembers. The tools
//! that act for people (`stop_worker`, `room_sources`) are not in a
//! wake's tool list at all ([`NOT_IN_WAKES`]), and a worker it calls works
//! read-only; `speak` is not in a conversation's ([`ONLY_IN_WAKES`]):
//! there the reply itself is said.

use std::rc::Rc;

use pirc_agent::LocalBoxFuture;
use pirc_agent::agent::Agent;
use pirc_agent::context::PromptSection;
use pirc_agent::feature::Feature;
use pirc_agent::tools::{Tool, ToolContext, ToolResult};
use serde_json::{Map, Value, json};

use super::loops::AnchorInput;
use super::memory::{RoomMemory, object};
use super::turn::Progress;
use crate::app::App;
use crate::db::rooms::{MessageKind, Room, RoomStore, Speaker};
use crate::memory::text::clip;
use crate::util::now_ms;
use crate::wake::{self, Kind, NewWake, Wake};

/// Tools a wake does not have: the ones that act for people, or change
/// what they set up (which sources a room follows). A worker a wake calls
/// is read-only instead, and it cannot stop one people asked for.
pub const NOT_IN_WAKES: &[&str] = &[
    "stop_worker",
    "answer_worker_question",
    "room_sources",
    "create_face",
    "move_room",
    "topic",
];
/// Tools only a wake has.
pub const ONLY_IN_WAKES: &[&str] = &["speak"];
/// Room messages a wake is shown.
const RECENT_MESSAGES: usize = 10;
const RECENT_CHARS: usize = 400;
const SPEAK_MAX: usize = 4000;
/// Self wakes waiting at most.
const PENDING_SELF_MAX: i64 = 20;

/// What decides whether a wake says anything: decision #4, the default of
/// the house rules. `CHAT.md` and people's preferences come after it and
/// win.
pub const WHEN_TO_SPEAK: &str = "## When to speak after waking\n\n\
These are the defaults; the house rules and people's preferences come after them and win where they differ.\n\
- An open loop's time came: always say it (\"time for the team meeting\"); the day before a deadline, say it too.\n\
- A source changed (an email, the calendar): say it only when it touches an open loop or something the room follows.\n\
- You came back to look at something yourself: say it only when you found something worth knowing.\n\
- Otherwise stay silent.";

/// The prompt sections only a wake has: what waking is, then when to
/// speak. They go after the room, before the house rules.
pub fn sections(app: &App, wake: &Wake) -> Vec<PromptSection> {
    let text = format!(
        "## Waking up\n\n\
         Nobody called you: you woke up on your own, at {} ({}). This is not a conversation: \
         what you write as a reply is shown to nobody. To say something in the room, call `speak` with the message (once is usually enough); \
         if nothing is worth saying, just end, and the room sees nothing. \
         While awake you only read and remember: you may search, look in memory, keep facts, and open, change or close loops \
         (or come back later with `schedule_wake`), but you do nothing on anyone's behalf: \
         when something needs doing, ask in the room with `speak` or keep it as an open loop.",
        wake::when(app, now_ms()),
        match wake.kind.as_str() {
            "anchor" => "an open loop's time came",
            "self" => "you asked to come back",
            _ => "a source changed",
        },
    );
    vec![
        PromptSection::new("wake", "Waking up", "built-in", text),
        PromptSection::new(
            "wake-rules",
            "When to speak after waking",
            "built-in default",
            WHEN_TO_SPEAK,
        ),
    ]
}

/// The wake's input: what woke it and the room's latest messages.
pub fn input(app: &App, wake: &Wake, room: &Room) -> String {
    let mut text = format!(
        "[You woke up; nobody called you.]\n{}",
        wake::describe(app, wake)
    );
    let recent = app
        .db
        .lock()
        .list_messages(&room.id, None, RECENT_MESSAGES)
        .unwrap_or_default();
    if !recent.is_empty() {
        text.push_str(&format!("\n\nThe latest in #{} (oldest first):", room.name));
        for message in recent {
            let who = match (&message.user, message.kind.as_str()) {
                (Some(user), _) => user.clone(),
                (None, "line") => "(line)".to_owned(),
                (None, _) => "you".to_owned(),
            };
            let said = message
                .body
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            text.push_str(&format!(
                "\n{who}: {}",
                clip(&said.replace('\n', " "), RECENT_CHARS)
            ));
        }
    }
    text
}

/// The feature that gives a room's agent the wake tools.
pub struct WakeFeature {
    pub memory: Rc<RoomMemory>,
    pub progress: Rc<Progress>,
}

impl Feature for WakeFeature {
    fn name(&self) -> &'static str {
        "brain-wake"
    }

    fn tools(&self, _agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        [Which::Speak, Which::Schedule, Which::Cancel]
            .into_iter()
            .map(|which| {
                Rc::new(WakeTool::new(
                    which,
                    self.memory.clone(),
                    self.progress.clone(),
                )) as Rc<dyn Tool>
            })
            .collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Which {
    Speak,
    Schedule,
    Cancel,
}

struct WakeTool {
    which: Which,
    memory: Rc<RoomMemory>,
    progress: Rc<Progress>,
    description: String,
    parameters: Map<String, Value>,
}

impl WakeTool {
    fn new(which: Which, memory: Rc<RoomMemory>, progress: Rc<Progress>) -> Self {
        let (description, parameters) = match which {
            Which::Speak => (
                "Say something in the room while you are awake (only then: in a conversation your reply is what you say).                  The people it is for get a notification. Call it only when something is worth saying.",
                object(
                    json!({ "text": { "type": "string", "description": "The message, as you would write it in the room." } }),
                    &["text"],
                ),
            ),
            Which::Schedule => (
                "Come back later to look at something (\"I'll look at his dotfiles tonight\"): you wake up then, on your own, in the room.                  One time only. The room is shown a line (\"I'll come back … to look at …\") anyone can cancel.                  For something people want to be reminded of, open a loop with a time instead.",
                object(
                    json!({
                        "at": { "type": "string", "description": "A date and time, like 2026-10-22T18:00, a wall-clock time in `zone`." },
                        "zone": { "type": "string", "description": "An IANA time zone; the household's own when left out." },
                        "why": { "type": "string", "description": "What you will look at, briefly." },
                        "room": { "type": "string", "description": "The room id to come back in, when not this one." },
                    }),
                    &["at", "why"],
                ),
            ),
            Which::Cancel => (
                "Cancel coming back (a wake you scheduled), when it is no longer needed. The room is told.",
                object(
                    json!({ "id": { "type": "string", "description": "The wake's id." } }),
                    &["id"],
                ),
            ),
        };
        Self {
            which,
            memory,
            progress,
            description: description.to_owned(),
            parameters,
        }
    }

    fn run(&self, args: &Map<String, Value>) -> ToolResult {
        let text = |key: &str| -> Result<String, String> {
            args.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("`{key}` is required"))
        };
        let app = &self.memory.app;
        match self.which {
            Which::Speak => {
                let said = match text("text") {
                    Ok(said) => said,
                    Err(error) => return ToolResult::error(error),
                };
                let Some(wake) = self.progress.wake.borrow().clone() else {
                    return ToolResult::error(
                        "`speak` is for when you wake up; in a conversation, just answer",
                    );
                };
                if said.encode_utf16().count() > SPEAK_MAX {
                    return ToolResult::error(format!(
                        "A message holds at most {SPEAK_MAX} characters"
                    ));
                }
                let posted = app.db.lock().post_message(
                    &wake.room_id,
                    Speaker::Face(&self.memory.face()),
                    MessageKind::Text,
                    &json!({ "text": said }),
                );
                match posted {
                    Ok(message) => {
                        app.room_message(&message);
                        if let Ok(room) = app.db.lock().get_room(&wake.room_id) {
                            app.room_changed(&room);
                        }
                        wake::push(app, &wake, &said);
                        self.progress.spoke.set(true);
                        ToolResult::text("Said in the room.")
                    }
                    Err(error) => ToolResult::error(error.message),
                }
            }
            Which::Schedule => {
                let (at, why) = match (text("at"), text("why")) {
                    (Ok(at), Ok(why)) => (at, why),
                    (Err(error), _) | (_, Err(error)) => return ToolResult::error(error),
                };
                let why = match wake::why(&why) {
                    Ok(why) => why,
                    Err(error) => return ToolResult::error(error),
                };
                let now = now_ms();
                let input = AnchorInput {
                    at: Some(at),
                    zone: args.get("zone").and_then(Value::as_str).map(str::to_owned),
                    ..Default::default()
                };
                let at = match input.resolve(&app.config.timezone, now) {
                    Ok(anchor) => anchor.due_at,
                    Err(error) => return ToolResult::error(error),
                };
                let room_id = match args.get("room").and_then(Value::as_str) {
                    None => self.memory.room_id.clone(),
                    Some(room_id) => match app.db.lock().get_room(room_id) {
                        Ok(room) if room.archived_at.is_none() => room.id,
                        _ => return ToolResult::error(format!("No room {room_id}")),
                    },
                };
                let waiting: i64 = app
                    .db
                    .lock()
                    .query_row(
                        "SELECT count(*) FROM wakes WHERE kind='self' AND outcome IS NULL",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                if waiting >= PENDING_SELF_MAX {
                    return ToolResult::error(format!(
                        "{PENDING_SELF_MAX} are waiting already; cancel one first"
                    ));
                }
                let user = self.memory.owner().or_else(|| {
                    self.progress
                        .wake
                        .borrow()
                        .as_ref()
                        .and_then(|wake| wake.user.clone())
                });
                let face = self.memory.face();
                let scheduled = wake::schedule(
                    app,
                    &NewWake {
                        kind: Kind::SelfScheduled,
                        trigger: json!({ "at": at, "why": why }),
                        room_id: &room_id,
                        face_id: Some(&face),
                        user: user.as_deref(),
                        scheduled_at: at,
                    },
                );
                match scheduled {
                    Ok(scheduled) => {
                        wake::say(app, &scheduled, false);
                        ToolResult::text(format!(
                            "You come back {} (wake {}).",
                            wake::when(app, at),
                            scheduled.id
                        ))
                    }
                    Err(error) => ToolResult::error(error.message),
                }
            }
            Which::Cancel => {
                let id = match text("id") {
                    Ok(id) => id,
                    Err(error) => return ToolResult::error(error),
                };
                let cancelled = wake::cancel(&app.db.lock(), &id, now_ms());
                match cancelled {
                    Ok((found, true)) => ToolResult::text(format!(
                        "{} has ended already ({}).",
                        found.id,
                        found.outcome.as_deref().unwrap_or_default()
                    )),
                    Ok((found, false)) => {
                        wake::changed(app, &found);
                        if found.kind == Kind::SelfScheduled.as_str() {
                            wake::say(app, &found, true);
                        }
                        ToolResult::text(format!("Cancelled {}.", found.id))
                    }
                    Err(error) => ToolResult::error(error.message),
                }
            }
        }
    }
}

impl Tool for WakeTool {
    fn name(&self) -> &str {
        match self.which {
            Which::Speak => "speak",
            Which::Schedule => "schedule_wake",
            Which::Cancel => "cancel_wake",
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
        Box::pin(async move { Ok(self.run(&args)) })
    }
}
