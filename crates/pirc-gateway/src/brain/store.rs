//! What the brain keeps: each room's conversation as a `pirc-agent`
//! session under `$PIRC_STATE_DIR/brain/rooms/<room>/` (never deleted;
//! archiving a room keeps it), and the `brain_turns` table the engine page
//! lists.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::ApiResult;
use crate::util::{new_id, now_ms, safe_json};

/// The brain's own state.
pub fn brain_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("brain")
}

/// A room's conversation with the brain. Room ids are `general` or
/// `room_<uuid>`, safe as one path component.
pub fn room_dir(state_dir: &Path, room_id: &str) -> PathBuf {
    brain_dir(state_dir).join("rooms").join(room_id)
}

/// How a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// The model failed (after the agent's own retries).
    Failed,
    Aborted,
    Timeout,
    /// A user turn took over (plan 05's wakes).
    #[allow(dead_code, reason = "wake turns start in plan 05")]
    Preempted,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
            Self::Timeout => "timeout",
            Self::Preempted => "preempted",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub room_id: String,
    /// `user` or `wake`.
    pub kind: String,
    pub message_ids: Vec<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: Option<String>,
    pub error: Option<String>,
    pub usage: Option<Value>,
}

impl Turn {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            room_id: row.get("room_id")?,
            kind: row.get("kind")?,
            message_ids: serde_json::from_str(&row.get::<_, String>("message_ids_json")?)
                .unwrap_or_default(),
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            outcome: row.get("outcome")?,
            error: row.get("error")?,
            usage: row
                .get::<_, Option<String>>("usage_json")?
                .map(|usage| safe_json(&usage, Value::Null)),
        })
    }
}

pub const MAX_TURN_PAGE: usize = 100;

pub trait TurnStore {
    fn start_turn(&self, room_id: &str, kind: &str, message_ids: &[String]) -> ApiResult<Turn>;
    /// Messages steered into a running turn.
    fn add_turn_messages(&self, turn_id: &str, message_ids: &[String]) -> ApiResult<()>;
    fn end_turn(
        &self,
        turn_id: &str,
        outcome: Outcome,
        error: Option<&str>,
        usage: &Value,
    ) -> ApiResult<Turn>;
    /// Turns still open when the gateway stopped: `interrupted`.
    fn close_open_turns(&self) -> ApiResult<usize>;
    /// A room's latest turns, newest first.
    fn list_turns(&self, room_id: &str, limit: usize) -> ApiResult<Vec<Turn>>;
}

impl TurnStore for Connection {
    fn start_turn(&self, room_id: &str, kind: &str, message_ids: &[String]) -> ApiResult<Turn> {
        let id = new_id("turn");
        self.execute(
            "INSERT INTO brain_turns (id,room_id,kind,message_ids_json,started_at) VALUES (?,?,?,?,?)",
            params![id, room_id, kind, json!(message_ids).to_string(), now_ms()],
        )?;
        Ok(self.query_row(
            "SELECT * FROM brain_turns WHERE id=?",
            [&id],
            Turn::from_row,
        )?)
    }

    fn add_turn_messages(&self, turn_id: &str, message_ids: &[String]) -> ApiResult<()> {
        let current: Option<String> = self
            .query_row(
                "SELECT message_ids_json FROM brain_turns WHERE id=?",
                [turn_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut ids: Vec<String> = current
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        ids.extend(message_ids.iter().cloned());
        self.execute(
            "UPDATE brain_turns SET message_ids_json=? WHERE id=?",
            params![json!(ids).to_string(), turn_id],
        )?;
        Ok(())
    }

    fn end_turn(
        &self,
        turn_id: &str,
        outcome: Outcome,
        error: Option<&str>,
        usage: &Value,
    ) -> ApiResult<Turn> {
        self.execute(
            "UPDATE brain_turns SET ended_at=?, outcome=?, error=?, usage_json=? WHERE id=?",
            params![
                now_ms(),
                outcome.as_str(),
                error,
                usage.to_string(),
                turn_id
            ],
        )?;
        Ok(self.query_row(
            "SELECT * FROM brain_turns WHERE id=?",
            [turn_id],
            Turn::from_row,
        )?)
    }

    fn close_open_turns(&self) -> ApiResult<usize> {
        Ok(self.execute(
            "UPDATE brain_turns SET ended_at=?, outcome='interrupted' WHERE outcome IS NULL",
            [now_ms()],
        )?)
    }

    fn list_turns(&self, room_id: &str, limit: usize) -> ApiResult<Vec<Turn>> {
        let mut statement = self.prepare(
            "SELECT * FROM brain_turns WHERE room_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![room_id, limit.clamp(1, MAX_TURN_PAGE) as i64],
            Turn::from_row,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::db::rooms::GENERAL_ROOM_ID;

    #[test]
    fn turns_open_grow_and_close() {
        let db = Db::memory();
        let conn = db.lock();
        let turn = conn
            .start_turn(GENERAL_ROOM_ID, "user", &["m1".to_owned()])
            .unwrap();
        assert_eq!((turn.outcome.as_deref(), turn.ended_at), (None, None));
        conn.add_turn_messages(&turn.id, &["m2".to_owned()])
            .unwrap();
        let ended = conn
            .end_turn(
                &turn.id,
                Outcome::Failed,
                Some("no model"),
                &json!({ "input": 3 }),
            )
            .unwrap();
        assert_eq!(ended.message_ids, ["m1", "m2"]);
        assert_eq!(ended.outcome.as_deref(), Some("failed"));
        assert_eq!(ended.usage, Some(json!({ "input": 3 })));
        let open = conn.start_turn(GENERAL_ROOM_ID, "user", &[]).unwrap();
        assert_eq!(conn.close_open_turns().unwrap(), 1);
        let turns = conn.list_turns(GENERAL_ROOM_ID, 10).unwrap();
        assert_eq!(turns[0].id, open.id, "newest first");
        assert_eq!(turns[0].outcome.as_deref(), Some("interrupted"));
    }
}
