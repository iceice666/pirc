//! Topics and moving a conversation (plans/rewrite/10-faces.md, decisions
//! #11 and #18).
//!
//! The brain says what a turn was about with its `topic` tool, and what
//! the topic touches when it knows (a workspace or a source); the turn's
//! messages carry the name. After a turn, code checks the two guards of
//! decision #11: at least [`MIN_MESSAGES`] of the room's latest messages
//! are on the topic, and another room covers what it touches (a face's
//! room whose workspaces include it, or a room that follows the source),
//! where this room does not. And it is suggested once a day at most. Then
//! the host is asked, in the next turn there, to suggest moving; it moves
//! only when someone says yes (`move_room` with their words), and the open
//! loops of the conversation go along.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::faces;
use crate::app::App;
use crate::db::rooms::{Moved, Room, RoomStore};
use crate::error::{ApiError, ApiResult};
use crate::project_links;
use crate::wake::quota;

/// Messages on one topic before moving it is suggested (decision #11).
pub const MIN_MESSAGES: i64 = 15;
/// The room's latest text messages the count looks at.
const WINDOW: i64 = 50;
/// Characters in a topic's name.
pub const MAX_TOPIC_CHARS: usize = 60;

/// What a turn was about, as the brain said.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Topic {
    pub name: String,
    pub workspace_id: Option<String>,
    pub source_id: Option<String>,
}

/// A topic name as given: trimmed, lowercased, 1 to [`MAX_TOPIC_CHARS`].
pub fn topic_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_lowercase();
    if name.is_empty()
        || name.chars().count() > MAX_TOPIC_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(format!("A topic has 1 to {MAX_TOPIC_CHARS} characters"));
    }
    Ok(name)
}

/// Tag the messages with the topic and keep what it touches (what the
/// brain said last wins, an unsaid one is kept).
pub fn tag(
    conn: &Connection,
    room_id: &str,
    topic: &Topic,
    message_ids: &[String],
    now: i64,
) -> ApiResult<()> {
    for id in message_ids {
        conn.execute(
            "UPDATE room_messages SET topic=? WHERE id=? AND room_id=?",
            params![topic.name, id, room_id],
        )?;
    }
    conn.execute(
        "INSERT INTO room_topics (room_id,name,workspace_id,source_id,updated_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(room_id,name) DO UPDATE SET workspace_id=COALESCE(excluded.workspace_id, workspace_id),
           source_id=COALESCE(excluded.source_id, source_id), updated_at=excluded.updated_at",
        params![room_id, topic.name, topic.workspace_id, topic.source_id, now],
    )?;
    Ok(())
}

/// How many of the room's latest text messages are on the topic.
pub fn count(conn: &Connection, room_id: &str, name: &str) -> ApiResult<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM (SELECT topic FROM room_messages WHERE room_id=?1 AND kind='text' ORDER BY seq DESC LIMIT ?2) WHERE topic=?3",
        params![room_id, WINDOW, name],
        |row| row.get(0),
    )?)
}

