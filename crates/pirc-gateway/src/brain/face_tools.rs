//! The brain's tools for faces (plans/rewrite/10-faces.md):
//!
//! - `speak_as`: what it says from now on in the turn is that face's (the
//!   host hands something over, the project's face reports back).
//! - `topic`: what the turn is about, and what it touches; the guards for
//!   suggesting a move count it ([`super::moving`]).
//! - `create_face`: someone asked for a face for a project.
//! - `move_room`: someone agreed to continue elsewhere.
//!
//! The last two act for people, so they take the person's own words
//! (`quote`, verified in their last messages) and are not in a wake's
//! tool list (`NOT_IN_WAKES`), nor is `topic` (a wake has no messages).

use std::rc::{Rc, Weak};

use pirc_agent::LocalBoxFuture;
use pirc_agent::agent::Agent;
use pirc_agent::feature::Feature;
use pirc_agent::tools::{Tool, ToolContext, ToolResult};
use serde_json::{Map, Value, json};

use super::faces::{self, Face, NewFace, Territory};
use super::memory::{RoomMemory, object, quoted};
use super::moving::{self, Topic};
use super::turn::{Progress, post_line};
use crate::db::Store as _;
use crate::db::rooms::RoomStore;

/// The feature that gives a room's agent the face tools.
pub struct FacesFeature {
    pub memory: Rc<RoomMemory>,
    pub progress: Rc<Progress>,
}

impl Feature for FacesFeature {
    fn name(&self) -> &'static str {
        "brain-faces"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        [Which::SpeakAs, Which::Topic, Which::Create, Which::Move]
            .into_iter()
            .map(|which| {
                Rc::new(FaceTool::new(
                    which,
                    self.memory.clone(),
                    self.progress.clone(),
                    Rc::downgrade(agent),
                )) as Rc<dyn Tool>
            })
            .collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Which {
    SpeakAs,
    Topic,
    Create,
    Move,
}

struct FaceTool {
    which: Which,
    memory: Rc<RoomMemory>,
    progress: Rc<Progress>,
    agent: Weak<Agent>,
    description: String,
    parameters: Map<String, Value>,
}

fn quote_schema(what: &str) -> Value {
    json!({ "type": "string", "description": format!("The person's own words asking for it ({what}), as they wrote them.") })
}

impl FaceTool {
    fn new(
        which: Which,
        memory: Rc<RoomMemory>,
        progress: Rc<Progress>,
        agent: Weak<Agent>,
    ) -> Self {
        let (description, parameters) = match which {
            Which::SpeakAs => (
                "Speak as another face from now on in this turn: what you write next is shown as that face's. \
                 Use it to hand something over and report back (the host says it asks the project's face, then the project's face answers), \
                 never to have faces talk with each other.",
                object(
                    json!({ "face": { "type": "string", "description": "The face's id or name." } }),
                    &["face"],
                ),
            ),
            Which::Topic => (
                "Say what this conversation is about, in a few words (\"slimeos pr review\", \"hw3\"), once a turn when it is clear; \
                 keep the same name while the topic stays the same. When it is about a workspace or a source, name it too.",
                object(
                    json!({
                        "name": { "type": "string", "description": "The topic, a few words." },
                        "workspace": { "type": "string", "description": "The workspace id (node:ws) it is about, if any." },
                        "source": { "type": "string", "description": "The source id it is about, if any." },
                    }),
                    &["name"],
                ),
            ),
            Which::Create => (
                "Make a face for a project, when someone asks for one (\"make SlimeOS a lead\"): a name, who it is, how it talks, \
                 what it does, the workspaces it is about, and the room it answers in (an existing one, or a new one by name). \
                 The room is shown a line about it; people can change it on its page.",
                object(
                    json!({
                        "name": { "type": "string", "description": "Its name, without @ or #." },
                        "bio": { "type": "string", "description": "Who it is, one or two sentences." },
                        "tone": { "type": "string", "description": "How it talks." },
                        "role": { "type": "string", "description": "What it does: its instructions, in Markdown." },
                        "workspaces": { "type": "array", "items": { "type": "string" }, "description": "Workspace ids (node:ws) it is about." },
                        "room": { "type": "string", "description": "An existing room (id or #name) it answers in." },
                        "new_room": { "type": "string", "description": "Or the name of a new room for it." },
                        "quote": quote_schema("a face"),
                    }),
                    &["name", "quote"],
                ),
            ),
            Which::Move => (
                "Continue this conversation in another room, once someone agreed to (\"ok, let's go there\"). \
                 Both rooms are shown a line, and the open loops of the conversation go along.",
                object(
                    json!({
                        "to": { "type": "string", "description": "The room's id or #name." },
                        "quote": quote_schema("agreeing to move"),
                    }),
                    &["to", "quote"],
                ),
            ),
        };
        Self {
            which,
            memory,
            progress,
            agent,
            description: description.to_owned(),
            parameters,
        }
    }

    /// Who said `quote` among the household, or what to tell the model.
    fn quoted_by(&self, agent: &Agent, quote: &str) -> Result<String, &'static str> {
        let mut people: Vec<String> = self
            .memory
            .app
            .config
            .auth
            .allowed_users
            .iter()
            .cloned()
            .collect();
        people.sort();
        quoted(&agent.branch(), quote, &people)
            .map(|(who, _)| who)
            .ok_or(
                "That quote is not in what anyone here said in their last messages; ask them first",
            )
    }

