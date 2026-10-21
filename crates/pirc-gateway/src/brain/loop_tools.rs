//! The brain's tools for open loops (plans/rewrite/04-open-loops.md):
//! `open_loop`, `close_loop`, `touch_loop`, `update_loop`, `reopen_loop`.
//! No approval: opening and closing are said in the room as lines that
//! undo them. The origin is worked out as for facts ([`origin_now`]).

use std::rc::{Rc, Weak};

use pirc_agent::LocalBoxFuture;
use pirc_agent::agent::Agent;
use pirc_agent::feature::Feature;
use pirc_agent::tools::{Tool, ToolContext, ToolResult};
use serde_json::{Map, Value, json};

use super::loops::{self, AnchorInput, Changes, Event, NewLoop, OpenLoop};
use super::memory::{RoomMemory, object, origin_now, turn_entry_ids};
use crate::db::rooms::RoomStore;
use crate::util::now_ms;

/// The feature that gives a room's agent the loop tools.
pub struct LoopsFeature {
    pub memory: Rc<RoomMemory>,
}

impl Feature for LoopsFeature {
    fn name(&self) -> &'static str {
        "brain-loops"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        [
            Kind::Open,
            Kind::Close,
            Kind::Touch,
            Kind::Update,
            Kind::Reopen,
        ]
        .into_iter()
        .map(|kind| {
            Rc::new(LoopTool::new(
                kind,
                self.memory.clone(),
                Rc::downgrade(agent),
            )) as Rc<dyn Tool>
        })
        .collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Open,
    Close,
    Touch,
    Update,
    Reopen,
}

struct LoopTool {
    kind: Kind,
    memory: Rc<RoomMemory>,
    agent: Weak<Agent>,
    description: String,
    parameters: Map<String, Value>,
}

fn anchor_schema() -> Value {
    json!({
        "type": "object",
        "description": "When it has a time: `at` for one time, or `cron` when it repeats. Times are wall-clock times in `zone`.",
        "properties": {
            "at": { "type": "string", "description": "A date and time, like 2026-10-22T18:00." },
            "cron": { "type": "string", "description": "A cron pattern (minute hour day month weekday), like `0 18 * * 3` for Wednesdays at 18:00." },
            "zone": { "type": "string", "description": "An IANA time zone; the household's own when left out." },
            "until": { "type": "string", "description": "With `cron`: the date and time after which it no longer comes." },
            "autoClose": { "type": "boolean", "description": "With `at`: the time is the thing itself (a meeting, a deadline), so it closes once the time passes." },
        },
        "additionalProperties": false,
    })
}

fn id_schema() -> Value {
    json!({ "type": "string", "description": "The loop's [id]." })
}

