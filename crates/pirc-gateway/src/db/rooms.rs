//! Rooms, their messages, reads and pending input (plans/rewrite/01-rooms.md).
//!
//! The invariants live here, inside one transaction each:
//! - exactly one `#general` (`kind='general'`, seeded with the schema), and
//!   it is never archived;
//! - archiving hides a room and deletes nothing; an archived room can still
//!   be read but takes no new messages until it is unarchived;
//! - a move writes two lines: "continued in #to" in the old room and
//!   "continued from #from" at the start of the new one;
//! - a room's messages are numbered 1, 2, ... in the order they were stored,
//!   and a user's own messages are read when sent.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use super::atomic;
use crate::error::{ApiError, ApiResult};
use crate::util::{new_id, now_ms, safe_json};

/// The id of `#general`, the one room of kind `general`.
pub const GENERAL_ROOM_ID: &str = "general";
/// The id of the host face, the one that always exists.
pub const HOST_FACE_ID: &str = "host";
/// The speaker of every user's messages; [`Message::user`] says whose.
pub const USER_SPEAKER: &str = "user";
/// Characters in a room name.
pub const MAX_ROOM_NAME_CHARS: usize = 80;
/// Messages per page of [`RoomStore::list_messages`].
pub const MAX_MESSAGE_PAGE: usize = 200;
pub const DEFAULT_MESSAGE_PAGE: usize = 50;

/// What a new database starts with: `#general` and the host face.
pub(super) fn seed(connection: &Connection) -> rusqlite::Result<()> {
    let stamp = now_ms();
    connection.execute(
        "INSERT INTO rooms (id,name,kind,created_at,last_activity_at) VALUES (?1,'general','general',?2,?2)",
        params![GENERAL_ROOM_ID, stamp],
    )?;
    connection.execute(
        "INSERT INTO faces (id,name,created_at,is_host) VALUES (?1,'pirc',?2,1)",
        params![HOST_FACE_ID, stamp],
    )?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub name: String,
    /// `general` or `topic`.
    pub kind: String,
    pub created_at: i64,
    pub archived_at: Option<i64>,
    pub last_activity_at: i64,
    pub source_scope: Option<Value>,
    pub moved_to_room_id: Option<String>,
    pub moved_from_room_id: Option<String>,
    /// The seq of its newest message, 0 when it has none.
    pub last_seq: i64,
}

impl Room {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            kind: row.get("kind")?,
            created_at: row.get("created_at")?,
            archived_at: row.get("archived_at")?,
            last_activity_at: row.get("last_activity_at")?,
            source_scope: row
                .get::<_, Option<String>>("source_scope_json")?
                .map(|scope| safe_json(&scope, Value::Null)),
            moved_to_room_id: row.get("moved_to_room_id")?,
            moved_from_room_id: row.get("moved_from_room_id")?,
            last_seq: row.get::<_, i64>("next_seq")? - 1,
        })
    }
}

/// A room as one user sees it in the list.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    #[serde(flatten)]
    pub room: Room,
    /// The seq the user has read up to.
    pub read_seq: i64,
    /// Messages after `read_seq` that others sent.
    pub unread: i64,
    /// A face asked the user something there and waits for the reply.
    pub waiting: bool,
    pub waiting_since: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub room_id: String,
    pub seq: i64,
    /// `user` or `face:<id>`.
    pub speaker: String,
    /// Who sent a `user` message.
    pub user: Option<String>,
    /// `text`, `line`, `progress` or `question`.
    pub kind: String,
    pub body: Value,
    pub thread_id: Option<String>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub pinned_at: Option<i64>,
    /// What the brain said the turn was about (plan 10).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
}

impl Message {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            seq: row.get("seq")?,
            speaker: row.get("speaker")?,
            user: row.get("user")?,
            kind: row.get("kind")?,
            body: safe_json(&row.get::<_, String>("body_json")?, json!({})),
            thread_id: row.get("thread_id")?,
            created_at: row.get("created_at")?,
            edited_at: row.get("edited_at")?,
            pinned_at: row.get("pinned_at")?,
            topic: row.get("topic")?,
        })
    }
}

/// Who speaks a new message.
#[derive(Clone, Copy, Debug)]
pub enum Speaker<'a> {
    User(&'a str),
    Face(&'a str),
}

/// A message's kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageKind {
    Text,
    Line,
    #[allow(dead_code, reason = "the brain's progress lines start in plan 02")]
    Progress,
    #[allow(dead_code, reason = "questions in rooms start in plans 05 to 07")]
    Question,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Line => "line",
            Self::Progress => "progress",
            Self::Question => "question",
        }
    }
}

/// A change to a room's settings (`PATCH /api/rooms/:id`); `None` keeps it.
#[derive(Clone, Debug, Default)]
pub struct RoomPatch {
    pub name: Option<String>,
    pub archived: Option<bool>,
    /// `Some(Value::Null)` clears it.
    pub source_scope: Option<Value>,
}

/// The two lines a move wrote.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub from: Room,
    pub to: Room,
    pub from_line: Message,
    pub to_line: Message,
}

fn room_not_found() -> ApiError {
    ApiError::not_found("Room not found")
}

fn conflict(message: &str) -> ApiError {
    ApiError::new(409, "conflict", message)
}

