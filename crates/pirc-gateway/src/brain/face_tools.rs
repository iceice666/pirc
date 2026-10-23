//! The brain's tools for faces (plans/rewrite/10-faces.md):
//!
//! - `speak_as`: what it says from now on in the turn is that face's (the
//!   host hands something over, the project's face reports back).
//! - `topic`: what the turn is about, and what it touches; the guards for
//!   suggesting a move count it ([`super::moving`]).
//! - `create_face`: someone asked for a face for a project, or agreed to
//!   the one it suggested (it suggests in words; it makes none unasked).
//! - `update_face`: someone wants a face changed: its name, bio, tone,
//!   role, its territory, or archived and back.
//! - `move_room`: someone agreed to continue elsewhere.
//! - `create_room`: someone asked for a room.
//! - `archive_room`: someone wants a room out of the way, or back. It
//!   deletes nothing, and it never archives the room it is answering in
//!   (the answer would have nowhere to go).
//!
//! The ones that act for people take the person's own words
//! (`quote`, verified in their last messages) and are not in a wake's
//! tool list (`NOT_IN_WAKES`), nor is `topic` (a wake has no messages).

use std::rc::{Rc, Weak};

use pirc_agent::LocalBoxFuture;
use pirc_agent::agent::Agent;
use pirc_agent::feature::Feature;
use pirc_agent::tools::{Tool, ToolContext, ToolResult};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::faces::{self, Face, FacePatch, NewFace, Territory};
use super::memory::{RoomMemory, object, quoted};
use super::moving::{self, Topic};
use super::turn::{Progress, post_line};
use crate::db::Store as _;
use crate::db::rooms::{Room, RoomPatch, RoomStore, room_name};
use crate::error::{ApiError, ApiResult};

/// The feature that gives a room's agent the face and room tools.
pub struct FacesFeature {
    pub memory: Rc<RoomMemory>,
    pub progress: Rc<Progress>,
}

