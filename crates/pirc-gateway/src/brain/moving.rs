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
//!
//! A move that names the topic also copies the topic's messages into the new
//! room as one quote ([move_room], [`MAX_QUOTE_MESSAGES`] and the two
//! character limits): the old room keeps every message and takes new ones,
//! and people in the new room read what was said before they came. Nothing
//! of a move happens halfway: both lines, the copy, the loops and the rooms'
//! `moved_*` fields are written in one transaction.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::faces;
use crate::app::App;
use crate::db::rooms::{HOST_FACE_ID, Message, MessageKind, Moved, Room, RoomStore, Speaker};
use crate::error::{ApiError, ApiResult};
use crate::project_links;
use crate::util::safe_json;
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
    /// The topic's messages copied into the new room, as a quote: `None`
    /// without a topic, or when nothing carries it.
    pub quote: Option<Message>,
}

/// Continue `from`'s conversation in `to`; with a topic, the open loops of
/// the room made since the topic began go along, and the topic's messages
/// are copied into the new room as one quote (they stay where they were).
pub fn move_room(conn: &Connection, from: &str, to: &str, topic: Option<&str>) -> ApiResult<Move> {
    crate::db::atomic(conn, |tx| {
        let mut moved = tx.move_room(from, to)?;
        let mut loops = Vec::new();
        let mut quote = None;
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
            // The conversation itself: copied, not taken. One message in the
            // new room, under its "Continued from" line.
            if let Some(body) = quote_body(tx, &moved.from, name)? {
                quote = Some(tx.post_message(
                    to,
                    Speaker::Face(HOST_FACE_ID),
                    MessageKind::Text,
                    &body,
                )?);
                // The copy moved the new room's activity and seq on: the
                // event says so, rather than the room as it was a message ago.
                moved.to = tx.get_room(to)?;
            }
        }
        Ok(Move {
            moved,
            loops,
            quote,
        })
    })
}

/// Messages one quote carries at most (the newest of the topic).
pub const MAX_QUOTE_MESSAGES: usize = 50;
/// Characters of quoted words altogether.
pub const MAX_QUOTE_CHARS: usize = 20_000;
/// Characters of one quoted message (a longer one is cut).
pub const MAX_QUOTE_TEXT_CHARS: usize = 4_000;

/// The `body` of the message a move leaves in the new room: the topic's
/// messages as a `quote` (who said it, when, their words, the files' names),
/// the oldest left out first when they do not all fit. `None` when nothing
/// in `from` carries the topic.
fn quote_body(conn: &Connection, from: &Room, topic: &str) -> ApiResult<Option<Value>> {
    let total: i64 = conn.query_row(
        "SELECT count(*) FROM room_messages WHERE room_id=? AND topic=? AND kind='text'",
        [&from.id, topic],
        |row| row.get(0),
    )?;
    if total == 0 {
        return Ok(None);
    }
    // Newest first, so the character budget keeps the latest words.
    let rows: Vec<(String, i64, String, Option<String>, Value, i64)> = {
        let mut statement = conn.prepare(
            "SELECT id, seq, speaker, user, body_json, created_at FROM room_messages
             WHERE room_id=? AND topic=? AND kind='text' ORDER BY seq DESC LIMIT ?",
        )?;
        let rows =
            statement.query_map(params![from.id, topic, MAX_QUOTE_MESSAGES as i64], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    safe_json(&row.get::<_, String>(4)?, json!({})),
                    row.get(5)?,
                ))
            })?;
        rows.collect::<Result<_, _>>()?
    };
    let mut quoted: Vec<Value> = Vec::new();
    let mut chars = 0usize;
    for (id, seq, speaker, user, body, at) in rows {
        let text = body["text"].as_str().unwrap_or_default();
        let (text, cut) = cut_text(text, MAX_QUOTE_TEXT_CHARS);
        let length = text.chars().count();
        if !quoted.is_empty() && chars + length > MAX_QUOTE_CHARS {
            break;
        }
        chars += length;
        let mut entry = json!({ "id": id, "seq": seq, "speaker": speaker, "at": at, "text": text });
        if let Some(user) = user {
            entry["user"] = json!(user);
        }
        if cut {
            entry["cut"] = json!(true);
        }
        // The bytes stay in the old room: only the files' names travel.
        let files: Vec<Value> = body["attachments"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|file| json!({ "kind": file["kind"], "filename": file["filename"] }))
                    .collect()
            })
            .unwrap_or_default();
        if !files.is_empty() {
            entry["attachments"] = json!(files);
        }
        quoted.push(entry);
    }
    quoted.reverse();
    let omitted = total - quoted.len() as i64;
    let mut quote = json!({
        "from": { "id": from.id, "name": from.name },
        "topic": topic,
        "messages": quoted,
    });
    if omitted > 0 {
        quote["omitted"] = json!(omitted);
    }
    // The sentence for clients that cannot draw the copy (the brain reads it
    // in its new room too); the web draws the quote instead.
    let text = if omitted > 0 {
        format!(
            "Copied {count} messages about \"{topic}\" from #{room} (the {omitted} older ones did not fit).",
            count = quoted.len(),
            room = from.name,
        )
    } else {
        format!(
            "Copied {count} messages about \"{topic}\" from #{room}.",
            count = quoted.len(),
            room = from.name,
        )
    };
    Ok(Some(json!({ "text": text, "quote": quote })))
}

