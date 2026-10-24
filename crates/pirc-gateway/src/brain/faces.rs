//! Faces (plans/rewrite/10-faces.md): the names one brain speaks through.
//! A face has no memory, loops or red lines of its own (direction §2.8):
//! it is a name, a voice, a role and a territory, and every message says
//! which face spoke.
//!
//! - The host (`is_host`) always exists, answers in `#general` and in every
//!   room nobody else has, and is never archived.
//! - A project's face has rooms it answers in, the workspaces it is about
//!   (`project_links`) and the sources it watches. A room belongs to one
//!   face at most.
//! - An archived face stays listed, greyed out, until someone hides it
//!   (decision #18); it answers nowhere and nobody can `@` it.
//!
//! Who answers is code's to say before a turn ([`route`], decision #9): the
//! faces `@`-named in the batch, else the face that spoke last in the room,
//! else the room's own face, else the host. The brain may switch within the
//! turn (`speak_as`), so the host can hand something over and the project's
//! face report back.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::app::App;
use crate::db::Store as _;
use crate::db::atomic;
use crate::db::rooms::{GENERAL_ROOM_ID, HOST_FACE_ID, RoomStore};
use crate::error::{ApiError, ApiResult};
use crate::util::{new_id, now_ms, safe_json};

/// Characters in a face's name.
pub const MAX_NAME_CHARS: usize = 40;
const MAX_BIO_CHARS: usize = 500;
const MAX_TONE_CHARS: usize = 300;
const MAX_AVATAR_CHARS: usize = 16;
/// Rooms, workspaces and sources in one territory, each.
const MAX_TERRITORY: usize = 50;
/// How far back "the face that spoke last" looks, in messages.
const LAST_SPEAKER_WINDOW: i64 = 20;

/// What a face looks after.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Territory {
    /// Rooms it answers in.
    #[serde(default)]
    pub rooms: Vec<String>,
    /// Directory workspaces (`node:ws`) it is about: its `project_links`.
    #[serde(default)]
    pub workspaces: Vec<String>,
    /// Sources it watches.
    #[serde(default)]
    pub sources: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub id: String,
    pub name: String,
    pub bio: String,
    pub tone: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub role_md: String,
    pub territory: Territory,
    pub is_host: bool,
    pub created_at: i64,
    pub archived_at: Option<i64>,
    pub hidden_at: Option<i64>,
}

impl Face {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let stored = safe_json(&row.get::<_, String>("territory_json")?, json!({}));
        let list = |key: &str| -> Vec<String> {
            stored
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            bio: row.get("bio")?,
            tone: row.get("tone")?,
            avatar: row.get("avatar")?,
            color: row.get("color")?,
            role_md: row.get("role_md")?,
            territory: Territory {
                rooms: list("rooms"),
                workspaces: Vec::new(),
                sources: list("sources"),
            },
            is_host: row.get::<_, i64>("is_host")? != 0,
            created_at: row.get("created_at")?,
            archived_at: row.get("archived_at")?,
            hidden_at: row.get("hidden_at")?,
        })
    }

    /// Answers, can be `@`-named and spoken as.
    pub fn active(&self) -> bool {
        self.archived_at.is_none()
    }
}

fn with_links(conn: &Connection, mut face: Face) -> ApiResult<Face> {
    face.territory.workspaces = crate::project_links::links(conn, &face.id)?
        .into_iter()
        .map(|link| link.workspace_id)
        .collect();
    Ok(face)
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "invalid_input", message)
}

fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(409, "conflict", message)
}

/// Every face: the host first, then the others as they were made, the
/// archived ones last; hidden ones only when asked for.
pub fn list(conn: &Connection, hidden: bool) -> ApiResult<Vec<Face>> {
    let filter = if hidden {
        ""
    } else {
        " WHERE hidden_at IS NULL"
    };
    let mut statement = conn.prepare(&format!(
        "SELECT * FROM faces{filter} ORDER BY is_host DESC, archived_at IS NOT NULL, created_at, rowid"
    ))?;
    let rows = statement.query_map([], Face::from_row)?;
    let faces: Vec<Face> = rows.collect::<Result<_, _>>()?;
    faces
        .into_iter()
        .map(|face| with_links(conn, face))
        .collect()
}

/// The faces that answer.
pub fn active(conn: &Connection) -> ApiResult<Vec<Face>> {
    Ok(list(conn, false)?
        .into_iter()
        .filter(Face::active)
        .collect())
}