    fn run(&self, args: &Map<String, Value>) -> Result<ToolResult, String> {
        let Some(agent) = self.agent.upgrade() else {
            return Err("The room's conversation is closed".to_owned());
        };
        let text = |key: &str| -> Option<String> {
            args.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let required = |key: &str| text(key).ok_or_else(|| format!("`{key}` is required"));
        let memory = &self.memory;
        let app = &memory.app;
        match self.which {
            Which::SpeakAs => {
                let wanted = match required("face") {
                    Ok(wanted) => wanted,
                    Err(error) => return Ok(ToolResult::error(error)),
                };
                let found = faces::find(&app.db.lock(), &wanted);
                let face = match found {
                    Ok(Some(face)) => face,
                    Ok(None) => {
                        return Ok(ToolResult::error(format!("No face {wanted} answers now")));
                    }
                    Err(error) => return Ok(ToolResult::error(error.message)),
                };
                if memory.face() == face.id {
                    return Ok(ToolResult::text(format!(
                        "You already speak as {}.",
                        face.name
                    )));
                }
                memory.set_face(&face.id);
                // A wake thinks where nobody sees it.
                if self.progress.wake.borrow().is_none() {
                    super::presence(app, &memory.room_id, Some(&face.id));
                }
                Ok(ToolResult::text(format!(
                    "You speak as {} now: what you write next is theirs.",
                    face.name
                )))
            }
            Which::Topic => {
                let name = match required("name").and_then(|name| moving::topic_name(&name)) {
                    Ok(name) => name,
                    Err(error) => return Ok(ToolResult::error(error)),
                };
                let workspace_id = text("workspace");
                let source_id = text("source");
                {
                    let conn = app.db.lock();
                    if let Some(id) = &workspace_id
                        && !matches!(conn.find_workspace(id), Ok(Some(_)))
                    {
                        return Ok(ToolResult::error(format!("No workspace {id}")));
                    }
                    if let Some(id) = &source_id {
                        let known = conn
                            .query_row("SELECT 1 FROM sources WHERE id=?", [id], |_| Ok(()))
                            .is_ok();
                        if !known {
                            return Ok(ToolResult::error(format!("No source {id}")));
                        }
                    }
                }
                memory.set_topic(Topic {
                    name: name.clone(),
                    workspace_id,
                    source_id,
                });
                Ok(ToolResult::text(format!(
                    "Noted: this is about \"{name}\"."
                )))
            }
            Which::Create => {
                let (name, quote) = match (required("name"), required("quote")) {
                    (Ok(name), Ok(quote)) => (name, quote),
                    (Err(error), _) | (_, Err(error)) => return Ok(ToolResult::error(error)),
                };
                if let Err(refused) = self.quoted_by(&agent, &quote) {
                    return Ok(ToolResult::error(refused));
                }
                let workspaces: Vec<String> = args
                    .get("workspaces")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                let made = {
                    let conn = app.db.lock();
                    crate::db::atomic(&conn, |tx| {
                        let room = match (text("room"), text("new_room")) {
                            (Some(room), _) => Some(moving::find_room(tx, &room)?),
                            (None, Some(name)) => Some(tx.create_room(&name)?),
                            (None, None) => None,
                        };
                        let face = faces::create(
                            tx,
                            &NewFace {
                                name,
                                bio: text("bio").unwrap_or_default(),
                                tone: text("tone").unwrap_or_default(),
                                role_md: text("role").unwrap_or_default(),
                                territory: Territory {
                                    rooms: room.iter().map(|room| room.id.clone()).collect(),
                                    workspaces,
                                    sources: Vec::new(),
                                },
                                ..Default::default()
                            },
                        )?;
                        Ok((face, room))
                    })
                };
                match made {
                    Ok((face, room)) => {
                        faces::changed(app, &face);
                        if let Some(room) = &room {
                            app.room_changed(room);
                        }
                        post_line(
                            app,
                            &memory.room_id,
                            &joined(&face, room.as_ref().map(|room| room.name.as_str())),
                        );
                        Ok(ToolResult::text(format!(
                            "Made {} ({}){}.",
                            face.name,
                            face.id,
                            room.map(|room| format!(", answering in #{} ({})", room.name, room.id))
                                .unwrap_or_default()
                        )))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
            Which::Move => {
                let (to, quote) = match (required("to"), required("quote")) {
                    (Ok(to), Ok(quote)) => (to, quote),
                    (Err(error), _) | (_, Err(error)) => return Ok(ToolResult::error(error)),
                };
                if let Err(refused) = self.quoted_by(&agent, &quote) {
                    return Ok(ToolResult::error(refused));
                }
                let current_topic = memory.current_topic();
                let done = {
                    let conn = app.db.lock();
                    moving::find_room(&conn, &to).and_then(|target| {
                        let topic = match current_topic {
                            Some(name) => Some(name),
                            None => moving::last_suggested(&conn, &memory.room_id)?,
                        };
                        moving::move_room(&conn, &memory.room_id, &target.id, topic.as_deref())
                    })
                };
                match done {
                    Ok(done) => {
                        moving::moved(app, &done);
                        Ok(ToolResult::text(format!(
                            "Moved: the conversation continues in #{}{}.",
                            done.moved.to.name,
                            match done.loops.len() {
                                0 => String::new(),
                                1 => ", with its open loop".to_owned(),
                                n => format!(", with its {n} open loops"),
                            }
                        )))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
        }
    }
}

/// The line that says a face was made.
fn joined(face: &Face, room: Option<&str>) -> String {
    match room {
        Some(room) => format!("{} is here now, answering in #{room}.", face.name),
        None => format!("{} is here now.", face.name),
    }
}

impl Tool for FaceTool {
    fn name(&self) -> &str {
        match self.which {
            Which::SpeakAs => "speak_as",
            Which::Topic => "topic",
            Which::Create => "create_face",
            Which::Move => "move_room",
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
        Box::pin(async move { self.run(&args) })
    }
}