fn stored(conn: &Connection, room_id: &str, name: &str) -> ApiResult<Option<Topic>> {
    Ok(conn
        .query_row(
            "SELECT name, workspace_id, source_id FROM room_topics WHERE room_id=? AND name=?",
            [room_id, name],
            |row| {
                Ok(Topic {
                    name: row.get(0)?,
                    workspace_id: row.get(1)?,
                    source_id: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Whether a room covers what the topic touches: it follows the source, or
/// it is the room of a face linked to the workspace (or another clone of
/// its repository).
fn covers(conn: &Connection, room: &Room, topic: &Topic) -> ApiResult<bool> {
    if let Some(source_id) = &topic.source_id {
        if room
            .source_scope
            .as_ref()
            .is_some_and(|scope| crate::sources::followed(scope, source_id))
        {
            return Ok(true);
        }
        if faces::room_face(conn, &room.id)?
            .is_some_and(|face| face.territory.sources.contains(source_id))
        {
            return Ok(true);
        }
    }
    if let Some(workspace_id) = &topic.workspace_id
        && let Some(face) = faces::room_face(conn, &room.id)?
    {
        let links = project_links::links(conn, &face.id)?;
        let repos = project_links::repos(conn, &links)?;
        if let Some(workspace) = crate::db::Store::find_workspace(conn, workspace_id)? {
            return Ok(project_links::linked(&links, &repos, &workspace).is_some());
        }
        return Ok(links.iter().any(|link| &link.workspace_id == workspace_id));
    }
    Ok(false)
}

/// Another open room that covers the topic, where `room` does not.
pub fn target(conn: &Connection, room: &Room, topic: &Topic) -> ApiResult<Option<Room>> {
    if topic.source_id.is_none() && topic.workspace_id.is_none() {
        return Ok(None);
    }
    if covers(conn, room, topic)? {
        return Ok(None);
    }
    let ids: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT id FROM rooms WHERE archived_at IS NULL AND id<>? ORDER BY created_at, rowid",
        )?;
        let rows = statement.query_map([&room.id], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in ids {
        let other = conn.get_room(&id)?;
        if covers(conn, &other, topic)? {
            return Ok(Some(other));
        }
    }
    Ok(None)
}

/// After a turn on `name` in `room_id`: whether to suggest moving it now,
/// and where. Passing the guards records the suggestion (once a day), so
/// the next turn there carries the hint ([`take_hint`]).
pub fn check(
    conn: &Connection,
    room_id: &str,
    name: &str,
    now: i64,
    zone: crate::time::cron::Zone,
) -> ApiResult<Option<Room>> {
    let Some(topic) = stored(conn, room_id, name)? else {
        return Ok(None);
    };
    if count(conn, room_id, name)? < MIN_MESSAGES {
        return Ok(None);
    }
    let suggested: Option<i64> = conn.query_row(
        "SELECT suggested_at FROM room_topics WHERE room_id=? AND name=?",
        [room_id, name],
        |row| row.get(0),
    )?;
    if suggested.is_some_and(|at| at >= quota::day_start(now, zone)) {
        return Ok(None);
    }
    let room = conn.get_room(room_id)?;
    let Some(to) = target(conn, &room, &topic)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE room_topics SET suggested_at=?, hint_room_id=? WHERE room_id=? AND name=?",
        params![now, to.id, room_id, name],
    )?;
    Ok(Some(to))
}

/// A suggestion waiting for the room's next turn: the topic and the room
/// it belongs in, taken out (it is made once).
pub fn take_hint(conn: &Connection, room_id: &str) -> ApiResult<Option<(String, Room)>> {
    let hint: Option<(String, String)> = conn
        .query_row(
            "SELECT name, hint_room_id FROM room_topics WHERE room_id=? AND hint_room_id IS NOT NULL ORDER BY suggested_at DESC LIMIT 1",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((name, to)) = hint else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE room_topics SET hint_room_id=NULL WHERE room_id=?",
        [room_id],
    )?;
    match conn.get_room(&to) {
        Ok(room) if room.archived_at.is_none() => Ok(Some((name, room))),
        _ => Ok(None),
    }
}

/// The topic of the room moving was last suggested for.
pub fn last_suggested(conn: &Connection, room_id: &str) -> ApiResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT name FROM room_topics WHERE room_id=? AND suggested_at IS NOT NULL ORDER BY suggested_at DESC LIMIT 1",
            [room_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// The prompt section of a hint.
pub fn hint_section(name: &str, to: &Room, messages: i64) -> pirc_agent::context::PromptSection {
    pirc_agent::context::PromptSection::new(
        "move",
        "Maybe move",
        "built-in",
        format!(
            "## Maybe move\n\n\
             The conversation here about \"{name}\" has gone on for {messages} messages, and it belongs in #{} ({}). \
             Speaking as the host, ask once, briefly, whether to continue there; do not ask again if they do not want to. \
             Only when someone says yes, call `move_room` with `to` set to {} and their words as `quote`.",
            to.name, to.id, to.id
        ),
    )
}

/// What a move did.
pub struct Move {
    pub moved: Moved,
    /// The open loops that went along.
    pub loops: Vec<super::loops::OpenLoop>,
}

/// Continue `from`'s conversation in `to`; with a topic, the open loops of
/// the room made since the topic began go along.
pub fn move_room(conn: &Connection, from: &str, to: &str, topic: Option<&str>) -> ApiResult<Move> {
    crate::db::atomic(conn, |tx| {
        let moved = tx.move_room(from, to)?;
        let mut loops = Vec::new();
        if let Some(name) = topic {
            let began: Option<i64> = tx.query_row(
                "SELECT MIN(created_at) FROM room_messages WHERE room_id=? AND topic=?",
                [from, name],
                |row| row.get(0),
            )?;
            if let Some(began) = began {
                let ids: Vec<String> = {
                    let mut statement = tx.prepare(
                        "SELECT id FROM open_loops WHERE status='open' AND room_id=? AND created_at>=?",
                    )?;
                    let rows = statement.query_map(params![from, began], |row| row.get(0))?;
                    rows.collect::<Result<_, _>>()?
                };
                for id in ids {
                    tx.execute(
                        "UPDATE open_loops SET room_id=? WHERE id=?",
                        [to, id.as_str()],
                    )?;
                    loops.push(super::loops::get(tx, &id)?);
                }
            }
        }
        Ok(Move { moved, loops })
    })
}

/// Tell everyone about a move.
pub fn moved(app: &App, done: &Move) {
    app.room_message(&done.moved.from_line);
    app.room_message(&done.moved.to_line);
    app.room_changed(&done.moved.from);
    app.room_changed(&done.moved.to);
    for open_loop in &done.loops {
        super::loops::changed(app, open_loop);
    }
}

/// `{from, to, fromLine, toLine, loops}` for the API.
pub fn public(done: &Move) -> Value {
    let mut value = json!(done.moved);
    value["loops"] = json!(
        done.loops
            .iter()
            .map(|open_loop| &open_loop.id)
            .collect::<Vec<_>>()
    );
    value
}

/// 404 for a room that is not there, by id or `#name`.
pub fn find_room(conn: &Connection, wanted: &str) -> ApiResult<Room> {
    let wanted = wanted.trim();
    if let Ok(room) = conn.get_room(wanted) {
        return Ok(room);
    }
    let name = wanted.strip_prefix('#').unwrap_or(wanted).to_lowercase();
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM rooms WHERE lower(name)=? AND archived_at IS NULL ORDER BY created_at LIMIT 1",
            [name],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => conn.get_room(&id),
        None => Err(ApiError::not_found(format!("No room {wanted}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::rooms::{GENERAL_ROOM_ID, MessageKind, RoomPatch, Speaker};
    use crate::db::{Db, ModeId, Store as _};

    fn say(conn: &Connection, n: usize) -> Vec<String> {
        (0..n)
            .map(|i| {
                conn.post_message(
                    GENERAL_ROOM_ID,
                    Speaker::User("ann"),
                    MessageKind::Text,
                    &json!({ "text": format!("message {i}") }),
                )
                .unwrap()
                .id
            })
            .collect()
    }

    #[test]
    fn suggests_at_fifteen_once_a_day() {
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
        let room = conn.create_room("slimeos").unwrap();
        let topic = Topic {
            name: "slimeos pr".into(),
            workspace_id: Some("work:slime".into()),
            source_id: None,
        };
        let zone = quota::zone("UTC");
        let now = 1_800_000_000_000;
        let ids = say(&conn, 14);
        tag(&conn, GENERAL_ROOM_ID, &topic, &ids, now).unwrap();
        // Fourteen, and no room covers it yet.
        assert_eq!(
            check(&conn, GENERAL_ROOM_ID, &topic.name, now, zone).unwrap(),
            None
        );
        let mut face = faces::NewFace {
            name: "PM".into(),
            ..Default::default()
        };
        face.territory.rooms = vec![room.id.clone()];
        face.territory.workspaces = vec!["work:slime".into()];
        faces::create(&conn, &face).unwrap();
        assert_eq!(
            check(&conn, GENERAL_ROOM_ID, &topic.name, now, zone).unwrap(),
            None,
            "14"
        );
        let more = say(&conn, 1);
        tag(&conn, GENERAL_ROOM_ID, &topic, &more, now).unwrap();
        let to = check(&conn, GENERAL_ROOM_ID, &topic.name, now, zone).unwrap();
        assert_eq!(to.map(|room| room.name), Some("slimeos".to_owned()), "15");
        assert_eq!(
            check(&conn, GENERAL_ROOM_ID, &topic.name, now + 1, zone).unwrap(),
            None,
            "today"
        );
        let (name, hinted) = take_hint(&conn, GENERAL_ROOM_ID).unwrap().unwrap();
        assert_eq!(
            (name.as_str(), hinted.id.as_str()),
            ("slimeos pr", room.id.as_str())
        );
        assert!(take_hint(&conn, GENERAL_ROOM_ID).unwrap().is_none(), "once");
        let tomorrow = now + 86_400_000;
        assert!(
            check(&conn, GENERAL_ROOM_ID, &topic.name, tomorrow, zone)
                .unwrap()
                .is_some()
        );
        // Already where it belongs: nothing to suggest.
        let ids = (0..15)
            .map(|i| {
                conn.post_message(
                    &room.id,
                    Speaker::User("ann"),
                    MessageKind::Text,
                    &json!({ "text": i }),
                )
                .unwrap()
                .id
            })
            .collect::<Vec<_>>();
        tag(&conn, &room.id, &topic, &ids, now).unwrap();
        assert_eq!(
            check(&conn, &room.id, &topic.name, now, zone).unwrap(),
            None
        );
    }

    #[test]
    fn a_followed_source_is_covered() {
        let db = Db::memory();
        let conn = db.lock();
        let room = conn.create_room("school").unwrap();
        conn.update_room(
            &room.id,
            &RoomPatch {
                source_scope: Some(json!({ "sources": ["moodle"] })),
                ..Default::default()
            },
        )
        .unwrap();
        let general = conn.get_room(GENERAL_ROOM_ID).unwrap();
        let topic = Topic {
            name: "hw3".into(),
            workspace_id: None,
            source_id: Some("moodle".into()),
        };
        assert_eq!(
            target(&conn, &general, &topic).unwrap().map(|room| room.id),
            Some(room.id.clone())
        );
        let untouched = Topic {
            name: "x".into(),
            ..Default::default()
        };
        assert_eq!(target(&conn, &general, &untouched).unwrap(), None);
    }
}