/// 404 "No face …".
pub fn get(conn: &Connection, id: &str) -> ApiResult<Face> {
    let face = conn
        .query_row("SELECT * FROM faces WHERE id=?", [id], Face::from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found(format!("No face {id}")))?;
    with_links(conn, face)
}

pub fn host(conn: &Connection) -> ApiResult<Face> {
    get(conn, HOST_FACE_ID)
}

/// An active face by id or name (any case, with or without `@`).
pub fn find(conn: &Connection, wanted: &str) -> ApiResult<Option<Face>> {
    let wanted = wanted.trim();
    let wanted = wanted.strip_prefix('@').unwrap_or(wanted).trim();
    Ok(active(conn)?
        .into_iter()
        .find(|face| face.id == wanted || face.name.to_lowercase() == wanted.to_lowercase()))
}

/// A face's name as given: trimmed, 1 to [`MAX_NAME_CHARS`] characters,
/// no control characters, no `@` or `#` (mentions and room names use them).
pub fn face_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(|c| c.is_control() || c == '@' || c == '#')
    {
        return Err(invalid(format!(
            "A face's name has 1 to {MAX_NAME_CHARS} characters, without @ or #"
        )));
    }
    Ok(name.to_owned())
}

fn bounded(text: &str, max: usize, what: &str) -> ApiResult<String> {
    let text = text.trim();
    if text.encode_utf16().count() > max {
        return Err(invalid(format!("{what} holds at most {max} characters")));
    }
    Ok(text.to_owned())
}

fn color(value: &str) -> ApiResult<String> {
    let valid = value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(invalid("A color is #rrggbb"));
    }
    Ok(value.to_ascii_lowercase())
}

fn avatar(value: &str) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_AVATAR_CHARS {
        return Err(invalid(format!(
            "An avatar is 1 to {MAX_AVATAR_CHARS} characters (an emoji or initials)"
        )));
    }
    Ok(value.to_owned())
}

/// The name must be no other face's (in any case).
fn unique_name(conn: &Connection, name: &str, except: Option<&str>) -> ApiResult<()> {
    let taken = list(conn, true)?.into_iter().any(|face| {
        Some(face.id.as_str()) != except && face.name.to_lowercase() == name.to_lowercase()
    });
    if taken {
        return Err(conflict(format!("There is a face called {name} already")));
    }
    Ok(())
}

/// Check a territory for `face_id` (`None` for a new face): rooms, sources
/// and workspaces that exist, `#general` is the host's, and a room is no
/// other active face's.
fn check_territory(
    conn: &Connection,
    territory: &Territory,
    face_id: Option<&str>,
) -> ApiResult<Territory> {
    let mut out = Territory::default();
    for (items, kept, what) in [
        (&territory.rooms, &mut out.rooms, "rooms"),
        (&territory.workspaces, &mut out.workspaces, "workspaces"),
        (&territory.sources, &mut out.sources, "sources"),
    ] {
        if items.len() > MAX_TERRITORY {
            return Err(invalid(format!(
                "A territory holds at most {MAX_TERRITORY} {what}"
            )));
        }
        for item in items {
            if !kept.contains(item) {
                kept.push(item.clone());
            }
        }
    }
    let others = active(conn)?;
    for room_id in &out.rooms {
        let room = conn.get_room(room_id)?;
        if room.kind == "general" {
            return Err(conflict("#general is the host's"));
        }
        if let Some(owner) = others.iter().find(|face| {
            !face.is_host
                && Some(face.id.as_str()) != face_id
                && face.territory.rooms.contains(room_id)
        }) {
            return Err(conflict(format!(
                "#{} is {}'s already",
                room.name, owner.name
            )));
        }
    }
    for workspace_id in &out.workspaces {
        if !workspace_id.contains(':') || conn.find_workspace(workspace_id)?.is_none() {
            return Err(invalid(format!("No directory workspace {workspace_id}")));
        }
    }
    for source_id in &out.sources {
        let known: Option<String> = conn
            .query_row("SELECT id FROM sources WHERE id=?", [source_id], |row| {
                row.get(0)
            })
            .optional()?;
        if known.is_none() {
            return Err(invalid(format!("No source {source_id}")));
        }
    }
    Ok(out)
}