/// A room name as given: trimmed, without a leading `#`, 1 to
/// [`MAX_ROOM_NAME_CHARS`] characters and no control characters.
pub fn room_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    let name = name.strip_prefix('#').unwrap_or(name).trim();
    if name.is_empty()
        || name.chars().count() > MAX_ROOM_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(ApiError::new(
            400,
            "invalid_input",
            format!("A room name has 1 to {MAX_ROOM_NAME_CHARS} characters"),
        ));
    }
    Ok(name.to_owned())
}

const ROOM_VIEW_SELECT: &str =
    "SELECT r.*, COALESCE(rr.last_seq, 0) AS read_seq, rr.waiting_since AS waiting_since,
  (SELECT count(*) FROM room_messages m WHERE m.room_id = r.id AND m.seq > COALESCE(rr.last_seq, 0)
     AND NOT (m.speaker = 'user' AND m.user IS ?1)) AS unread
 FROM rooms r LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.user = ?1";

fn room_view(row: &Row<'_>) -> rusqlite::Result<RoomView> {
    let waiting_since: Option<i64> = row.get("waiting_since")?;
    Ok(RoomView {
        room: Room::from_row(row)?,
        read_seq: row.get("read_seq")?,
        unread: row.get("unread")?,
        waiting: waiting_since.is_some(),
        waiting_since,
    })
}

/// The room queries; see the module documentation.
pub trait RoomStore {
    /// Rooms by latest activity; archived ones only when asked for.
    fn list_rooms(&self, user: &str, archived: bool) -> ApiResult<Vec<RoomView>>;
    /// 404 "Room not found".
    fn get_room(&self, room_id: &str) -> ApiResult<Room>;
    fn room_view(&self, room_id: &str, user: &str) -> ApiResult<RoomView>;
    fn create_room(&self, name: &str) -> ApiResult<Room>;
    fn update_room(&self, room_id: &str, patch: &RoomPatch) -> ApiResult<Room>;
    /// Continue `from`'s conversation in `to`.
    fn move_room(&self, from: &str, to: &str) -> ApiResult<Moved>;

