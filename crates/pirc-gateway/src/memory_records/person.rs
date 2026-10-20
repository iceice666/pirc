//! The household's facts (plans/rewrite/03-memory.md): the brain's middle
//! layer of memory, many and searchable, never in the prompt as a whole.
//! They live with the repositories' notes in `memory_records`, as scope
//! `person` rows of a pseudo-ledger (node `''`, ledger `person`), so one
//! index and one search cover both.
//!
//! Writing needs no approval; safety is the origin, which the gateway
//! works out (never the model): `user` when the person's own words are
//! behind it, `tool:<source>` when something the brain read is,
//! `om:promoted` for an observation observational memory let go. A fact
//! does not change; the person forgets it, which erases it everywhere and
//! refuses the same text from then on.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use super::index;
use crate::db::atomic;
use crate::error::{ApiError, ApiResult};
use crate::memory::store::{
    Version, entry_text, log, logged_texts, refuse_forgotten, tombstone, versions,
};
use crate::memory::text::{content_hash, local_stamp};
use crate::util::{hex, now_ms, random_bytes, safe_json};

/// The pseudo-ledger of the household's facts.
pub const NODE: &str = "";
pub const LEDGER: &str = "person";

/// A fact to remember.
pub struct NewFact<'a> {
    pub content: &'a str,
    /// `user`, `tool:<source>`, `tool:delegation` or `om:promoted`.
    pub origin: &'a str,
    pub room_id: Option<&'a str>,
    pub face_id: Option<&'a str>,
    /// The brain's session entries (or observation ids) behind it.
    pub source_entry_ids: &'a [String],
    /// `face:<id>` or `om`.
    pub actor: &'a str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    /// Empty once forgotten.
    pub content: String,
    /// `active` or `forgotten`.
    pub status: String,
    pub origin: String,
    pub room_id: Option<String>,
    pub face_id: Option<String>,
    pub source_entry_ids: Value,
    pub created_at: i64,
}

impl Fact {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            content: row.get("content")?,
            status: row.get("status")?,
            origin: row.get::<_, Option<String>>("origin")?.unwrap_or_default(),
            room_id: row.get("room_id")?,
            face_id: row.get("face_id")?,
            source_entry_ids: row
                .get::<_, Option<String>>("source_entry_ids_json")?
                .map_or(json!([]), |ids| safe_json(&ids, json!([]))),
            created_at: row.get::<_, Option<i64>>("created_at")?.unwrap_or(0),
        })
    }
}

const SELECT: &str =
    "SELECT * FROM memory_records WHERE node_id='' AND ledger_key='person' AND scope='person'";