/// Store the rooms and sources, and make the links what `territory` says.
fn store_territory(conn: &Connection, face_id: &str, territory: &Territory) -> ApiResult<()> {
    conn.execute(
        "UPDATE faces SET territory_json=? WHERE id=?",
        params![
            json!({ "rooms": territory.rooms, "sources": territory.sources }).to_string(),
            face_id
        ],
    )?;
    let current = crate::project_links::links(conn, face_id)?;
    for link in &current {
        if !territory.workspaces.contains(&link.workspace_id) {
            conn.execute(
                "DELETE FROM project_links WHERE face_id=? AND workspace_id=?",
                [face_id, link.workspace_id.as_str()],
            )?;
        }
    }
    let stamp = now_ms();
    for workspace_id in &territory.workspaces {
        if current
            .iter()
            .any(|link| &link.workspace_id == workspace_id)
        {
            continue;
        }
        let repo = conn
            .find_workspace(workspace_id)?
            .and_then(|workspace| workspace.repo);
        conn.execute(
            "INSERT INTO project_links (face_id,workspace_id,repo,created_at) VALUES (?,?,?,?)",
            params![face_id, workspace_id, repo, stamp],
        )?;
    }
    Ok(())
}

/// A face to make.
#[derive(Clone, Debug, Default)]
pub struct NewFace {
    pub name: String,
    pub bio: String,
    pub tone: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub role_md: String,
    pub territory: Territory,
}

pub fn create(conn: &Connection, new: &NewFace) -> ApiResult<Face> {
    atomic(conn, |tx| {
        let name = face_name(&new.name)?;
        unique_name(tx, &name, None)?;
        let bio = bounded(&new.bio, MAX_BIO_CHARS, "A bio")?;
        let tone = bounded(&new.tone, MAX_TONE_CHARS, "A tone")?;
        let role = bounded(&new.role_md, super::identity::PROMPT_MAX_CHARS, "A role")?;
        let avatar = new.avatar.as_deref().map(avatar).transpose()?;
        let color = new.color.as_deref().map(color).transpose()?;
        let territory = check_territory(tx, &new.territory, None)?;
        let id = new_id("face");
        tx.execute(
            "INSERT INTO faces (id,name,bio,tone,avatar,color,role_md,created_at) VALUES (?,?,?,?,?,?,?,?)",
            params![id, name, bio, tone, avatar, color, role, now_ms()],
        )?;
        store_territory(tx, &id, &territory)?;
        get(tx, &id)
    })
}

/// A change to a face; `None` keeps a field, `Some(None)` clears one.
#[derive(Clone, Debug, Default)]
pub struct FacePatch {
    pub name: Option<String>,
    pub bio: Option<String>,
    pub tone: Option<String>,
    pub avatar: Option<Option<String>>,
    pub color: Option<Option<String>>,
    pub role_md: Option<String>,
    pub territory: Option<Territory>,
    pub archived: Option<bool>,
    pub hidden: Option<bool>,
}