    fn post_message(
        &self,
        room_id: &str,
        speaker: Speaker<'_>,
        kind: MessageKind,
        body: &Value,
    ) -> ApiResult<Message>;
    /// 404 "Message not found" unless it is in `room_id`.
    fn get_message(&self, room_id: &str, message_id: &str) -> ApiResult<Message>;
    /// Messages before `before` (a seq; the newest without it), oldest first.
    fn list_messages(
        &self,
        room_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> ApiResult<Vec<Message>>;
    /// The pinned messages of a room, oldest pin first.
    fn pinned_messages(&self, room_id: &str) -> ApiResult<Vec<Message>>;
    fn pin_message(&self, room_id: &str, message_id: &str, pinned: bool) -> ApiResult<Message>;
    /// Replace a message's body: an edit (`edited`, which stamps
    /// `edited_at`), or a reply still streaming in or a progress update.
    fn update_message(
        &self,
        room_id: &str,
        message_id: &str,
        body: &Value,
        edited: bool,
    ) -> ApiResult<Message>;

    /// Read up to `seq` (never back, never past the newest message);
    /// whether it moved.
    fn mark_read(&self, room_id: &str, user: &str, seq: i64) -> ApiResult<bool>;
    /// Start (`true`) or stop waiting for the user's reply in a room;
    /// whether it changed.
    #[allow(dead_code, reason = "questions in rooms start in plans 05 to 07")]
    fn set_waiting(&self, room_id: &str, user: &str, waiting: bool) -> ApiResult<bool>;
}

impl RoomStore for Connection {
    fn list_rooms(&self, user: &str, archived: bool) -> ApiResult<Vec<RoomView>> {
        let filter = if archived {
            ""
        } else {
            " WHERE r.archived_at IS NULL"
        };
        let mut statement = self.prepare(&format!(
            "{ROOM_VIEW_SELECT}{filter} ORDER BY r.last_activity_at DESC, r.created_at DESC"
        ))?;
        let rows = statement.query_map([user], room_view)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn get_room(&self, room_id: &str) -> ApiResult<Room> {
        self.query_row("SELECT * FROM rooms WHERE id=?", [room_id], Room::from_row)
            .optional()?
            .ok_or_else(room_not_found)
    }

    fn room_view(&self, room_id: &str, user: &str) -> ApiResult<RoomView> {
        self.query_row(
            &format!("{ROOM_VIEW_SELECT} WHERE r.id = ?2"),
            [user, room_id],
            room_view,
        )
        .optional()?
        .ok_or_else(room_not_found)
    }

    fn create_room(&self, name: &str) -> ApiResult<Room> {
        let name = room_name(name)?;
        let id = new_id("room");
        let stamp = now_ms();
        self.execute(
            "INSERT INTO rooms (id,name,kind,created_at,last_activity_at) VALUES (?1,?2,'topic',?3,?3)",
            params![id, name, stamp],
        )?;
        self.get_room(&id)
    }

    fn update_room(&self, room_id: &str, patch: &RoomPatch) -> ApiResult<Room> {
        atomic(self, |tx| {
            let room = tx.get_room(room_id)?;
            if let Some(name) = &patch.name {
                tx.execute(
                    "UPDATE rooms SET name=? WHERE id=?",
                    params![room_name(name)?, room_id],
                )?;
            }
            match patch.archived {
                Some(true) if room.kind == "general" => {
                    return Err(conflict("#general cannot be archived"));
                }
                Some(true) => {
                    tx.execute(
                        "UPDATE rooms SET archived_at=COALESCE(archived_at, ?) WHERE id=?",
                        params![now_ms(), room_id],
                    )?;
                }
                Some(false) => {
                    tx.execute("UPDATE rooms SET archived_at=NULL WHERE id=?", [room_id])?;
                }
                None => {}
            }
            if let Some(scope) = &patch.source_scope {
                let scope = (!scope.is_null()).then(|| scope.to_string());
                tx.execute(
                    "UPDATE rooms SET source_scope_json=? WHERE id=?",
                    params![scope, room_id],
                )?;
            }
            tx.get_room(room_id)
        })
    }

    fn move_room(&self, from: &str, to: &str) -> ApiResult<Moved> {
        atomic(self, |tx| {
            if from == to {
                return Err(ApiError::new(
                    400,
                    "invalid_input",
                    "A room cannot move into itself",
                ));
            }
            let source = tx.get_room(from)?;
            let target = tx.get_room(to)?;
            if source.archived_at.is_some() || target.archived_at.is_some() {
                return Err(conflict("Archived rooms take no moves"));
            }
            let from_line = tx.post_message(
                from,
                Speaker::Face(HOST_FACE_ID),
                MessageKind::Line,
                &json!({
                    "text": format!("Continued in #{}", target.name),
                    "move": { "direction": "to", "roomId": target.id, "roomName": target.name },
                }),
            )?;
            let to_line = tx.post_message(
                to,
                Speaker::Face(HOST_FACE_ID),
                MessageKind::Line,
                &json!({
                    "text": format!("Continued from #{}", source.name),
                    "move": { "direction": "from", "roomId": source.id, "roomName": source.name },
                }),
            )?;
            tx.execute(
                "UPDATE rooms SET moved_to_room_id=? WHERE id=?",
                params![to, from],
            )?;
            tx.execute(
                "UPDATE rooms SET moved_from_room_id=? WHERE id=?",
                params![from, to],
            )?;
            Ok(Moved {
                from: tx.get_room(from)?,
                to: tx.get_room(to)?,
                from_line,
                to_line,
            })
        })
    }

    fn post_message(
        &self,
        room_id: &str,
        speaker: Speaker<'_>,
        kind: MessageKind,
        body: &Value,
    ) -> ApiResult<Message> {
        atomic(self, |tx| {
            let room = tx.get_room(room_id)?;
            if room.archived_at.is_some() {
                return Err(conflict("This room is archived"));
            }
            let (speaker_value, user) = match speaker {
                Speaker::User(user) => (USER_SPEAKER.to_owned(), Some(user)),
                Speaker::Face(face) => (format!("face:{face}"), None),
            };
            let id = new_id("msg");
            let seq = room.last_seq + 1;
            let stamp = now_ms();
            tx.execute(
                "INSERT INTO room_messages (id,room_id,seq,speaker,user,kind,body_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
                params![id, room_id, seq, speaker_value, user, kind.as_str(), body.to_string(), stamp],
            )?;
            tx.execute(
                "UPDATE rooms SET next_seq=?, last_activity_at=? WHERE id=?",
                params![seq + 1, stamp, room_id],
            )?;
            if let Some(user) = user {
                // Your own message is read, and it answers what waited for you.
                tx.execute(
                    "INSERT INTO room_reads (room_id,user,last_seq) VALUES (?1,?2,?3)
                     ON CONFLICT(room_id,user) DO UPDATE SET last_seq=MAX(last_seq, excluded.last_seq), waiting_since=NULL",
                    params![room_id, user, seq],
                )?;
            }
            tx.get_message(room_id, &id)
        })
    }

    fn get_message(&self, room_id: &str, message_id: &str) -> ApiResult<Message> {
        self.query_row(
            "SELECT * FROM room_messages WHERE id=? AND room_id=?",
            [message_id, room_id],
            Message::from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Message not found"))
    }

    fn list_messages(
        &self,
        room_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> ApiResult<Vec<Message>> {
        self.get_room(room_id)?;
        let limit = limit.clamp(1, MAX_MESSAGE_PAGE) as i64;
        let mut statement = self.prepare(
            "SELECT * FROM (SELECT * FROM room_messages WHERE room_id=?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3) ORDER BY seq",
        )?;
        let rows = statement.query_map(
            params![room_id, before.unwrap_or(i64::MAX), limit],
            Message::from_row,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn pinned_messages(&self, room_id: &str) -> ApiResult<Vec<Message>> {
        self.get_room(room_id)?;
        let mut statement = self.prepare(
            "SELECT * FROM room_messages WHERE room_id=? AND pinned_at IS NOT NULL ORDER BY pinned_at, seq",
        )?;
        let rows = statement.query_map([room_id], Message::from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn pin_message(&self, room_id: &str, message_id: &str, pinned: bool) -> ApiResult<Message> {
        self.get_message(room_id, message_id)?;
        let stamp = pinned.then(now_ms);
        self.execute(
            "UPDATE room_messages SET pinned_at=CASE WHEN ?1 IS NULL THEN NULL ELSE COALESCE(pinned_at, ?1) END WHERE id=?2",
            params![stamp, message_id],
        )?;
        self.get_message(room_id, message_id)
    }

    fn update_message(
        &self,
        room_id: &str,
        message_id: &str,
        body: &Value,
        edited: bool,
    ) -> ApiResult<Message> {
        self.get_message(room_id, message_id)?;
        self.execute(
            "UPDATE room_messages SET body_json=?1, edited_at=CASE WHEN ?2 THEN ?3 ELSE edited_at END WHERE id=?4",
            params![body.to_string(), edited, now_ms(), message_id],
        )?;
        self.get_message(room_id, message_id)
    }

    fn mark_read(&self, room_id: &str, user: &str, seq: i64) -> ApiResult<bool> {
        atomic(self, |tx| {
            let room = tx.get_room(room_id)?;
            let seq = seq.clamp(0, room.last_seq);
            let changed = tx.execute(
                "INSERT INTO room_reads (room_id,user,last_seq) VALUES (?1,?2,?3)
                 ON CONFLICT(room_id,user) DO UPDATE SET last_seq=excluded.last_seq WHERE excluded.last_seq > last_seq",
                params![room_id, user, seq],
            )?;
            // A first read of 0 records the row but moves nothing.
            Ok(changed > 0 && seq > 0)
        })
    }

    fn set_waiting(&self, room_id: &str, user: &str, waiting: bool) -> ApiResult<bool> {
        self.get_room(room_id)?;
        let changed = if waiting {
            self.execute(
                "INSERT INTO room_reads (room_id,user,last_seq,waiting_since) VALUES (?1,?2,0,?3)
                 ON CONFLICT(room_id,user) DO UPDATE SET waiting_since=excluded.waiting_since WHERE waiting_since IS NULL",
                params![room_id, user, now_ms()],
            )?
        } else {
            self.execute(
                "UPDATE room_reads SET waiting_since=NULL WHERE room_id=? AND user=? AND waiting_since IS NOT NULL",
                [room_id, user],
            )?
        };
        Ok(changed > 0)
    }
}

// ---- uploads and pending input ------------------------------------------------

/// A file sent into a room.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub id: String,
    pub room_id: String,
    pub user: String,
    /// `image` or `file`.
    pub kind: String,
    pub filename: Option<String>,
    pub mime_type: String,
    pub byte_size: i64,
    pub sha256: String,
    #[serde(skip)]
    pub storage_name: String,
    pub message_id: Option<String>,
    pub created_at: i64,
}

impl Upload {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            user: row.get("user")?,
            kind: row.get("kind")?,
            filename: row.get("filename")?,
            mime_type: row.get("mime_type")?,
            byte_size: row.get("byte_size")?,
            sha256: row.get("sha256")?,
            storage_name: row.get("storage_name")?,
            message_id: row.get("message_id")?,
            created_at: row.get("created_at")?,
        })
    }

    /// How a message carries it.
    pub fn attachment(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "filename": self.filename,
            "mimeType": self.mime_type,
            "byteSize": self.byte_size,
        })
    }
}

/// A user's messages in a room not yet handed to the brain (decision #16).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub room_id: String,
    pub user: String,
    /// In send order.
    pub message_ids: Vec<String>,
    pub first_at: i64,
    pub last_at: i64,
    /// One of them was sent with "send now": no debounce.
    pub immediate: bool,
}

impl Pending {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            room_id: row.get("room_id")?,
            user: row.get("user")?,
            message_ids: serde_json::from_str(&row.get::<_, String>("message_ids_json")?)
                .unwrap_or_default(),
            first_at: row.get("first_at")?,
            last_at: row.get("last_at")?,
            immediate: row.get::<_, i64>("immediate")? != 0,
        })
    }
}

