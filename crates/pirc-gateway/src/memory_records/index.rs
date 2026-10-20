//! The full-text index of facts and delegations (plans/memory-search.md
//! phase 1): FTS5 tables of [`index_terms`], kept by the gateway's own
//! writes in the same transaction (no SQL triggers: the terms come from
//! Rust, and the `sqlite3` repairs of docs/deploy/backup-and-recovery.md
//! must keep working without it). Rows are keyed by the records' own keys,
//! not `rowid`, which a `VACUUM` may change. Status is filtered by joining
//! the base table, so status-only updates leave the index alone.
//!
//! Deleting from FTS5 only marks the tokens deleted; after anything is
//! forgotten [`optimize`] merges the segments, and `secure_delete` zeroes
//! the freed pages.

use rusqlite::{Connection, OptionalExtension, params};

use crate::memory::text::{SEARCH_INDEX_VERSION, index_terms};

/// Index (or index again) a fact.
pub fn put_record(
    conn: &Connection,
    node_id: &str,
    ledger_key: &str,
    id: &str,
    content: &str,
) -> rusqlite::Result<()> {
    delete_record(conn, node_id, ledger_key, id)?;
    conn.execute(
        "INSERT INTO memory_records_fts (node_id, ledger_key, id, terms) VALUES (?,?,?,?)",
        params![node_id, ledger_key, id, index_terms(content)],
    )?;
    Ok(())
}

pub fn delete_record(
    conn: &Connection,
    node_id: &str,
    ledger_key: &str,
    id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM memory_records_fts WHERE node_id=? AND ledger_key=? AND id=?",
        params![node_id, ledger_key, id],
    )?;
    Ok(())
}

/// Every fact of a ledger.
pub fn delete_ledger(conn: &Connection, node_id: &str, ledger_key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM memory_records_fts WHERE node_id=? AND ledger_key=?",
        params![node_id, ledger_key],
    )?;
    Ok(())
}

/// Index (or index again) a delegation: its title, and its task and result.
pub fn put_delegation(
    conn: &Connection,
    id: &str,
    title: &str,
    task: &str,
    result: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM delegations_fts WHERE id=?", [id])?;
    let body = format!("{task} {}", result.unwrap_or_default());
    conn.execute(
        "INSERT INTO delegations_fts (id, title, body) VALUES (?,?,?)",
        params![id, index_terms(title), index_terms(&body)],
    )?;
    Ok(())
}

/// Drop the index rows of delegations that are gone.
pub fn prune_delegations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM delegations_fts WHERE id NOT IN (SELECT id FROM delegations)",
        [],
    )?;
    Ok(())
}

/// Merge the index segments, so deleted text leaves the file too.
pub fn optimize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO memory_records_fts(memory_records_fts) VALUES('optimize')",
        [],
    )?;
    conn.execute(
        "INSERT INTO delegations_fts(delegations_fts) VALUES('optimize')",
        [],
    )?;
    Ok(())
}

/// Rebuild the index when it was built by another [`SEARCH_INDEX_VERSION`]
/// (or never), inside the caller's transaction (opening the database).
pub fn ensure(conn: &Connection) -> rusqlite::Result<()> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM search_index_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version == Some(SEARCH_INDEX_VERSION) {
        return Ok(());
    }
    conn.execute("DELETE FROM memory_records_fts", [])?;
    conn.execute("DELETE FROM delegations_fts", [])?;
    let records: Vec<(String, String, String, String)> = {
        let mut statement = conn.prepare(
            "SELECT node_id, ledger_key, id, content FROM memory_records WHERE status IN ('active','superseded')",
        )?;
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?
    };
    for (node_id, ledger_key, id, content) in records {
        conn.execute(
            "INSERT INTO memory_records_fts (node_id, ledger_key, id, terms) VALUES (?,?,?,?)",
            params![node_id, ledger_key, id, index_terms(&content)],
        )?;
    }
    let delegations: Vec<(String, String, String, Option<String>)> = {
        let mut statement = conn.prepare("SELECT id, title, task, result FROM delegations")?;
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?
    };
    for (id, title, task, result) in delegations {
        put_delegation(conn, &id, &title, &task, result.as_deref())?;
    }
    optimize(conn)?;
    conn.execute(
        "INSERT INTO search_index_meta (singleton, version) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version",
        [SEARCH_INDEX_VERSION],
    )?;
    Ok(())
}