pub fn update(conn: &Connection, id: &str, patch: &FacePatch) -> ApiResult<Face> {
    atomic(conn, |tx| {
        let face = get(tx, id)?;
        if let Some(name) = &patch.name {
            let name = face_name(name)?;
            unique_name(tx, &name, Some(id))?;
            tx.execute("UPDATE faces SET name=? WHERE id=?", params![name, id])?;
        }
        if let Some(bio) = &patch.bio {
            let bio = bounded(bio, MAX_BIO_CHARS, "A bio")?;
            tx.execute("UPDATE faces SET bio=? WHERE id=?", params![bio, id])?;
        }
        if let Some(tone) = &patch.tone {
            let tone = bounded(tone, MAX_TONE_CHARS, "A tone")?;
            tx.execute("UPDATE faces SET tone=? WHERE id=?", params![tone, id])?;
        }
        if let Some(role) = &patch.role_md {
            let role = bounded(role, super::identity::PROMPT_MAX_CHARS, "A role")?;
            tx.execute("UPDATE faces SET role_md=? WHERE id=?", params![role, id])?;
        }
        if let Some(value) = &patch.avatar {
            let value = value.as_deref().map(avatar).transpose()?;
            tx.execute("UPDATE faces SET avatar=? WHERE id=?", params![value, id])?;
        }
        if let Some(value) = &patch.color {
            let value = value.as_deref().map(color).transpose()?;
            tx.execute("UPDATE faces SET color=? WHERE id=?", params![value, id])?;
        }
        if let Some(territory) = &patch.territory {
            if face.is_host {
                return Err(conflict(
                    "The host answers in #general and wherever nobody else does",
                ));
            }
            let territory = check_territory(tx, territory, Some(id))?;
            store_territory(tx, id, &territory)?;
        }
        match patch.archived {
            Some(true) if face.is_host => {
                return Err(conflict("The host cannot be archived"));
            }
            Some(true) => {
                tx.execute(
                    "UPDATE faces SET archived_at=COALESCE(archived_at, ?) WHERE id=?",
                    params![now_ms(), id],
                )?;
            }
            Some(false) => {
                if face.archived_at.is_some() {
                    // Back at work: its rooms must still be its own.
                    let fresh = get(tx, id)?;
                    check_territory(tx, &fresh.territory, Some(id))?;
                }
                tx.execute(
                    "UPDATE faces SET archived_at=NULL, hidden_at=NULL WHERE id=?",
                    [id],
                )?;
            }
            None => {}
        }
        match patch.hidden {
            Some(true) => {
                let archived: Option<i64> =
                    tx.query_row("SELECT archived_at FROM faces WHERE id=?", [id], |row| {
                        row.get(0)
                    })?;
                if archived.is_none() {
                    return Err(conflict("Only an archived face can be hidden"));
                }
                tx.execute(
                    "UPDATE faces SET hidden_at=COALESCE(hidden_at, ?) WHERE id=?",
                    params![now_ms(), id],
                )?;
            }
            Some(false) => {
                tx.execute("UPDATE faces SET hidden_at=NULL WHERE id=?", [id])?;
            }
            None => {}
        }
        get(tx, id)
    })
}

// ---------- who answers ----------

/// The active face whose territory has the room (never the host's).
pub fn room_face(conn: &Connection, room_id: &str) -> ApiResult<Option<Face>> {
    Ok(active(conn)?
        .into_iter()
        .find(|face| !face.is_host && face.territory.rooms.iter().any(|room| room == room_id)))
}

/// The active face that watches a source.
pub fn source_face(conn: &Connection, source_id: &str) -> ApiResult<Option<Face>> {
    Ok(active(conn)?.into_iter().find(|face| {
        !face.is_host
            && face
                .territory
                .sources
                .iter()
                .any(|source| source == source_id)
    }))
}

/// The faces `@`-named in `text`, in the order named: `@` then a face's
/// name (any case), not inside a word (`me@pm` names nobody) and not
/// running on into one. The longest name wins (`@PM Lead` over `@PM`).
pub fn mentions(text: &str, faces: &[Face]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let lower = text.to_lowercase();
    let mut names: Vec<(String, &Face)> = faces
        .iter()
        .filter(|face| face.active())
        .map(|face| (face.name.to_lowercase(), face))
        .collect();
    names.sort_by_key(|(name, _)| std::cmp::Reverse(name.chars().count()));
    for (at, _) in lower.match_indices('@') {
        // An address (`me@pm.com`) names nobody; Chinese runs on without
        // spaces, so only Latin letters and digits make a word here.
        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        let before = lower[..at].chars().next_back();
        if before.is_some_and(|c| word(c) || c == '.') {
            continue;
        }
        let rest = &lower[at + 1..];
        let named = names.iter().find(|(name, _)| {
            rest.starts_with(name.as_str())
                && rest[name.len()..].chars().next().is_none_or(|c| !word(c))
        });
        if let Some((_, face)) = named
            && !found.contains(&face.id)
        {
            found.push(face.id.clone());
        }
    }
    found
}

/// Why a face answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    /// Named with `@`.
    Mentioned,
    /// It spoke last in the room.
    SpokeLast,
    /// The room is its.
    Room,
    /// Nobody else.
    Host,
    /// A wake wears it.
    Woke,
    /// It called the worker that reported back.
    Reported,
}

/// Who answers a turn (decision #9).
#[derive(Clone, Debug)]
pub struct Route {
    pub face: Face,
    pub why: Why,
    /// Every face named in the batch, `face` first.
    pub mentioned: Vec<Face>,
}