impl LoopTool {
    fn new(kind: Kind, memory: Rc<RoomMemory>, agent: Weak<Agent>) -> Self {
        let (description, parameters) = match kind {
            Kind::Open => (
                "Open a loop: something still open between you and the people here (\"wants to tune the laptop's power policy\", \
                 \"team meeting every Wednesday at 18:00\", \"HW3 is due on 10/24\"). It stays in your prompt until closed. \
                 No approval is needed: the room is shown a line (\"Holding on to: …\") they can undo, and the gateway records where it came from. \
                 Open one per thing; one that is already open is touched instead.",
                object(
                    json!({
                        "what": { "type": "string", "description": "What is open, one short sentence." },
                        "why": { "type": "string", "description": "Why it is still open: the context, briefly." },
                        "anchor": anchor_schema(),
                        "next_check": { "type": "string", "description": "What to look at next time, when there is something (\"look at his dotfiles\")." },
                        "room": { "type": "string", "description": "The room id it belongs to, when not this one." },
                    }),
                    &["what"],
                ),
            ),
            Kind::Close => (
                "Close a loop: it is resolved (\"he says it works now\", \"the PR was merged\"), or someone says it no longer matters. \
                 The room is shown a line with the reason.",
                object(
                    json!({
                        "id": id_schema(),
                        "reason": { "type": "string", "description": "Why it is closed, briefly." },
                    }),
                    &["id", "reason"],
                ),
            ),
            Kind::Touch => (
                "Mark a loop as mentioned again, so it stays among the ones kept in front of you.",
                object(json!({ "id": id_schema() }), &["id"]),
            ),
            Kind::Update => (
                "Change an open loop: what it is, why, its time anchor (null takes it away) or what to check next (null takes it away).",
                object(
                    json!({
                        "id": id_schema(),
                        "what": { "type": "string" },
                        "why": { "type": "string" },
                        "anchor": { "anyOf": [anchor_schema(), { "type": "null" }] },
                        "next_check": { "type": ["string", "null"] },
                    }),
                    &["id"],
                ),
            ),
            Kind::Reopen => (
                "Open a closed loop again, when someone says it is not done after all, or asks for one that went to memory \
                 (a fact found with an open loop's id).",
                object(json!({ "id": id_schema() }), &["id"]),
            ),
        };
        Self {
            kind,
            memory,
            agent,
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
        let now = now_ms();
        let anchor = |value: &Value| -> Result<loops::Anchor, String> {
            let input: AnchorInput = serde_json::from_value(value.clone())
                .map_err(|error| format!("Invalid anchor: {error}"))?;
            input.resolve(&app.config.timezone, now)
        };
        match self.kind {
            Kind::Open => {
                let what = text("what")?;
                let Some(owner) = memory.owner() else {
                    return Ok(ToolResult::error("Nobody has said anything here yet"));
                };
                let room_id = match args.get("room").and_then(Value::as_str) {
                    None => memory.room_id.clone(),
                    Some(room_id) => {
                        let room = app.db.lock().get_room(room_id);
                        match room {
                            Ok(room) if room.archived_at.is_none() => room.id,
                            _ => return Ok(ToolResult::error(format!("No room {room_id}"))),
                        }
                    }
                };
                let anchor = match args.get("anchor").filter(|value| !value.is_null()) {
                    None => None,
                    Some(value) => match anchor(value) {
                        Ok(anchor) => Some(anchor),
                        Err(error) => return Ok(ToolResult::error(error)),
                    },
                };
                let branch = agent.branch();
                let origin = origin_now(&branch, &agent.running_script_capabilities());
                let sources = turn_entry_ids(&branch);
                let why = args.get("why").and_then(Value::as_str).unwrap_or_default();
                let opened = loops::open(
                    &app.db.lock(),
                    &NewLoop {
                        user: &owner,
                        room_id: Some(&room_id),
                        face_id: Some(&memory.face()),
                        what: &what,
                        why,
                        origin: &origin,
                        anchor,
                        next_check: args.get("next_check").and_then(Value::as_str),
                        source_entry_ids: &sources,
                    },
                    now,
                );
                match opened {
                    Ok((open_loop, true)) => {
                        loops::changed(app, &open_loop);
                        Ok(ToolResult::text(format!(
                            "Already open, touched: {}",
                            summary(&open_loop)
                        )))
                    }
                    Ok((open_loop, false)) => {
                        loops::say(app, &memory.room_id, &open_loop, Event::Opened);
                        Ok(ToolResult::text(format!("Opened {}", summary(&open_loop))))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
            Kind::Close => {
                let (id, reason) = (text("id")?, text("reason")?);
                let closed = loops::close(&app.db.lock(), &id, &reason, now);
                match closed {
                    Ok((open_loop, true)) => Ok(ToolResult::text(format!(
                        "[{}] was already closed ({}).",
                        open_loop.id,
                        loops::reason_text(open_loop.closed_reason.as_deref().unwrap_or_default())
                    ))),
                    Ok((open_loop, false)) => {
                        loops::say(app, &memory.room_id, &open_loop, Event::Closed);
                        Ok(ToolResult::text(format!("Closed [{}].", open_loop.id)))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
            Kind::Touch => {
                let id = text("id")?;
                let touched = loops::touch(&app.db.lock(), &id, now);
                match touched {
                    Ok(open_loop) => {
                        loops::changed(app, &open_loop);
                        Ok(ToolResult::text(format!("Touched [{}].", open_loop.id)))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
            Kind::Update => {
                let id = text("id")?;
                let anchor = match args.get("anchor") {
                    None => None,
                    Some(Value::Null) => Some(None),
                    Some(value) => match anchor(value) {
                        Ok(anchor) => Some(Some(anchor)),
                        Err(error) => return Ok(ToolResult::error(error)),
                    },
                };
                let changes = Changes {
                    what: args.get("what").and_then(Value::as_str),
                    why: args.get("why").and_then(Value::as_str),
                    next_check: args.get("next_check").map(|value| value.as_str()),
                    anchor,
                };
                let updated = loops::update(&app.db.lock(), &id, &changes, now);
                match updated {
                    Ok(open_loop) => {
                        loops::changed(app, &open_loop);
                        Ok(ToolResult::text(format!("Updated {}", summary(&open_loop))))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
            Kind::Reopen => {
                let id = text("id")?;
                let reopened = loops::reopen(&app.db.lock(), &id, now);
                match reopened {
                    Ok((open_loop, true)) => Ok(ToolResult::text(format!(
                        "[{}] is open already.",
                        open_loop.id
                    ))),
                    Ok((open_loop, false)) => {
                        loops::say(app, &memory.room_id, &open_loop, Event::Reopened);
                        app.memory_changed(&open_loop.user);
                        Ok(ToolResult::text(format!(
                            "Reopened {}",
                            summary(&open_loop)
                        )))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
        }
    }
}

/// `[id] what (from origin; anchor)` for the model.
fn summary(open_loop: &OpenLoop) -> String {
    let mut text = format!(
        "[{}] {} (from {}",
        open_loop.id, open_loop.what, open_loop.origin
    );
    if let Some(anchor) = &open_loop.anchor {
        let described = loops::describe_anchor(anchor, open_loop.due_at);
        if !described.is_empty() {
            text.push_str(&format!("; {described}"));
        }
    }
    text.push(')');
    text
}

impl Tool for LoopTool {
    fn name(&self) -> &str {
        match self.kind {
            Kind::Open => "open_loop",
            Kind::Close => "close_loop",
            Kind::Touch => "touch_loop",
            Kind::Update => "update_loop",
            Kind::Reopen => "reopen_loop",
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