/// Remember a fact of `user`'s; an active one with the same text (ignoring
/// case and spacing) is returned unchanged (`true`). Forgotten text is
/// refused.
pub fn remember(conn: &Connection, user: &str, fact: &NewFact<'_>) -> ApiResult<(Fact, bool)> {
    atomic(conn, |conn| {
        let content = entry_text(fact.content)?;
        refuse_forgotten(conn, user, &content)?;
        let hash = content_hash(&content);
        let same = {
            let mut statement =
                conn.prepare(&format!("{SELECT} AND owner_user=? AND status='active'"))?;
            let rows = statement.query_map([user], Fact::from_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .find(|known| content_hash(&known.content) == hash)
        };
        if let Some(same) = same {
            return Ok((same, true));
        }
        let id = new_id(conn)?;
        let at = now_ms();
        let sources = json!(fact.source_entry_ids);
        conn.execute(
            "INSERT INTO memory_records (node_id,ledger_key,id,content,relevance,recorded_at,source_ids_json,owner_user,status,scope,room_id,face_id,origin,source_entry_ids_json,created_at) VALUES (?,?,?,?,'medium',?,'[]',?,'active','person',?,?,?,?,?)",
            params![
                NODE,
                LEDGER,
                id,
                content,
                local_stamp(at),
                user,
                fact.room_id,
                fact.face_id,
                fact.origin,
                sources.to_string(),
                at,
            ],
        )?;
        index::put_record(conn, NODE, LEDGER, &id, &content)?;
        let stored = get(conn, user, &id)?;
        log(
            conn,
            user,
            (&id, 1),
            "add",
            (
                &content,
                &json!([fact.origin]),
                &json!({ "roomId": fact.room_id, "entryIds": sources }),
            ),
            fact.actor,
        )?;
        Ok((stored, false))
    })
}

pub fn get(conn: &Connection, user: &str, id: &str) -> ApiResult<Fact> {
    conn.query_row(
        &format!("{SELECT} AND owner_user=? AND id=?"),
        [user, id],
        Fact::from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::not_found(format!("No fact {id}")))
}

/// `user`'s active facts, newest first: at most `limit`, created before
/// `before` (ms) when given.
#[cfg(test)]
pub fn list(
    conn: &Connection,
    user: &str,
    limit: usize,
    before: Option<i64>,
) -> ApiResult<Vec<Fact>> {
    let mut statement = conn.prepare(&format!(
        "{SELECT} AND owner_user=? AND status='active' AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?"
    ))?;
    let rows = statement.query_map(
        params![user, before.unwrap_or(i64::MAX), limit as i64],
        Fact::from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Forget a fact for real: its text leaves the table, the index (merged,
/// so the file too) and the log; its hash refuses the same text from then
/// on. The forgotten row stays, empty, so the id answers "forgotten".
pub fn forget(conn: &Connection, user: &str, id: &str, actor: &str) -> ApiResult<Fact> {
    atomic(conn, |conn| {
        let fact = get(conn, user, id)?;
        if fact.status == "forgotten" {
            return Ok(fact);
        }
        let mut texts = logged_texts(conn, user, id)?;
        texts.push(fact.content.clone());
        tombstone(conn, user, &texts)?;
        conn.execute(
            "UPDATE memory_records SET content='', source_entry_ids_json='[]', status='forgotten' WHERE node_id=? AND ledger_key=? AND id=?",
            params![NODE, LEDGER, id],
        )?;
        index::delete_record(conn, NODE, LEDGER, id)?;
        index::optimize(conn)?;
        conn.execute(
            "DELETE FROM memory_log WHERE entry_id=? AND owner_user=?",
            [id, user],
        )?;
        log(
            conn,
            user,
            (id, 2),
            "forget",
            ("", &json!([]), &json!({})),
            actor,
        )?;
        get(conn, user, id)
    })
}

/// A fact's logged changes, newest first.
pub fn history(conn: &Connection, user: &str, id: &str) -> ApiResult<Vec<Version>> {
    get(conn, user, id)?;
    versions(conn, user, id)
}

/// Twelve hex digits, like the ids of observations and workspace notes.
fn new_id(conn: &Connection) -> ApiResult<String> {
    loop {
        let id = hex(&random_bytes::<6>());
        let exists = conn
            .query_row(
                "SELECT 1 FROM memory_records WHERE node_id=? AND ledger_key=? AND id=?",
                params![NODE, LEDGER, id],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    const ME: &str = "me@example.com";

    fn said(content: &str) -> NewFact<'_> {
        NewFact {
            content,
            origin: "user",
            room_id: Some("room_general"),
            face_id: Some("host"),
            source_entry_ids: &[],
            actor: "face:host",
        }
    }

    fn code<T: std::fmt::Debug>(result: ApiResult<T>) -> &'static str {
        result.unwrap_err().code
    }

    #[test]
    fn facts_are_remembered_once_and_forgotten_for_real() {
        let db = Db::memory();
        let conn = db.lock();
        let (fact, unchanged) = remember(&conn, ME, &said("Uses  TLP\nfor power")).unwrap();
        assert!(!unchanged);
        assert_eq!(fact.content, "Uses TLP for power");
        assert_eq!(fact.id.len(), 12);
        assert_eq!(
            (fact.origin.as_str(), fact.room_id.as_deref()),
            ("user", Some("room_general"))
        );
        let (again, unchanged) = remember(&conn, ME, &said("uses tlp for POWER")).unwrap();
        assert!(unchanged);
        assert_eq!(again.id, fact.id);
        assert_eq!(list(&conn, ME, 10, None).unwrap().len(), 1);
        assert_eq!(list(&conn, "other@example.com", 10, None).unwrap(), []);
        let history = history(&conn, ME, &fact.id).unwrap();
        assert_eq!(
            (history[0].op.as_str(), history[0].actor.as_str()),
            ("add", "face:host")
        );

        let forgotten = forget(&conn, ME, &fact.id, "user:me@example.com").unwrap();
        assert_eq!(
            (forgotten.status.as_str(), forgotten.content.as_str()),
            ("forgotten", "")
        );
        let terms: i64 = conn
            .query_row(
                "SELECT count(*) FROM memory_records_fts WHERE id=?",
                [&fact.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(terms, 0);
        let logged: Vec<Option<String>> = super::history(&conn, ME, &fact.id)
            .unwrap()
            .into_iter()
            .map(|version| version.content)
            .collect();
        assert_eq!(logged, [None]);
        assert_eq!(
            code(remember(&conn, ME, &said("USES tlp for power"))),
            "forgotten"
        );
        assert_eq!(list(&conn, ME, 10, None).unwrap(), []);
        // Idempotent; unknown ids are not found.
        forget(&conn, ME, &fact.id, "user:me@example.com").unwrap();
        assert_eq!(code(get(&conn, ME, "000000000000")), "not_found");
        assert_eq!(code(remember(&conn, ME, &said("  "))), "invalid_input");
    }
}