/// The face that spoke last among the room's latest messages (its own
/// words, not a line), if it still answers.
fn spoke_last(conn: &Connection, room_id: &str, faces: &[Face]) -> ApiResult<Option<Face>> {
    let speaker: Option<String> = conn
        .query_row(
            "SELECT speaker FROM (SELECT speaker, kind, seq FROM room_messages WHERE room_id=?1 ORDER BY seq DESC LIMIT ?2)
             WHERE kind='text' AND speaker LIKE 'face:%' ORDER BY seq DESC LIMIT 1",
            params![room_id, LAST_SPEAKER_WINDOW],
            |row| row.get(0),
        )
        .optional()?;
    Ok(speaker
        .and_then(|speaker| speaker.strip_prefix("face:").map(str::to_owned))
        .and_then(|id| faces.iter().find(|face| face.id == id).cloned()))
}

/// Who answers what people said (`text`) in a room.
pub fn route(conn: &Connection, room_id: &str, text: &str) -> ApiResult<Route> {
    let faces = active(conn)?;
    let mentioned: Vec<Face> = mentions(text, &faces)
        .into_iter()
        .filter_map(|id| faces.iter().find(|face| face.id == id).cloned())
        .collect();
    if let Some(first) = mentioned.first() {
        return Ok(Route {
            face: first.clone(),
            why: Why::Mentioned,
            mentioned,
        });
    }
    let (face, why) = if let Some(face) = spoke_last(conn, room_id, &faces)? {
        (face, Why::SpokeLast)
    } else if let Some(face) = room_face(conn, room_id)? {
        (face, Why::Room)
    } else {
        (host(conn)?, Why::Host)
    };
    Ok(Route {
        face,
        why,
        mentioned,
    })
}

/// The face a wake wears: the one it was scheduled by (a loop's face, or
/// whoever asked to come back), else for a source the face watching it,
/// else the room's, else the host.
pub fn wake_face(conn: &Connection, wake: &crate::wake::Wake) -> ApiResult<Face> {
    let faces = active(conn)?;
    if let Some(face) = wake
        .face_id
        .as_deref()
        .filter(|id| *id != HOST_FACE_ID)
        .and_then(|id| faces.iter().find(|face| face.id == id))
    {
        return Ok(face.clone());
    }
    if wake.kind == crate::wake::Kind::Source.as_str()
        && let Some(source_id) = wake.trigger.get("sourceId").and_then(Value::as_str)
        && let Some(face) = source_face(conn, source_id)?
    {
        return Ok(face);
    }
    if let Some(face) = room_face(conn, &wake.room_id)? {
        return Ok(face);
    }
    host(conn)
}

/// The face that tells a room how a worker ended: the one that called it,
/// else the room's, else the host.
pub fn report_face(conn: &Connection, face_id: &str, room_id: &str) -> ApiResult<Face> {
    let faces = active(conn)?;
    if let Some(face) = faces.iter().find(|face| face.id == face_id) {
        return Ok(face.clone());
    }
    if let Some(face) = room_face(conn, room_id)? {
        return Ok(face);
    }
    host(conn)
}

// ---------- the prompt ----------

/// How faces speak, the default the house rules (`CHAT.md`) come after.
pub const FACE_RULES: &str = "## Faces\n\n\
These are the defaults; the house rules come after them and win where they differ.\n\
- You are one mind with several faces; people see which face said each message. Memory is shared: what one face knows, all of them know.\n\
- Answer as the face you are now. When another face should answer (it is about its room, its workspaces or its sources), \
`speak_as` that face and answer; a few words of hand-over first, as the face you are, only when the change would otherwise surprise.\n\
- Faces never talk with each other: they only hand over and report back.\n\
- A face named with `@` answers for itself.\n\
- A face is made only when someone asks for one or agrees to what you suggested: when a project or a recurring topic seems to deserve \
one, say so in a sentence and ask (say that @PM could look after the SlimeOS PRs, and whether to make it), then wait; `create_face` \
only once they say yes, never unasked.\n\
- Once the topic of the conversation is clear, say it with `topic` (a few words, the same name while it stays the same), \
with the workspace or source it is about.";

