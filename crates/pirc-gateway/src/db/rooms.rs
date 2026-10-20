//! Rooms, their messages, reads and pending input (plans/rewrite/01-rooms.md).

use rusqlite::{Connection, params};

use crate::util::now_ms;

/// The id of `#general`, the one room of kind `general`.
pub const GENERAL_ROOM_ID: &str = "general";
/// The id of the host face, the one that always exists.
pub const HOST_FACE_ID: &str = "host";

/// What a new database starts with: `#general` and the host face.
pub(super) fn seed(connection: &Connection) -> rusqlite::Result<()> {
    let stamp = now_ms();
    connection.execute(
        "INSERT INTO rooms (id,name,kind,created_at,last_activity_at) VALUES (?1,'general','general',?2,?2)",
        params![GENERAL_ROOM_ID, stamp],
    )?;
    connection.execute(
        "INSERT INTO faces (id,name,created_at) VALUES (?1,'pirc',?2)",
        params![HOST_FACE_ID, stamp],
    )?;
    Ok(())
}