impl Feature for FacesFeature {
    fn name(&self) -> &'static str {
        "brain-faces"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        [
            Which::SpeakAs,
            Which::Topic,
            Which::Create,
            Which::Update,
            Which::Move,
            Which::CreateRoom,
            Which::ArchiveRoom,
        ]
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
    Update,
    Move,
    CreateRoom,
    ArchiveRoom,
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
                "Make a face for a project, when someone asks for one (\"make SlimeOS a lead\") or agrees to the one you suggested: a name, \
                 who it is, how it talks, what it does, the workspaces it is about, and the room it answers in (an existing one, or a new one \
                 by name). The room is shown a line about it; people can change it on its page. Suggest a face in words first and make one \
                 only once someone agrees: never unasked, and never just because you noticed something on your own.",
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
            Which::Update => (
                "Change a face people already have (\"make PM terser\", \"PM should look after the garden too\", \"bring PM back\"): its name, \
                 who it is, how it talks, what it does, the rooms it answers in, the workspaces and sources it is about, or archived and back. \
                 Only the fields given change, and a list replaces the whole list. The same rules as its page apply: a room another face has, \
                 #general, an unknown workspace or source and a name taken are refused. A line in the room says when its rooms change.",
                object(
                    json!({
                        "face": { "type": "string", "description": "The face's id or name." },
                        "name": { "type": "string", "description": "Its new name, without @ or #." },
                        "bio": { "type": "string", "description": "Who it is, one or two sentences." },
                        "tone": { "type": "string", "description": "How it talks." },
                        "role": { "type": "string", "description": "What it does: its instructions, in Markdown." },
                        "rooms": { "type": "array", "items": { "type": "string" }, "description": "Every room it answers in (ids or #names); replaces the list." },
                        "workspaces": { "type": "array", "items": { "type": "string" }, "description": "Every workspace id (node:ws) it is about; replaces the list." },
                        "sources": { "type": "array", "items": { "type": "string" }, "description": "Every source id it watches; replaces the list." },
                        "archived": { "type": "boolean", "description": "true takes it out of the rooms, false brings it back; it keeps everything." },
                        "quote": quote_schema("a change to a face"),
                    }),
                    &["face", "quote"],
                ),
            ),
            Which::CreateRoom => (
                "Make a room, when someone asks for one (\"let's have a room for the garden\"): its name, without #. \
                 Everyone in the household shares it, and the room you are in is shown a line about it. Nothing is deleted when a room \
                 is archived, and an archived one can be brought back.",
                object(
                    json!({
                        "name": { "type": "string", "description": "The room's name, without #." },
                        "quote": quote_schema("a room"),
                    }),
                    &["name", "quote"],
                ),
            ),
            Which::ArchiveRoom => (
                "Archive a room, or bring one back, when someone asks (\"close the old garden room\", \"bring #garden back\"): it leaves \
                 the room list and takes no messages while archived, and nothing is deleted, neither its messages nor anything else. \
                 Bring it back with 'archived: false'. #general is never archived, and neither is the room you are answering in: say so \
                 and let them archive that one from the room's menu.",
                object(
                    json!({
                        "room": { "type": "string", "description": "The room's id or #name." },
                        "archived": { "type": "boolean", "description": "true (the default) archives it, false brings it back." },
                        "quote": quote_schema("archiving a room"),
                    }),
                    &["room", "quote"],
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
            Which::Update => {
                let (wanted, quote) = match (required("face"), required("quote")) {
                    (Ok(wanted), Ok(quote)) => (wanted, quote),
                    (Err(error), _) | (_, Err(error)) => return Ok(ToolResult::error(error)),
                };
                if let Err(refused) = self.quoted_by(&agent, &quote) {
                    return Ok(ToolResult::error(refused));
                }
                let (rooms, workspaces, sources) = match (
                    ids(args, "rooms"),
                    ids(args, "workspaces"),
                    ids(args, "sources"),
                ) {
                    (Ok(rooms), Ok(workspaces), Ok(sources)) => (rooms, workspaces, sources),
                    (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
                        return Ok(ToolResult::error(error));
                    }
                };
                let archived = match args.get("archived") {
                    None => None,
                    Some(Value::Bool(archived)) => Some(*archived),
                    Some(_) => return Ok(ToolResult::error("`archived` is true or false")),
                };
                let named = ["name", "bio", "tone", "role"]
                    .iter()
                    .any(|key| text(key).is_some());
                if !named
                    && rooms.is_none()
                    && workspaces.is_none()
                    && sources.is_none()
                    && archived.is_none()
                {
                    return Ok(ToolResult::error(
                        "Nothing to change: say what about the face should change",
                    ));
                }
                let changed = (|| -> ApiResult<(Face, Vec<&'static str>)> {
                    let conn = app.db.lock();
                    let Some(face) = find_any(&conn, &wanted)? else {
                        return Err(ApiError::not_found(format!("No face {}", wanted.trim())));
                    };
                    let mut patch = FacePatch::default();
                    let mut changed: Vec<&'static str> = Vec::new();
                    if let Some(name) = text("name")
                        && name != face.name
                    {
                        patch.name = Some(name);
                        changed.push("name");
                    }
                    if let Some(bio) = text("bio")
                        && bio != face.bio
                    {
                        patch.bio = Some(bio);
                        changed.push("bio");
                    }
                    if let Some(tone) = text("tone")
                        && tone != face.tone
                    {
                        patch.tone = Some(tone);
                        changed.push("tone");
                    }
                    if let Some(role) = text("role")
                        && role != face.role_md
                    {
                        patch.role_md = Some(role);
                        changed.push("role");
                    }
                    if rooms.is_some() || workspaces.is_some() || sources.is_some() {
                        let territory = Territory {
                            rooms: rooms
                                .clone()
                                .unwrap_or_else(|| face.territory.rooms.clone()),
                            workspaces: workspaces
                                .clone()
                                .unwrap_or_else(|| face.territory.workspaces.clone()),
                            sources: sources
                                .clone()
                                .unwrap_or_else(|| face.territory.sources.clone()),
                        };
                        if territory != face.territory {
                            patch.territory = Some(territory);
                            changed.push("territory");
                        }
                    }
                    if let Some(archived) = archived
                        && archived == face.active()
                    {
                        patch.archived = Some(archived);
                        changed.push(if archived { "archive" } else { "unarchive" });
                    }
                    if changed.is_empty() {
                        return Ok((face, changed));
                    }
                    Ok((faces::update(&conn, &face.id, &patch)?, changed))
                })();
                let (face, changed) = match changed {
                    Ok(done) => done,
                    Err(error) => return Ok(ToolResult::error(error.message)),
                };
                if changed.is_empty() {
                    return Ok(ToolResult::text(format!(
                        "{} is like that already; nothing changed.",
                        face.name
                    )));
                }
                faces::changed(app, &face);
                // What people see in the room list changed: say so. A tone
                // or a role is only in the reply.
                if changed.contains(&"archive")
                    || changed.contains(&"unarchive")
                    || changed.contains(&"territory")
                {
                    let line = face_line(&app.db.lock(), &face, &changed);
                    post_line(app, &memory.room_id, &line);
                }
                let words: Vec<&str> = changed
                    .iter()
                    .map(|field| match *field {
                        "archive" => "archived",
                        "unarchive" => "brought back",
                        other => other,
                    })
                    .collect();
                Ok(ToolResult::text(format!(
                    "Changed {} ({}): {}.",
                    face.name,
                    face.id,
                    words.join(", ")
                )))
            }
            Which::CreateRoom => {
                let (name, quote) = match (required("name"), required("quote")) {
                    (Ok(name), Ok(quote)) => (name, quote),
                    (Err(error), _) | (_, Err(error)) => return Ok(ToolResult::error(error)),
                };
                if let Err(refused) = self.quoted_by(&agent, &quote) {
                    return Ok(ToolResult::error(refused));
                }
                let made = (|| -> ApiResult<Room> {
                    let conn = app.db.lock();
                    let name = room_name(&name)?;
                    let taken: Option<(String, Option<i64>)> = conn
                        .query_row(
                            "SELECT id, archived_at FROM rooms WHERE lower(name)=?",
                            [name.to_lowercase()],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()?;
                    if let Some((id, archived)) = taken {
                        return Err(ApiError::new(
                            409,
                            "conflict",
                            match archived {
                                Some(_) => format!(
                                    "There is a room called #{name} already ({id}), archived: bring it back with archive_room instead",
                                ),
                                None => format!(
                                    "There is a room called #{name} already ({id}): use that one",
                                ),
                            },
                        ));
                    }
                    conn.create_room(&name)
                })();
                match made {
                    Ok(room) => {
                        app.room_changed(&room);
                        post_line(
                            app,
                            &memory.room_id,
                            &format!("Made #{} ({})", room.name, room.id),
                        );
                        Ok(ToolResult::text(format!(
                            "Made #{} ({}): it is in the room list, and everyone here can write in it.",
                            room.name, room.id
                        )))
                    }
                    Err(error) => Ok(ToolResult::error(error.message)),
                }
            }
            Which::ArchiveRoom => {
                let (wanted, quote) = match (required("room"), required("quote")) {
                    (Ok(wanted), Ok(quote)) => (wanted, quote),
                    (Err(error), _) | (_, Err(error)) => return Ok(ToolResult::error(error)),
                };
                if let Err(refused) = self.quoted_by(&agent, &quote) {
                    return Ok(ToolResult::error(refused));
                }
                let archived = match args.get("archived") {
                    None => true,
                    Some(Value::Bool(archived)) => *archived,
                    Some(_) => return Ok(ToolResult::error("`archived` is true or false")),
                };
                let done = (|| -> ApiResult<(Room, bool)> {
                    let conn = app.db.lock();
                    let room = find_any_room(&conn, &wanted, archived)?;
                    if room.kind == "general" {
                        return Err(ApiError::new(
                            409,
                            "conflict",
                            if archived {
                                "#general is never archived"
                            } else {
                                "#general is never archived, so there is nothing to bring back"
                            },
                        ));
                    }
                    // The reply to this turn is written in this room: it
                    // would have nowhere to go, and neither would the
                    // people's answer.
                    if archived && room.id == memory.room_id {
                        return Err(ApiError::new(
                            409,
                            "conflict",
                            format!(
                                "This is #{} itself: archiving it now would leave your answer with nowhere to go. Say why it should go, and let them archive it from the room's menu, or do it from another room.",
                                room.name
                            ),
                        ));
                    }
                    if room.archived_at.is_some() == archived {
                        return Ok((room, false));
                    }
                    let room = conn.update_room(
                        &room.id,
                        &RoomPatch {
                            archived: Some(archived),
                            ..Default::default()
                        },
                    )?;
                    Ok((room, true))
                })();
                let (room, changed) = match done {
                    Ok(done) => done,
                    Err(error) => return Ok(ToolResult::error(error.message)),
                };
                if !changed {
                    return Ok(ToolResult::text(if archived {
                        format!("#{} ({}) is archived already.", room.name, room.id)
                    } else {
                        format!("#{} ({}) is open already.", room.name, room.id)
                    }));
                }
                app.room_changed(&room);
                if archived {
                    post_line(app, &memory.room_id, &format!("Archived #{}", room.name));
                    Ok(ToolResult::text(format!(
                        "Archived #{} ({}). Nothing is deleted: its {} messages stay, and archive_room with archived: false brings it back.",
                        room.name, room.id, room.last_seq
                    )))
                } else {
                    post_line(
                        app,
                        &memory.room_id,
                        &format!("Brought #{} back", room.name),
                    );
                    // What waited while it was archived.
                    crate::brain::Brain::nudge(app);
                    Ok(ToolResult::text(format!(
                        "Brought #{} ({}) back: it takes messages again.",
                        room.name, room.id
                    )))
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

/// The line that says a face changed in a way people see: its rooms, or
/// whether it answers at all.
fn face_line(conn: &Connection, face: &Face, changed: &[&'static str]) -> String {
    if changed.contains(&"archive") {
        return format!(
            "{} is archived: its rooms answer as the host until it is back.",
            face.name
        );
    }
    if changed.contains(&"unarchive") {
        return format!("{} is back.", face.name);
    }
    let rooms: Vec<String> = face
        .territory
        .rooms
        .iter()
        .filter_map(|id| conn.get_room(id).ok())
        .map(|room| format!("#{}", room.name))
        .collect();
    if rooms.is_empty() {
        format!("{} answers only when named with @ now.", face.name)
    } else {
        format!("{} answers in {} now.", face.name, rooms.join(", "))
    }
}

/// A list argument (`rooms`, `workspaces`, `sources`): absent, or ids that
/// are not empty, deduped.
fn ids(args: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    let Value::Array(items) = value else {
        return Err(format!("`{key}` is a list of ids"));
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(id) = item.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
            return Err(format!("`{key}` is a list of ids"));
        };
        if !out.iter().any(|known| known == id) {
            out.push(id.to_owned());
        }
    }
    Ok(Some(out))
}

/// A face by id or `@name`, archived ones too: one can be brought back.
fn find_any(conn: &Connection, wanted: &str) -> ApiResult<Option<Face>> {
    let wanted = wanted.trim();
    let wanted = wanted.strip_prefix('@').unwrap_or(wanted).trim();
    match faces::get(conn, wanted) {
        Ok(face) => return Ok(Some(face)),
        Err(error) if error.status == 404 => {}
        Err(error) => return Err(error),
    }
    let lower = wanted.to_lowercase();
    Ok(faces::list(conn, true)?
        .into_iter()
        .find(|face| face.name.to_lowercase() == lower))
}

/// A room by id or `#name`, archived ones too; archiving looks among the
/// open rooms first, bringing back among the archived (names are no room's
/// alone).
fn find_any_room(conn: &Connection, wanted: &str, archiving: bool) -> ApiResult<Room> {
    let wanted = wanted.trim();
    match conn.get_room(wanted) {
        Ok(room) => return Ok(room),
        Err(error) if error.status == 404 => {}
        Err(error) => return Err(error),
    }
    let name = wanted.strip_prefix('#').unwrap_or(wanted).to_lowercase();
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM rooms WHERE lower(name)=?1 ORDER BY (archived_at IS NULL) = ?2 DESC, created_at DESC LIMIT 1",
            params![name, archiving],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => conn.get_room(&id),
        None => Err(ApiError::not_found(format!("No room {wanted}"))),
    }
}

impl Tool for FaceTool {
    fn name(&self) -> &str {
        match self.which {
            Which::SpeakAs => "speak_as",
            Which::Topic => "topic",
            Which::Create => "create_face",
            Which::Update => "update_face",
            Which::Move => "move_room",
            Which::CreateRoom => "create_room",
            Which::ArchiveRoom => "archive_room",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn a_room_is_found_by_name_open_or_archived() {
        let db = Db::memory();
        let conn = db.lock();
        let open = conn.create_room("garden").unwrap();
        conn.update_room(
            &open.id,
            &RoomPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        // Names are no room's alone: archiving looks among the open ones,
        // bringing back among the archived.
        let again = conn.create_room("garden").unwrap();
        assert_eq!(find_any_room(&conn, "#garden", true).unwrap().id, again.id);
        assert_eq!(find_any_room(&conn, "#Garden", false).unwrap().id, open.id);
        // By id either way, and #general is found like any room.
        assert_eq!(find_any_room(&conn, &open.id, true).unwrap().id, open.id);
        assert_eq!(
            find_any_room(&conn, "#general", false).unwrap().kind,
            "general"
        );
        let missing = find_any_room(&conn, "#nowhere", true).unwrap_err();
        assert_eq!(
            (missing.status, missing.message.as_str()),
            (404, "No room #nowhere")
        );
    }

    #[test]
    fn a_face_is_found_by_name_archived_too() {
        let db = Db::memory();
        let conn = db.lock();
        let face = faces::create(
            &conn,
            &NewFace {
                name: "PM".into(),
                ..Default::default()
            },
        )
        .unwrap();
        faces::update(
            &conn,
            &face.id,
            &FacePatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            faces::find(&conn, "PM").unwrap().is_none(),
            "an archived face answers nowhere"
        );
        assert_eq!(find_any(&conn, "@pm").unwrap().unwrap().id, face.id);
        assert_eq!(find_any(&conn, &face.id).unwrap().unwrap().id, face.id);
        assert_eq!(find_any(&conn, "host").unwrap().unwrap().name, "pirc");
        assert!(find_any(&conn, "Nope").unwrap().is_none());
    }

    #[test]
    fn list_arguments_are_ids() {
        let mut args = Map::new();
        assert_eq!(ids(&args, "rooms"), Ok(None));
        args.insert("rooms".into(), json!(["a", " a ", "b"]));
        assert_eq!(
            ids(&args, "rooms"),
            Ok(Some(vec!["a".to_owned(), "b".to_owned()]))
        );
        args.insert("rooms".into(), json!([]));
        assert_eq!(ids(&args, "rooms"), Ok(Some(Vec::new())));
        args.insert("rooms".into(), json!("a"));
        assert!(ids(&args, "rooms").is_err());
        args.insert("rooms".into(), json!(["a", 1]));
        assert!(ids(&args, "rooms").is_err());
    }
}
