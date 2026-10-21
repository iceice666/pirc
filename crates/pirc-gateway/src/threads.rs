//! Threads under a room message (plans/rewrite/06-workers.md): what a
//! worker does, its team's talk and its questions, kept apart from the
//! room's conversation. A thread hangs under the message that handed the
//! work out (its anchor); its messages are numbered 1, 2, ... within it.
//!
//! Thread events go out on the room stream (`/api/events?rooms=1`), so a
//! client that follows a room follows its threads: `thread_message` and
//! `thread_message_updated` carry `{threadId, message}`.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::app::App;
use crate::db::atomic;
use crate::db::rooms::RoomStore;
use crate::error::{ApiError, ApiResult};
use crate::util::{new_id, now_ms, safe_json};

/// Messages per page of [`list`].
pub const MAX_PAGE: usize = 500;
/// A thread keeps at most this many messages; past it, what workers do is
/// no longer written down (their questions and results still are).
pub const MAX_MESSAGES: i64 = 2000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub room_id: String,
    pub anchor_message_id: String,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

impl Thread {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            anchor_message_id: row.get("anchor_message_id")?,
            created_at: row.get("created_at")?,
            closed_at: row.get("closed_at")?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: String,
    pub thread_id: String,
    pub seq: i64,
    /// `worker:<session>`, `worker:<session>/<name>`, `user` or `face:<id>`.
    pub speaker: String,
    pub user: Option<String>,
    /// `text`, `line`, `tool` or `question`.
    pub kind: String,
    pub body: Value,
    /// 1: a teammate or subagent of the worker.
    pub depth: i64,
    pub created_at: i64,
    pub updated_at: Option<i64>,
}

impl ThreadMessage {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            thread_id: row.get("thread_id")?,
            seq: row.get("seq")?,
            speaker: row.get("speaker")?,
            user: row.get("user")?,
            kind: row.get("kind")?,
            body: safe_json(&row.get::<_, String>("body_json")?, json!({})),
            depth: row.get("depth")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// A new thread message.
pub struct NewMessage<'a> {
    pub speaker: &'a str,
    pub user: Option<&'a str>,
    pub kind: &'a str,
    pub body: Value,
    pub depth: i64,
}

/// A thread under `anchor_message_id`, which must be in `room_id`: the
/// message is marked as having it.
pub fn create(conn: &Connection, room_id: &str, anchor_message_id: &str) -> ApiResult<Thread> {
    atomic(conn, |tx| {
        tx.get_message(room_id, anchor_message_id)?;
        let id = new_id("thread");
        tx.execute(
            "INSERT INTO threads (id,room_id,anchor_message_id,created_at) VALUES (?,?,?,?)",
            params![id, room_id, anchor_message_id, now_ms()],
        )?;
        tx.execute(
            "UPDATE room_messages SET thread_id=? WHERE id=?",
            params![id, anchor_message_id],
        )?;
        get(tx, &id)
    })
}

/// 404 "Thread not found".
pub fn get(conn: &Connection, id: &str) -> ApiResult<Thread> {
    conn.query_row("SELECT * FROM threads WHERE id=?", [id], Thread::from_row)
        .optional()?
        .ok_or_else(|| ApiError::not_found("Thread not found"))
}

/// Add a message; `None` when the thread is full and this is only what a
/// worker did (`tool`).
pub fn post(
    conn: &Connection,
    thread_id: &str,
    message: &NewMessage<'_>,
) -> ApiResult<Option<ThreadMessage>> {
    atomic(conn, |tx| {
        get(tx, thread_id)?;
        let last: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM thread_messages WHERE thread_id=?",
            [thread_id],
            |row| row.get(0),
        )?;
        if last >= MAX_MESSAGES && message.kind == "tool" {
            return Ok(None);
        }
        let id = new_id("tmsg");
        tx.execute(
            "INSERT INTO thread_messages (id,thread_id,seq,speaker,user,kind,body_json,depth,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            params![
                id,
                thread_id,
                last + 1,
                message.speaker,
                message.user,
                message.kind,
                message.body.to_string(),
                message.depth,
                now_ms()
            ],
        )?;
        message_by_id(tx, &id).map(Some)
    })
}

fn message_by_id(conn: &Connection, id: &str) -> ApiResult<ThreadMessage> {
    conn.query_row(
        "SELECT * FROM thread_messages WHERE id=?",
        [id],
        ThreadMessage::from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::not_found("Message not found"))
}

/// Replace a message's body (a question answered).
pub fn update(conn: &Connection, id: &str, body: &Value) -> ApiResult<ThreadMessage> {
    conn.execute(
        "UPDATE thread_messages SET body_json=?, updated_at=? WHERE id=?",
        params![body.to_string(), now_ms(), id],
    )?;
    message_by_id(conn, id)
}