pub trait RoomInputStore {
    fn create_upload(&self, upload: &Upload) -> ApiResult<()>;
    /// 404 "Upload not found" unless it is in `room_id`.
    fn get_upload(&self, room_id: &str, upload_id: &str) -> ApiResult<Upload>;
    /// The uploads attached to messages of `room_id`, in the order their
    /// messages were sent (a delegation hands on the files of the request
    /// it answers).
    fn message_uploads(&self, room_id: &str, message_ids: &[String]) -> ApiResult<Vec<Upload>>;
    /// 404 "Upload not found" unless `upload_id` is attached to a message of
    /// `room_id`: an upload nobody sent yet stays its sender's.
    fn attached_upload(&self, room_id: &str, upload_id: &str) -> ApiResult<Upload>;
    /// Give `user`'s unsent uploads in `room_id` to a message, in the order
    /// given; 400 for any that is not one.
    fn attach_uploads(
        &self,
        room_id: &str,
        user: &str,
        upload_ids: &[String],
        message_id: &str,
    ) -> ApiResult<Vec<Upload>>;

    /// Add a sent message to the user's pending input in the room.
    fn add_pending(
        &self,
        room_id: &str,
        user: &str,
        message_id: &str,
        immediate: bool,
    ) -> ApiResult<Pending>;
    /// Everyone's pending input, oldest first (the brain's scheduler reads
    /// it, and finds it again after a restart).
    fn list_pending(&self) -> ApiResult<Vec<Pending>>;
    /// The brain took `message_ids` (they are in its conversation): they
    /// leave the user's pending input in the room, and the row goes when
    /// nothing is left. Messages sent meanwhile stay, without "send now".
    fn consume_pending(&self, room_id: &str, user: &str, message_ids: &[String]) -> ApiResult<()>;