fn territory_text(conn: &Connection, face: &Face) -> String {
    if face.is_host {
        return "#general, and every room no other face has".to_owned();
    }
    let mut parts = Vec::new();
    let rooms: Vec<String> = face
        .territory
        .rooms
        .iter()
        .filter_map(|id| conn.get_room(id).ok())
        .map(|room| format!("#{} ({})", room.name, room.id))
        .collect();
    if !rooms.is_empty() {
        parts.push(format!("rooms {}", rooms.join(", ")));
    }
    if !face.territory.workspaces.is_empty() {
        parts.push(format!(
            "workspaces {}",
            face.territory.workspaces.join(", ")
        ));
    }
    if !face.territory.sources.is_empty() {
        let names: Vec<String> = face
            .territory
            .sources
            .iter()
            .map(|id| {
                conn.query_row("SELECT name FROM sources WHERE id=?", [id], |row| {
                    row.get::<_, String>(0)
                })
                .map_or_else(|_| id.clone(), |name| format!("{name} ({id})"))
            })
            .collect();
        parts.push(format!("sources {}", names.join(", ")));
    }
    if parts.is_empty() {
        "nothing yet".to_owned()
    } else {
        parts.join("; ")
    }
}

/// The face sections of a turn's prompt: who the brain is now (`## You
/// are now`, with the other faces), then [`FACE_RULES`].
pub fn sections(conn: &Connection, route: &Route) -> Vec<pirc_agent::context::PromptSection> {
    let face = &route.face;
    let mut text = format!(
        "## You are now\n\nYou speak as {} (face {}){}.",
        face.name,
        face.id,
        if face.is_host { ", the host" } else { "" }
    );
    if !face.bio.is_empty() {
        text.push_str(&format!(" {}", face.bio));
    }
    if !face.tone.is_empty() {
        text.push_str(&format!("\nHow {} talks: {}", face.name, face.tone));
    }
    if !face.role_md.is_empty() {
        text.push_str(&format!("\nWhat {} does:\n{}", face.name, face.role_md));
    }
    text.push_str(&format!("\nIts territory: {}.", territory_text(conn, face)));
    text.push_str(&format!(
        "\n{}",
        match route.why {
            Why::Mentioned => "People named it with @.".to_owned(),
            Why::SpokeLast => "It spoke last here.".to_owned(),
            Why::Room => "This is its room.".to_owned(),
            Why::Host => "Nobody else answers here.".to_owned(),
            Why::Woke => "You woke up as it.".to_owned(),
            Why::Reported => "It called the worker that reported back.".to_owned(),
        }
    ));
    if route.mentioned.len() > 1 {
        let names: Vec<&str> = route
            .mentioned
            .iter()
            .map(|face| face.name.as_str())
            .collect();
        text.push_str(&format!(
            " Named together: {}; each answers its part (`speak_as`).",
            names.join(", ")
        ));
    }
    let others: Vec<Face> = active(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|other| other.id != face.id)
        .collect();
    if !others.is_empty() {
        text.push_str("\n\nThe other faces (`speak_as` takes the id):");
        for other in &others {
            let mut line = format!("\n- {} ({})", other.name, other.id);
            if other.is_host {
                line.push_str(": the host");
            }
            if !other.bio.is_empty() {
                line.push_str(&format!(": {}", crate::memory::text::clip(&other.bio, 200)));
            }
            line.push_str(&format!(" · {}", territory_text(conn, other)));
            text.push_str(&line);
        }
    }
    vec![
        pirc_agent::context::PromptSection::new("face", "You are now", "faces", text),
        pirc_agent::context::PromptSection::new(
            "face-rules",
            "Faces",
            "built-in default",
            FACE_RULES,
        ),
    ]
}

// ---------- presence ----------