/// Messages after `after` (a seq), oldest first.
pub fn list(
    conn: &Connection,
    thread_id: &str,
    after: i64,
    limit: usize,
) -> ApiResult<Vec<ThreadMessage>> {
    let mut statement = conn.prepare(
        "SELECT * FROM thread_messages WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?",
    )?;
    let rows = statement.query_map(
        params![thread_id, after, limit as i64],
        ThreadMessage::from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The pending question about `interaction_id` in a thread, if any.
pub fn question(
    conn: &Connection,
    thread_id: &str,
    interaction_id: &str,
) -> ApiResult<Option<ThreadMessage>> {
    Ok(conn
        .query_row(
            "SELECT * FROM thread_messages WHERE thread_id=? AND kind='question' AND json_extract(body_json,'$.interactionId')=? ORDER BY seq DESC LIMIT 1",
            params![thread_id, interaction_id],
            ThreadMessage::from_row,
        )
        .optional()?)
}

/// The latest question about `interaction_id` in any thread.
pub fn question_anywhere(
    conn: &Connection,
    interaction_id: &str,
) -> ApiResult<Option<ThreadMessage>> {
    Ok(conn
        .query_row(
            "SELECT * FROM thread_messages WHERE kind='question' AND json_extract(body_json,'$.interactionId')=? ORDER BY created_at DESC, seq DESC LIMIT 1",
            [interaction_id],
            ThreadMessage::from_row,
        )
        .optional()?)
}

/// Questions still waiting for an answer, in every thread, newest first.
pub fn pending_questions(conn: &Connection, limit: usize) -> ApiResult<Vec<ThreadMessage>> {
    let mut statement = conn.prepare(
        "SELECT * FROM thread_messages WHERE kind='question' AND json_extract(body_json,'$.status')='pending' ORDER BY created_at DESC LIMIT ?",
    )?;
    let rows = statement.query_map([limit as i64], ThreadMessage::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The distinct speakers of a thread that are workers (`worker:...`).
pub fn workers(conn: &Connection, thread_id: &str) -> ApiResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT speaker FROM thread_messages WHERE thread_id=? AND speaker LIKE 'worker:%' GROUP BY speaker ORDER BY MIN(seq)",
    )?;
    let rows = statement.query_map([thread_id], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

impl App {
    /// Post to a thread and tell the room; logged, not returned, on failure.
    pub fn thread_post(&self, thread_id: &str, message: &NewMessage<'_>) -> Option<ThreadMessage> {
        let posted = {
            let conn = self.db.lock();
            post(&conn, thread_id, message).and_then(|posted| Ok((posted, get(&conn, thread_id)?)))
        };
        match posted {
            Ok((Some(posted), thread)) => {
                self.rooms.publish(
                    &thread.room_id,
                    "thread_message",
                    json!({ "threadId": thread.id, "message": posted }),
                    None,
                );
                Some(posted)
            }
            Ok((None, _)) => None,
            Err(error) => {
                crate::log::warn(&format!(
                    "thread {thread_id}: cannot write: {}",
                    error.message
                ));
                None
            }
        }
    }

    /// A thread message changed (a question answered).
    pub fn thread_message_updated(&self, message: &ThreadMessage) {
        let Ok(thread) = get(&self.db.lock(), &message.thread_id) else {
            return;
        };
        self.rooms.publish(
            &thread.room_id,
            "thread_message_updated",
            json!({ "threadId": thread.id, "message": message }),
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::db::rooms::{GENERAL_ROOM_ID, HOST_FACE_ID, MessageKind, Speaker};

    #[test]
    fn a_thread_under_a_message_numbers_its_own() {
        let db = Db::memory();
        let conn = db.lock();
        let anchor = conn
            .post_message(
                GENERAL_ROOM_ID,
                Speaker::Face(HOST_FACE_ID),
                MessageKind::Text,
                &json!({ "text": "I asked a worker" }),
            )
            .unwrap();
        let thread = create(&conn, GENERAL_ROOM_ID, &anchor.id).unwrap();
        assert_eq!(
            conn.get_message(GENERAL_ROOM_ID, &anchor.id)
                .unwrap()
                .thread_id
                .as_deref(),
            Some(thread.id.as_str())
        );
        assert_eq!(
            create(&conn, GENERAL_ROOM_ID, "msg_none")
                .unwrap_err()
                .status,
            404
        );
        for (speaker, depth) in [("worker:s1", 0), ("worker:s1/ann", 1), ("worker:s1", 0)] {
            post(
                &conn,
                &thread.id,
                &NewMessage {
                    speaker,
                    user: None,
                    kind: "tool",
                    body: json!({ "tool": "bash" }),
                    depth,
                },
            )
            .unwrap()
            .unwrap();
        }
        let question = post(
            &conn,
            &thread.id,
            &NewMessage {
                speaker: "worker:s1",
                user: None,
                kind: "question",
                body: json!({ "interactionId": "i1", "status": "pending" }),
                depth: 0,
            },
        )
        .unwrap()
        .unwrap();
        let listed = list(&conn, &thread.id, 0, 10).unwrap();
        assert_eq!(
            listed.iter().map(|m| m.seq).collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(list(&conn, &thread.id, 3, 10).unwrap().len(), 1);
        assert_eq!(
            workers(&conn, &thread.id).unwrap(),
            ["worker:s1", "worker:s1/ann"]
        );
        assert_eq!(
            question_of(&conn, &thread.id, "i1"),
            Some(question.id.clone())
        );
        let answered = update(
            &conn,
            &question.id,
            &json!({ "interactionId": "i1", "status": "answered" }),
        )
        .unwrap();
        assert_eq!(answered.body["status"], "answered");
        assert!(answered.updated_at.is_some());
    }

    fn question_of(conn: &Connection, thread: &str, interaction: &str) -> Option<String> {
        question(conn, thread, interaction).unwrap().map(|m| m.id)
    }
}