    /// A user's message, in one transaction: stored with its attachments
    /// (`{text, attachments?}`) and added to their pending input.
    fn send_user_message(
        &self,
        room_id: &str,
        user: &str,
        text: &str,
        upload_ids: &[String],
        immediate: bool,
    ) -> ApiResult<Message>;
}

impl RoomInputStore for Connection {
    fn create_upload(&self, upload: &Upload) -> ApiResult<()> {
        self.execute(
            "INSERT INTO room_uploads (id,room_id,user,kind,filename,mime_type,byte_size,sha256,storage_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![
                upload.id,
                upload.room_id,
                upload.user,
                upload.kind,
                upload.filename,
                upload.mime_type,
                upload.byte_size,
                upload.sha256,
                upload.storage_name,
                upload.created_at
            ],
        )?;
        Ok(())
    }

    fn get_upload(&self, room_id: &str, upload_id: &str) -> ApiResult<Upload> {
        self.query_row(
            "SELECT * FROM room_uploads WHERE id=? AND room_id=?",
            [upload_id, room_id],
            Upload::from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Upload not found"))
    }

    fn message_uploads(&self, room_id: &str, message_ids: &[String]) -> ApiResult<Vec<Upload>> {
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.prepare(
            "SELECT uploads.* FROM room_uploads uploads
             JOIN room_messages messages ON messages.id = uploads.message_id
             WHERE uploads.room_id=?1 AND messages.room_id=?1
               AND uploads.message_id IN (SELECT value FROM json_each(?2))
             ORDER BY messages.seq, uploads.created_at, uploads.id",
        )?;
        let rows = statement.query_map(
            params![room_id, json!(message_ids).to_string()],
            Upload::from_row,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn attached_upload(&self, room_id: &str, upload_id: &str) -> ApiResult<Upload> {
        self.query_row(
            "SELECT * FROM room_uploads WHERE id=? AND room_id=? AND message_id IS NOT NULL",
            [upload_id, room_id],
            Upload::from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Upload not found"))
    }

    fn attach_uploads(
        &self,
        room_id: &str,
        user: &str,
        upload_ids: &[String],
        message_id: &str,
    ) -> ApiResult<Vec<Upload>> {
        atomic(self, |tx| {
            let mut uploads = Vec::with_capacity(upload_ids.len());
            for id in upload_ids {
                let changed = tx.execute(
                    "UPDATE room_uploads SET message_id=?1 WHERE id=?2 AND room_id=?3 AND user=?4 AND message_id IS NULL",
                    params![message_id, id, room_id, user],
                )?;
                if changed == 0 {
                    return Err(ApiError::new(
                        400,
                        "invalid_input",
                        "An attachment is not an unsent upload of yours in this room",
                    ));
                }
                uploads.push(tx.get_upload(room_id, id)?);
            }
            Ok(uploads)
        })
    }

    fn add_pending(
        &self,
        room_id: &str,
        user: &str,
        message_id: &str,
        immediate: bool,
    ) -> ApiResult<Pending> {
        let stamp = now_ms();
        self.execute(
            "INSERT INTO room_pending (room_id,user,message_ids_json,first_at,last_at,immediate) VALUES (?1,?2,json_array(?3),?4,?4,?5)
             ON CONFLICT(room_id,user) DO UPDATE SET message_ids_json=json_insert(message_ids_json,'$[#]',?3),
               last_at=excluded.last_at, immediate=MAX(immediate, excluded.immediate)",
            params![room_id, user, message_id, stamp, i64::from(immediate)],
        )?;
        Ok(self.query_row(
            "SELECT * FROM room_pending WHERE room_id=? AND user=?",
            [room_id, user],
            Pending::from_row,
        )?)
    }

    fn list_pending(&self) -> ApiResult<Vec<Pending>> {
        let mut statement = self.prepare("SELECT * FROM room_pending ORDER BY first_at")?;
        let rows = statement.query_map([], Pending::from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn consume_pending(&self, room_id: &str, user: &str, message_ids: &[String]) -> ApiResult<()> {
        atomic(self, |tx| {
            let Some(pending) = tx
                .query_row(
                    "SELECT * FROM room_pending WHERE room_id=? AND user=?",
                    [room_id, user],
                    Pending::from_row,
                )
                .optional()?
            else {
                return Ok(());
            };
            let left: Vec<&String> = pending
                .message_ids
                .iter()
                .filter(|id| !message_ids.contains(id))
                .collect();
            if left.is_empty() {
                tx.execute(
                    "DELETE FROM room_pending WHERE room_id=? AND user=?",
                    [room_id, user],
                )?;
            } else if left.len() < pending.message_ids.len() {
                tx.execute(
                    "UPDATE room_pending SET message_ids_json=?, immediate=0 WHERE room_id=? AND user=?",
                    params![serde_json::to_string(&left).unwrap_or_default(), room_id, user],
                )?;
            }
            Ok(())
        })
    }

    fn send_user_message(
        &self,
        room_id: &str,
        user: &str,
        text: &str,
        upload_ids: &[String],
        immediate: bool,
    ) -> ApiResult<Message> {
        atomic(self, |tx| {
            let message = tx.post_message(
                room_id,
                Speaker::User(user),
                MessageKind::Text,
                &json!({ "text": text }),
            )?;
            if !upload_ids.is_empty() {
                let uploads = tx.attach_uploads(room_id, user, upload_ids, &message.id)?;
                let attachments: Vec<Value> = uploads.iter().map(Upload::attachment).collect();
                // Part of sending, not an edit.
                tx.execute(
                    "UPDATE room_messages SET body_json=? WHERE id=?",
                    params![
                        json!({ "text": text, "attachments": attachments }).to_string(),
                        message.id
                    ],
                )?;
            }
            tx.add_pending(room_id, user, &message.id, immediate)?;
            tx.get_message(room_id, &message.id)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn pending_input_accumulates_until_taken() {
        let db = Db::memory();
        let conn = db.lock();
        let ids: Vec<String> = ["one", "two", "three"]
            .iter()
            .map(|text| say(&conn, GENERAL_ROOM_ID, "u", text).id)
            .collect();
        let first = conn
            .add_pending(GENERAL_ROOM_ID, "u", &ids[0], false)
            .unwrap();
        assert_eq!((first.message_ids.len(), first.immediate), (1, false));
        conn.add_pending(GENERAL_ROOM_ID, "u", &ids[1], true)
            .unwrap();
        let last = conn
            .add_pending(GENERAL_ROOM_ID, "u", &ids[2], false)
            .unwrap();
        assert_eq!(last.message_ids, ids);
        assert!(last.immediate, "send-now sticks to the batch");
        assert_eq!(last.first_at, first.first_at);
        conn.add_pending(GENERAL_ROOM_ID, "v", &ids[0], false)
            .unwrap();
        assert_eq!(conn.list_pending().unwrap().len(), 2);
        // The brain took the first two; the third waits, without "send now".
        conn.consume_pending(GENERAL_ROOM_ID, "u", &ids[..2])
            .unwrap();
        let left = conn.list_pending().unwrap();
        let mine = left.iter().find(|pending| pending.user == "u").unwrap();
        assert_eq!(
            (mine.message_ids.as_slice(), mine.immediate),
            (&ids[2..], false)
        );
        conn.consume_pending(GENERAL_ROOM_ID, "u", &ids[2..])
            .unwrap();
        conn.consume_pending(GENERAL_ROOM_ID, "u", &ids[2..])
            .unwrap();
        assert_eq!(conn.list_pending().unwrap().len(), 1);
    }

    #[test]
    fn uploads_attach_once_to_their_room_and_sender() {
        let db = Db::memory();
        let conn = db.lock();
        let upload = |id: &str, user: &str| Upload {
            id: id.into(),
            room_id: GENERAL_ROOM_ID.into(),
            user: user.into(),
            kind: "file".into(),
            filename: Some("a.txt".into()),
            mime_type: "text/plain".into(),
            byte_size: 1,
            sha256: "h".into(),
            storage_name: format!("{id}.bin"),
            message_id: None,
            created_at: 0,
        };
        conn.create_upload(&upload("up1", "u")).unwrap();
        conn.create_upload(&upload("up2", "v")).unwrap();
        let message = say(&conn, GENERAL_ROOM_ID, "u", "see");
        let other = conn.create_room("other").unwrap();
        assert_eq!(
            conn.get_upload(&other.id, "up1").unwrap_err().code,
            "not_found"
        );
        // Someone else's upload, and nothing changes.
        assert!(
            conn.attach_uploads(
                GENERAL_ROOM_ID,
                "u",
                &["up1".into(), "up2".into()],
                &message.id
            )
            .is_err()
        );
        assert_eq!(
            conn.get_upload(GENERAL_ROOM_ID, "up1").unwrap().message_id,
            None
        );
        let attached = conn
            .attach_uploads(GENERAL_ROOM_ID, "u", &["up1".into()], &message.id)
            .unwrap();
        assert_eq!(attached[0].message_id.as_deref(), Some(message.id.as_str()));
        assert_eq!(attached[0].attachment()["filename"], "a.txt");
        assert!(
            conn.attach_uploads(GENERAL_ROOM_ID, "u", &["up1".into()], &message.id)
                .is_err(),
            "once"
        );
    }

    #[test]
    fn a_room_message_hands_its_uploads_on_but_never_an_unsent_one() {
        let db = Db::memory();
        let conn = db.lock();
        let upload = |id: &str, user: &str| Upload {
            id: id.into(),
            room_id: GENERAL_ROOM_ID.into(),
            user: user.into(),
            kind: "file".into(),
            filename: Some("rooms.html".into()),
            mime_type: "text/html".into(),
            byte_size: 1,
            sha256: "h".into(),
            storage_name: format!("{id}.bin"),
            message_id: None,
            created_at: 0,
        };
        let first = say(&conn, GENERAL_ROOM_ID, "u", "one");
        let second = say(&conn, GENERAL_ROOM_ID, "v", "two");
        for (id, user) in [("up1", "u"), ("up2", "v"), ("up3", "u")] {
            conn.create_upload(&upload(id, user)).unwrap();
        }
        conn.attach_uploads(GENERAL_ROOM_ID, "u", &["up1".into()], &first.id)
            .unwrap();
        conn.attach_uploads(GENERAL_ROOM_ID, "v", &["up2".into()], &second.id)
            .unwrap();
        // Asked for in the order the messages came, whichever order they are named in.
        let found = conn
            .message_uploads(GENERAL_ROOM_ID, &[second.id.clone(), first.id.clone()])
            .unwrap();
        assert_eq!(
            found
                .iter()
                .map(|upload| upload.id.as_str())
                .collect::<Vec<_>>(),
            ["up1", "up2"]
        );
        assert_eq!(
            conn.attached_upload(GENERAL_ROOM_ID, "up1")
                .unwrap()
                .message_id
                .as_deref(),
            Some(first.id.as_str())
        );
        // Nobody sent up3 yet: it is still its sender's, and another room has none of these.
        assert_eq!(
            conn.attached_upload(GENERAL_ROOM_ID, "up3")
                .unwrap_err()
                .status,
            404
        );
        let other = conn.create_room("other").unwrap();
        assert_eq!(
            conn.attached_upload(&other.id, "up1").unwrap_err().status,
            404
        );
        assert!(
            conn.message_uploads(&other.id, &[first.id, second.id])
                .unwrap()
                .is_empty()
        );
    }

    fn say(conn: &Connection, room: &str, user: &str, text: &str) -> Message {
        conn.post_message(
            room,
            Speaker::User(user),
            MessageKind::Text,
            &json!({ "text": text }),
        )
        .unwrap()
    }

    #[test]
    fn general_is_seeded_once_and_never_archived() {
        let db = Db::memory();
        let conn = db.lock();
        let rooms = conn.list_rooms("u", true).unwrap();
        assert_eq!(rooms.len(), 1);
        assert_eq!(
            (rooms[0].room.id.as_str(), rooms[0].room.kind.as_str()),
            (GENERAL_ROOM_ID, "general")
        );
        let archive = RoomPatch {
            archived: Some(true),
            ..RoomPatch::default()
        };
        assert_eq!(
            conn.update_room(GENERAL_ROOM_ID, &archive)
                .unwrap_err()
                .code,
            "conflict"
        );
        // Not even behind the store's back.
        assert!(
            conn.execute(
                "INSERT INTO rooms (id,name,kind,created_at,last_activity_at) VALUES ('g2','g','general',0,0)",
                [],
            )
            .is_err()
        );
        assert!(
            conn.execute("UPDATE rooms SET archived_at=1 WHERE id='general'", [])
                .is_err()
        );
        let host: String = conn
            .query_row("SELECT name FROM faces WHERE id='host'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(host, "pirc");
    }

    #[test]
    fn names() {
        assert_eq!(room_name("  #SlimeOS討論區 ").unwrap(), "SlimeOS討論區");
        for bad in ["", " # ", "a\nb", &"x".repeat(MAX_ROOM_NAME_CHARS + 1)] {
            assert_eq!(room_name(bad).unwrap_err().code, "invalid_input", "{bad:?}");
        }
        assert!(room_name(&"字".repeat(MAX_ROOM_NAME_CHARS)).is_ok());
    }

    #[test]
    fn messages_unread_and_activity_order() {
        let db = Db::memory();
        let conn = db.lock();
        let topic = conn.create_room("topic").unwrap();
        assert_eq!(topic.kind, "topic");
        let first = say(&conn, GENERAL_ROOM_ID, "u", "one");
        let second = say(&conn, GENERAL_ROOM_ID, "u", "two");
        assert_eq!((first.seq, second.seq), (1, 2));
        assert_eq!(first.speaker, "user");
        assert_eq!(first.user.as_deref(), Some("u"));
        // Your own messages are read; others' are not.
        let general = |user: &str| conn.room_view(GENERAL_ROOM_ID, user).unwrap();
        assert_eq!((general("u").unread, general("u").read_seq), (0, 2));
        assert_eq!((general("v").unread, general("v").read_seq), (2, 0));
        let reply = conn
            .post_message(
                GENERAL_ROOM_ID,
                Speaker::Face(HOST_FACE_ID),
                MessageKind::Text,
                &json!({ "text": "hi" }),
            )
            .unwrap();
        assert_eq!((reply.speaker.as_str(), reply.user), ("face:host", None));
        assert_eq!(general("u").unread, 1);
        assert!(conn.mark_read(GENERAL_ROOM_ID, "u", 99).unwrap());
        assert_eq!(general("u").read_seq, 3, "clamped to the newest message");
        assert!(
            !conn.mark_read(GENERAL_ROOM_ID, "u", 1).unwrap(),
            "never back"
        );
        assert!(!conn.mark_read(topic.id.as_str(), "u", 0).unwrap());
        // The busiest room first.
        say(&conn, &topic.id, "u", "later");
        let order: Vec<String> = conn
            .list_rooms("u", false)
            .unwrap()
            .into_iter()
            .map(|view| view.room.id)
            .collect();
        assert_eq!(order[0], topic.id);

        // Pages: newest first by `before`, each oldest first.
        for n in 0..5 {
            say(&conn, &topic.id, "u", &format!("m{n}"));
        }
        let page = conn.list_messages(&topic.id, None, 2).unwrap();
        assert_eq!(page.iter().map(|m| m.seq).collect::<Vec<_>>(), [5, 6]);
        let older = conn.list_messages(&topic.id, Some(5), 10).unwrap();
        assert_eq!(
            older.iter().map(|m| m.seq).collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(
            conn.list_messages("nope", None, 1).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn archive_hides_and_keeps() {
        let db = Db::memory();
        let conn = db.lock();
        let room = conn.create_room("old").unwrap();
        let message = say(&conn, &room.id, "u", "keep me");
        let archived = conn
            .update_room(
                &room.id,
                &RoomPatch {
                    archived: Some(true),
                    ..RoomPatch::default()
                },
            )
            .unwrap();
        assert!(archived.archived_at.is_some());
        let listed = |archived: bool| -> Vec<String> {
            conn.list_rooms("u", archived)
                .unwrap()
                .into_iter()
                .map(|view| view.room.id)
                .collect()
        };
        assert!(!listed(false).contains(&room.id));
        assert!(listed(true).contains(&room.id));
        // Still readable; takes nothing new.
        assert_eq!(
            conn.list_messages(&room.id, None, 10).unwrap(),
            std::slice::from_ref(&message)
        );
        assert_eq!(
            conn.post_message(&room.id, Speaker::User("u"), MessageKind::Text, &json!({}))
                .unwrap_err()
                .code,
            "conflict"
        );
        let back = conn
            .update_room(
                &room.id,
                &RoomPatch {
                    archived: Some(false),
                    name: Some("#renamed".into()),
                    source_scope: Some(json!({ "sources": ["mail"] })),
                },
            )
            .unwrap();
        assert_eq!((back.archived_at, back.name.as_str()), (None, "renamed"));
        assert_eq!(back.source_scope, Some(json!({ "sources": ["mail"] })));
        let cleared = conn
            .update_room(
                &room.id,
                &RoomPatch {
                    source_scope: Some(Value::Null),
                    ..RoomPatch::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.source_scope, None);
    }

    #[test]
    fn a_move_writes_two_lines() {
        let db = Db::memory();
        let conn = db.lock();
        let target = conn.create_room("SlimeOS討論區").unwrap();
        say(&conn, GENERAL_ROOM_ID, "u", "SlimeOS again");
        let moved = conn.move_room(GENERAL_ROOM_ID, &target.id).unwrap();
        assert_eq!(moved.from_line.kind, "line");
        assert_eq!(moved.from_line.seq, 2);
        assert_eq!(moved.from_line.body["text"], "Continued in #SlimeOS討論區");
        assert_eq!(moved.from_line.body["move"]["roomId"], target.id.as_str());
        assert_eq!(moved.to_line.seq, 1, "the new room starts with it");
        assert_eq!(moved.to_line.body["text"], "Continued from #general");
        assert_eq!(
            moved.from.moved_to_room_id.as_deref(),
            Some(target.id.as_str())
        );
        assert_eq!(
            moved.to.moved_from_room_id.as_deref(),
            Some(GENERAL_ROOM_ID)
        );
        assert_eq!(
            conn.move_room(&target.id, &target.id).unwrap_err().code,
            "invalid_input"
        );
        assert_eq!(
            conn.move_room(&target.id, "nope").unwrap_err().code,
            "not_found"
        );
        // A failed move writes nothing.
        assert_eq!(conn.get_room(&target.id).unwrap().last_seq, 1);
    }

    #[test]
    fn pins_edits_and_waiting() {
        let db = Db::memory();
        let conn = db.lock();
        let message = say(&conn, GENERAL_ROOM_ID, "u", "pin me");
        let pinned = conn
            .pin_message(GENERAL_ROOM_ID, &message.id, true)
            .unwrap();
        let again = conn
            .pin_message(GENERAL_ROOM_ID, &message.id, true)
            .unwrap();
        assert!(pinned.pinned_at.is_some());
        assert_eq!(
            again.pinned_at, pinned.pinned_at,
            "pinning twice keeps the time"
        );
        assert_eq!(conn.pinned_messages(GENERAL_ROOM_ID).unwrap().len(), 1);
        let room = conn.create_room("other").unwrap();
        assert_eq!(
            conn.pin_message(&room.id, &message.id, true)
                .unwrap_err()
                .code,
            "not_found",
            "a message is pinned in its own room"
        );
        assert!(
            conn.pin_message(GENERAL_ROOM_ID, &message.id, false)
                .unwrap()
                .pinned_at
                .is_none()
        );
        let streamed = conn
            .update_message(
                GENERAL_ROOM_ID,
                &message.id,
                &json!({ "text": "stream" }),
                false,
            )
            .unwrap();
        assert_eq!(
            (streamed.body["text"].as_str(), streamed.edited_at),
            (Some("stream"), None),
            "a streaming reply is not an edit"
        );
        let edited = conn
            .update_message(
                GENERAL_ROOM_ID,
                &message.id,
                &json!({ "text": "edited" }),
                true,
            )
            .unwrap();
        assert!(edited.edited_at.is_some());
        assert_eq!(edited.body["text"], "edited");

        assert!(conn.set_waiting(&room.id, "u", true).unwrap());
        assert!(!conn.set_waiting(&room.id, "u", true).unwrap());
        assert!(conn.room_view(&room.id, "u").unwrap().waiting);
        assert!(!conn.room_view(&room.id, "v").unwrap().waiting);
        // Replying answers it.
        say(&conn, &room.id, "u", "here");
        assert!(!conn.room_view(&room.id, "u").unwrap().waiting);
        assert!(!conn.set_waiting(&room.id, "u", false).unwrap());
    }
}