/// What a face is doing now: `thinking` (a turn speaks as it), `waiting`
/// (a worker of its asks people something), `working` (it has workers at
/// it, with a line saying what) or `idle`.
pub fn state(app: &App, face_id: &str) -> Value {
    if let Some((room_id, since)) = super::thinking_as(app, face_id) {
        return json!({ "state": "thinking", "roomId": room_id, "since": since });
    }
    let workers: Vec<(String, String, String)> = {
        let conn = app.db.lock();
        let statement = conn.prepare(
            "SELECT status, title, room_id FROM delegations WHERE COALESCE(face_id, 'host')=? AND status IN ('queued','running','waiting_input') ORDER BY created_at",
        );
        match statement {
            Ok(mut statement) => statement
                .query_map([face_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    };
    if let Some((_, title, room_id)) = workers
        .iter()
        .find(|(status, _, _)| status == "waiting_input")
    {
        return json!({ "state": "waiting", "roomId": room_id, "line": format!("A worker asks about {title}") });
    }
    match workers.as_slice() {
        [] => json!({ "state": "idle" }),
        [(_, title, room_id)] => json!({ "state": "working", "roomId": room_id, "line": title }),
        [(_, title, room_id), rest @ ..] => json!({
            "state": "working",
            "roomId": room_id,
            "line": format!("{title} (+{} more)", rest.len()),
        }),
    }
}

/// A face's presence may have changed: `face_presence {faceId, …}` in the
/// room where it happened (ephemeral, like typing).
pub fn presence_changed(app: &App, face_id: &str, room_id: &str) {
    let mut data = state(app, face_id);
    data["faceId"] = json!(face_id);
    app.rooms.publish_ephemeral(room_id, "face_presence", data);
}

/// Every face's presence, for `GET /api/faces` and a room socket's `ready`.
pub fn presences(app: &App) -> Value {
    let ids: Vec<String> = active(&app.db.lock())
        .map(|faces| faces.into_iter().map(|face| face.id).collect())
        .unwrap_or_default();
    Value::Array(
        ids.iter()
            .map(|id| {
                let mut data = state(app, id);
                data["faceId"] = json!(id);
                data
            })
            .collect(),
    )
}

/// A face changed: `face_changed {face}` for everyone (carried by
/// `#general`'s stream, as faces belong to no one room).
pub fn changed(app: &App, face: &Face) {
    app.rooms.publish(
        GENERAL_ROOM_ID,
        "face_changed",
        json!({ "face": face }),
        None,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::rooms::{MessageKind, Speaker};
    use crate::db::{Db, ModeId};

    fn new(name: &str, rooms: &[&str]) -> NewFace {
        NewFace {
            name: name.into(),
            territory: Territory {
                rooms: rooms.iter().map(|room| (*room).to_owned()).collect(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn faces_are_made_named_and_archived() {
        let db = Db::memory();
        let conn = db.lock();
        let host = host(&conn).unwrap();
        assert!(host.is_host && host.active());
        let room = conn.create_room("slimeos").unwrap();
        let pm = create(&conn, &new("PM", &[&room.id])).unwrap();
        assert_eq!(pm.territory.rooms, std::slice::from_ref(&room.id));
        assert_eq!(create(&conn, &new("pm", &[])).unwrap_err().status, 409);
        assert_eq!(create(&conn, &new("@x", &[])).unwrap_err().status, 400);
        assert_eq!(
            create(&conn, &new("Other", &[&room.id]))
                .unwrap_err()
                .message,
            "#slimeos is PM's already"
        );
        assert_eq!(
            create(&conn, &new("G", &[GENERAL_ROOM_ID]))
                .unwrap_err()
                .message,
            "#general is the host's"
        );
        let patch = |patch: FacePatch, id: &str| update(&conn, id, &patch);
        assert_eq!(
            patch(
                FacePatch {
                    archived: Some(true),
                    ..Default::default()
                },
                HOST_FACE_ID
            )
            .unwrap_err()
            .status,
            409
        );
        assert_eq!(
            patch(
                FacePatch {
                    hidden: Some(true),
                    ..Default::default()
                },
                &pm.id
            )
            .unwrap_err()
            .message,
            "Only an archived face can be hidden"
        );
        let archived = patch(
            FacePatch {
                archived: Some(true),
                ..Default::default()
            },
            &pm.id,
        )
        .unwrap();
        assert!(!archived.active());
        // Its room is free again while it is archived.
        let other = create(&conn, &new("Other", &[&room.id])).unwrap();
        let hidden = patch(
            FacePatch {
                hidden: Some(true),
                ..Default::default()
            },
            &pm.id,
        )
        .unwrap();
        assert!(hidden.hidden_at.is_some());
        let names = |hidden: bool| -> Vec<String> {
            list(&conn, hidden)
                .unwrap()
                .into_iter()
                .map(|face| face.name)
                .collect()
        };
        assert_eq!(names(false), ["pirc", "Other"]);
        assert_eq!(names(true), ["pirc", "Other", "PM"]);
        // Back at work only with its rooms its own.
        assert_eq!(
            patch(
                FacePatch {
                    archived: Some(false),
                    ..Default::default()
                },
                &pm.id
            )
            .unwrap_err()
            .status,
            409
        );
        patch(
            FacePatch {
                archived: Some(true),
                ..Default::default()
            },
            &other.id,
        )
        .unwrap();
        let back = patch(
            FacePatch {
                archived: Some(false),
                ..Default::default()
            },
            &pm.id,
        )
        .unwrap();
        assert_eq!((back.archived_at, back.hidden_at), (None, None));
    }

    #[test]
    fn a_territory_links_workspaces() {
        let db = Db::memory();
        let conn = db.lock();
        conn.sync_remote_workspaces(
            "work",
            &[(
                "slime".into(),
                "SlimeOS".into(),
                ModeId::new("directory").unwrap(),
            )],
        )
        .unwrap();
        let mut face = new("PM", &[]);
        face.territory.workspaces = vec!["work:slime".into(), "work:slime".into()];
        let pm = create(&conn, &face).unwrap();
        assert_eq!(pm.territory.workspaces, ["work:slime"]);
        let territory = Territory {
            workspaces: vec!["work:none".into()],
            ..Default::default()
        };
        let patch = FacePatch {
            territory: Some(territory),
            ..Default::default()
        };
        assert_eq!(update(&conn, &pm.id, &patch).unwrap_err().status, 400);
        let patch = FacePatch {
            territory: Some(Territory::default()),
            ..Default::default()
        };
        assert!(
            update(&conn, &pm.id, &patch)
                .unwrap()
                .territory
                .workspaces
                .is_empty()
        );
        let patch = FacePatch {
            territory: Some(Territory::default()),
            ..Default::default()
        };
        assert_eq!(update(&conn, HOST_FACE_ID, &patch).unwrap_err().status, 409);
    }

    #[test]
    fn mentions_need_the_whole_name() {
        let faces = vec![
            Face {
                id: "a".into(),
                name: "PM".into(),
                ..host_like()
            },
            Face {
                id: "b".into(),
                name: "PM Lead".into(),
                ..host_like()
            },
            Face {
                id: "c".into(),
                name: "小助手".into(),
                ..host_like()
            },
        ];
        assert_eq!(mentions("@pm what's up", &faces), ["a"]);
        assert_eq!(mentions("@PM Lead and @pm, @pm", &faces), ["b", "a"]);
        assert!(mentions("me@pm.com @pmx", &faces).is_empty());
        assert_eq!(mentions("問一下@小助手。", &faces), ["c"]);
        assert_eq!(mentions("@PM你好", &faces), ["a"]);
    }

    fn host_like() -> Face {
        Face {
            id: String::new(),
            name: String::new(),
            bio: String::new(),
            tone: String::new(),
            avatar: None,
            color: None,
            role_md: String::new(),
            territory: Territory::default(),
            is_host: false,
            created_at: 0,
            archived_at: None,
            hidden_at: None,
        }
    }

    #[test]
    fn who_answers() {
        let db = Db::memory();
        let conn = db.lock();
        let room = conn.create_room("slimeos").unwrap();
        let why = |room_id: &str, text: &str| {
            let route = route(&conn, room_id, text).unwrap();
            (route.face.name, route.why)
        };
        assert_eq!(why(&room.id, "hi"), ("pirc".to_owned(), Why::Host));
        let pm = create(&conn, &new("PM", &[&room.id])).unwrap();
        create(&conn, &new("Ops", &[])).unwrap();
        assert_eq!(why(&room.id, "hi"), ("PM".to_owned(), Why::Room));
        assert_eq!(why(GENERAL_ROOM_ID, "hi"), ("pirc".to_owned(), Why::Host));
        assert_eq!(
            why(GENERAL_ROOM_ID, "@ops and @PM?"),
            ("Ops".to_owned(), Why::Mentioned)
        );
        conn.post_message(
            GENERAL_ROOM_ID,
            Speaker::Face(&pm.id),
            MessageKind::Text,
            &json!({ "text": "on it" }),
        )
        .unwrap();
        // A line is not the face speaking.
        conn.post_message(
            GENERAL_ROOM_ID,
            Speaker::Face(HOST_FACE_ID),
            MessageKind::Line,
            &json!({ "text": "noted" }),
        )
        .unwrap();
        assert_eq!(
            why(GENERAL_ROOM_ID, "and now?"),
            ("PM".to_owned(), Why::SpokeLast)
        );
        update(
            &conn,
            &pm.id,
            &FacePatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            why(GENERAL_ROOM_ID, "and now?"),
            ("pirc".to_owned(), Why::Host)
        );
        assert_eq!(why(&room.id, "@pm?"), ("pirc".to_owned(), Why::Host));
    }
}