/// `text` cut to `max` characters, and whether it was.
fn cut_text(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (&text[..at], true),
        None => (text, false),
    }
}

/// Tell everyone about a move.
pub fn moved(app: &App, done: &Move) {
    app.room_message(&done.moved.from_line);
    app.room_message(&done.moved.to_line);
    if let Some(quote) = &done.quote {
        app.room_message(quote);
    }
    app.room_changed(&done.moved.from);
    app.room_changed(&done.moved.to);
    for open_loop in &done.loops {
        super::loops::changed(app, open_loop);
    }
}

/// `{from, to, fromLine, toLine, loops, quote?}` for the API.
pub fn public(done: &Move) -> Value {
    let mut value = json!(done.moved);
    value["loops"] = json!(
        done.loops
            .iter()
            .map(|open_loop| &open_loop.id)
            .collect::<Vec<_>>()
    );
    if let Some(quote) = &done.quote {
        value["quote"] = json!(quote);
    }
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

    fn topic(name: &str) -> Topic {
        Topic {
            name: name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_topic_move_copies_its_messages_as_one_quote() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("slimeos").unwrap();
        let ids = say(&conn, 3);
        // A picture, so the copy can name the file it does not carry.
        let picture = conn
            .post_message(
                GENERAL_ROOM_ID,
                Speaker::User("ann"),
                MessageKind::Text,
                &json!({
                    "text": "the screenshot",
                    "attachments": [{
                        "id": "up1", "kind": "image", "filename": "shot.png",
                        "mimeType": "image/png", "byteSize": 3,
                    }],
                }),
            )
            .unwrap();
        let name = "slimeos pr";
        tag(
            &conn,
            GENERAL_ROOM_ID,
            &topic(name),
            &[ids[0].clone(), ids[1].clone(), picture.id.clone()],
            1,
        )
        .unwrap();
        let done = move_room(&conn, GENERAL_ROOM_ID, &target.id, Some(name)).unwrap();
        let quote = done.quote.expect("the topic's messages come along");
        assert_eq!(
            (quote.room_id.as_str(), quote.kind.as_str()),
            (target.id.as_str(), "text"),
            "a message of its own in the new room"
        );
        let copy = &quote.body["quote"];
        assert_eq!(copy["from"]["id"], GENERAL_ROOM_ID);
        assert_eq!(copy["from"]["name"], "general");
        assert_eq!(copy["topic"], name);
        assert!(copy["omitted"].is_null(), "all of them fit");
        let copied = copy["messages"].as_array().unwrap();
        let texts: Vec<&str> = copied
            .iter()
            .map(|message| message["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, ["message 0", "message 1", "the screenshot"]);
        // Who said it, when, and the original message to trace it back to.
        assert_eq!(copied[0]["id"], ids[0].as_str());
        assert_eq!(copied[0]["seq"], 1);
        assert_eq!(copied[0]["speaker"], "user");
        assert_eq!(copied[0]["user"], "ann");
        assert!(copied[0]["at"].is_i64());
        // The file's name travels; the upload and its bytes stay behind.
        assert!(copied[0]["attachments"].is_null());
        assert_eq!(
            copied[2]["attachments"],
            json!([{ "kind": "image", "filename": "shot.png" }])
        );
        // Copied, not taken: the old room keeps its words, and its line.
        let old = conn.list_messages(GENERAL_ROOM_ID, None, 10).unwrap();
        assert_eq!(old.len(), 5, "four messages and the line");
        assert!(old.iter().all(|message| message.id != quote.id));
        // The new room: "Continued from" first, then the copy.
        let new = conn.list_messages(&target.id, None, 10).unwrap();
        assert_eq!(new.len(), 2);
        assert_eq!(new[0].kind, "line");
        assert_eq!(new[1].id, quote.id);
        // The room the move reports is the one with the copy in it.
        assert_eq!(
            (done.moved.to.last_seq, done.moved.to.id.as_str()),
            (2, target.id.as_str())
        );
        // A message on another topic stays out.
        assert!(!texts.contains(&"message 2"));
    }

    #[test]
    fn a_quote_keeps_the_newest_and_says_how_many_it_left_out() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("slimeos").unwrap();
        let ids = say(&conn, MAX_QUOTE_MESSAGES + 5);
        tag(&conn, GENERAL_ROOM_ID, &topic("many"), &ids, 1).unwrap();
        let done = move_room(&conn, GENERAL_ROOM_ID, &target.id, Some("many")).unwrap();
        let body = done.quote.unwrap().body;
        let copied = body["quote"]["messages"].as_array().unwrap();
        assert_eq!(copied.len(), MAX_QUOTE_MESSAGES);
        assert_eq!(body["quote"]["omitted"], 5);
        // The newest kept, the oldest left out, in the order they were said.
        assert_eq!(copied[0]["id"], ids[5].as_str());
        assert_eq!(
            copied[MAX_QUOTE_MESSAGES - 1]["id"],
            ids[ids.len() - 1].as_str()
        );
        assert_eq!(
            body["text"],
            format!(
                "Copied {MAX_QUOTE_MESSAGES} messages about \"many\" from #general (the 5 older ones did not fit)."
            )
        );
    }

    #[test]
    fn a_quote_stops_at_its_character_budget() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("slimeos").unwrap();
        // Six messages of just under the per-message limit: five fit the
        // whole budget, the sixth (the oldest) is left out.
        let ids: Vec<String> = (0..6)
            .map(|_| {
                conn.post_message(
                    GENERAL_ROOM_ID,
                    Speaker::User("ann"),
                    MessageKind::Text,
                    &json!({ "text": "x".repeat(MAX_QUOTE_TEXT_CHARS) }),
                )
                .unwrap()
                .id
            })
            .collect();
        tag(&conn, GENERAL_ROOM_ID, &topic("long"), &ids, 1).unwrap();
        let done = move_room(&conn, GENERAL_ROOM_ID, &target.id, Some("long")).unwrap();
        let body = done.quote.unwrap().body;
        let copied = body["quote"]["messages"].as_array().unwrap();
        assert_eq!(copied.len(), MAX_QUOTE_CHARS / MAX_QUOTE_TEXT_CHARS);
        assert_eq!(body["quote"]["omitted"], 1);
        assert!(copied.iter().all(|message| message["cut"].is_null()));
    }

    #[test]
    fn a_long_message_is_cut_in_the_copy_and_kept_whole_in_its_room() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("slimeos").unwrap();
        let long = "y".repeat(MAX_QUOTE_TEXT_CHARS + 500);
        let id = conn
            .post_message(
                GENERAL_ROOM_ID,
                Speaker::User("ann"),
                MessageKind::Text,
                &json!({ "text": long }),
            )
            .unwrap()
            .id;
        tag(
            &conn,
            GENERAL_ROOM_ID,
            &topic("long"),
            std::slice::from_ref(&id),
            1,
        )
        .unwrap();
        let done = move_room(&conn, GENERAL_ROOM_ID, &target.id, Some("long")).unwrap();
        let body = done.quote.unwrap().body;
        let copied = body["quote"]["messages"].as_array().unwrap();
        assert_eq!(copied[0]["cut"], true);
        assert_eq!(
            copied[0]["text"].as_str().unwrap().chars().count(),
            MAX_QUOTE_TEXT_CHARS
        );
        let kept = conn.get_message(GENERAL_ROOM_ID, &id).unwrap();
        assert_eq!(kept.body["text"].as_str().unwrap(), long, "nothing is lost");
    }

    #[test]
    fn a_move_without_a_topic_copies_nothing() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("slimeos").unwrap();
        let ids = say(&conn, 2);
        tag(&conn, GENERAL_ROOM_ID, &topic("t"), &ids, 1).unwrap();
        let done = move_room(&conn, GENERAL_ROOM_ID, &target.id, None).unwrap();
        assert!(done.quote.is_none());
        let new = conn.list_messages(&target.id, None, 10).unwrap();
        assert_eq!(new.len(), 1, "only the line");
        assert_eq!(new[0].kind, "line");
        // A topic nothing carries copies nothing either.
        let empty = move_room(&conn, GENERAL_ROOM_ID, &target.id, Some("nothing")).unwrap();
        assert!(empty.quote.is_none());
    }

    #[test]
    fn a_move_that_fails_leaves_no_copy() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("slimeos").unwrap();
        let ids = say(&conn, 2);
        tag(&conn, GENERAL_ROOM_ID, &topic("t"), &ids, 1).unwrap();
        conn.update_room(
            &target.id,
            &RoomPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let failed = move_room(&conn, GENERAL_ROOM_ID, &target.id, Some("t"));
        match failed {
            Err(error) => assert_eq!(error.code, "conflict"),
            Ok(_) => panic!("an archived room takes no move"),
        }
        // Nothing of the move happened: neither line, nor copy, nor tag.
        assert_eq!(conn.list_messages(&target.id, None, 10).unwrap().len(), 0);
        assert_eq!(
            conn.list_messages(GENERAL_ROOM_ID, None, 10).unwrap().len(),
            2
        );
        assert_eq!(
            conn.get_room(GENERAL_ROOM_ID).unwrap().moved_to_room_id,
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
