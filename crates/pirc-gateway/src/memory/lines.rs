//! What the brain remembered, shown in the room as a line ("Noted: …")
//! that can be undone ("don't keep this"), and forgetting that reaches
//! those lines too: a forgotten text does not stay in a room.

use rusqlite::Connection;
use serde_json::json;

use crate::app::App;
use crate::db::rooms::{HOST_FACE_ID, MessageKind, RoomStore, Speaker};
use crate::error::ApiResult;
use crate::memory_records::person::{self, Fact};

/// What a memory line is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Remembered {
    Fact,
    Preference,
}

impl Remembered {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
        }
    }
}

/// Say in the room what was remembered, for whom and from where.
pub fn post(
    app: &App,
    room_id: &str,
    kind: Remembered,
    (id, text, origin): (&str, &str, &str),
    owner: &str,
) {
    let label = match kind {
        Remembered::Fact => "Noted",
        Remembered::Preference => "Saved as a preference",
    };
    let body = json!({
        "text": format!("{label}: {text}"),
        "memory": { "kind": kind.as_str(), "id": id, "origin": origin, "user": owner },
    });
    let posted = app.db.lock().post_message(
        room_id,
        Speaker::Face(HOST_FACE_ID),
        MessageKind::Line,
        &body,
    );
    match posted {
        Ok(message) => {
            app.room_message(&message);
            if let Ok(room) = app.db.lock().get_room(room_id) {
                app.room_changed(&room);
            }
        }
        Err(error) => crate::log::warn(&format!(
            "memory: cannot say what was remembered in {room_id}: {}",
            error.message
        )),
    }
}

/// The lines about this memory: `(room, message)` ids.
fn lines_about(conn: &Connection, kind: Remembered, id: &str) -> ApiResult<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT room_id, id FROM room_messages WHERE kind='line' AND json_extract(body_json,'$.memory.kind')=? AND json_extract(body_json,'$.memory.id')=?",
    )?;
    let rows = statement.query_map([kind.as_str(), id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Take the forgotten text out of the lines that said it.
fn erase_lines(app: &App, kind: Remembered, id: &str) -> ApiResult<()> {
    let body = json!({
        "text": "Forgotten.",
        "memory": { "kind": kind.as_str(), "id": id, "forgotten": true },
    });
    let updated = {
        let conn = app.db.lock();
        let mut updated = Vec::new();
        for (room_id, message_id) in lines_about(&conn, kind, id)? {
            updated.push(conn.update_message(&room_id, &message_id, &body, false)?);
        }
        updated
    };
    for message in &updated {
        app.room_message_updated(message);
    }
    Ok(())
}

/// Forget a fact everywhere: store, index, log and room lines.
pub fn forget_fact(app: &App, user: &str, id: &str, actor: &str) -> ApiResult<Fact> {
    let fact = person::forget(&app.db.lock(), user, id, actor)?;
    erase_lines(app, Remembered::Fact, id)?;
    app.memory_changed(user);
    Ok(fact)
}

/// Forget a preference everywhere: store, log and room lines.
pub fn forget_preference(app: &App, user: &str, id: &str) -> ApiResult<()> {
    {
        let conn = app.db.lock();
        super::store(app, &conn).forget(user, id)?;
    }
    erase_lines(app, Remembered::Preference, id)?;
    app.memory_changed(user);
    Ok(())
}
