//! The `sources` and `source_items` tables (`migrations/7-sources.sql`).

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{ApiError, ApiResult};
use crate::memory_records::index;
use crate::util::{new_id, safe_json};

/// What the search index holds of an item, as SQL over `source_items`.
pub const ITEM_TERMS_SQL: &str = "title || ' ' || coalesce(who,'') || ' ' || summary";
/// Items listed at most.
pub const MAX_ITEMS: usize = 100;

/// A source, as stored (never a credential).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(rename = "user")]
    pub owner: String,
    pub config: Value,
    pub paused_at: Option<i64>,
    #[serde(skip)]
    pub cursor: Option<Value>,
    pub last_polled_at: Option<i64>,
    pub last_error: Option<String>,
    pub failures: i64,
    #[serde(skip)]
    pub noted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Source {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            name: row.get("name")?,
            owner: row.get("owner_user")?,
            config: safe_json(&row.get::<_, String>("config_json")?, json!({})),
            paused_at: row.get("paused_at")?,
            cursor: row
                .get::<_, Option<String>>("cursor_json")?
                .map(|text| safe_json(&text, Value::Null))
                .filter(|cursor| !cursor.is_null()),
            last_polled_at: row.get("last_polled_at")?,
            last_error: row.get("last_error")?,
            failures: row.get("failures")?,
            noted_at: row.get("noted_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    /// A string of its configuration.
    pub fn config_str(&self, key: &str) -> Option<&str> {
        self.config.get(key).and_then(Value::as_str)
    }
}

pub fn list(conn: &Connection) -> ApiResult<Vec<Source>> {
    let mut statement = conn.prepare("SELECT * FROM sources ORDER BY created_at, id")?;
    let rows = statement.query_map([], Source::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn find(conn: &Connection, id: &str) -> ApiResult<Option<Source>> {
    Ok(conn
        .query_row("SELECT * FROM sources WHERE id=?", [id], Source::from_row)
        .optional()?)
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Source> {
    find(conn, id)?.ok_or_else(|| ApiError::not_found(format!("No source {id}")))
}

/// A new source's id: its kind and a slug of its name, numbered when taken
/// (`email:gmail`, `email:gmail-2`).
pub fn new_source_id(conn: &Connection, kind: &str, name: &str) -> ApiResult<String> {
    let mut slug = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let base = if slug.is_empty() {
        format!("{kind}:{}", &new_id("s")[2..10])
    } else {
        format!("{kind}:{slug}")
    };
    let mut id = base.clone();
    let mut n = 2;
    while find(conn, &id)?.is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    Ok(id)
}

pub struct NewSource<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub name: &'a str,
    pub owner: &'a str,
    pub config: &'a Value,
}

pub fn insert(conn: &Connection, new: &NewSource<'_>, now: i64) -> ApiResult<Source> {
    conn.execute(
        "INSERT INTO sources (id,kind,name,owner_user,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        params![new.id, new.kind, new.name, new.owner, new.config.to_string(), now, now],
    )?;
    get(conn, new.id)
}

/// A new name or configuration. A new configuration starts over: the next
/// poll takes a baseline again, and the failures are forgotten.
pub fn update(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    config: Option<&Value>,
    now: i64,
) -> ApiResult<Source> {
    if let Some(name) = name {
        conn.execute(
            "UPDATE sources SET name=?, updated_at=? WHERE id=?",
            params![name, now, id],
        )?;
    }
    if let Some(config) = config {
        conn.execute(
            "UPDATE sources SET config_json=?, cursor_json=NULL, last_error=NULL, failures=0, noted_at=NULL, updated_at=? WHERE id=?",
            params![config.to_string(), now, id],
        )?;
    }
    get(conn, id)
}

pub fn set_paused(conn: &Connection, id: &str, paused: bool, now: i64) -> ApiResult<Source> {
    conn.execute(
        "UPDATE sources SET paused_at=?, updated_at=? WHERE id=?",
        params![paused.then_some(now), now, id],
    )?;
    get(conn, id)
}

/// Delete a source with what it saw.
pub fn delete(conn: &Connection, id: &str) -> ApiResult<()> {
    crate::db::atomic(conn, |conn| {
        index::delete_source_items(conn, id)?;
        conn.execute("DELETE FROM source_items WHERE source_id=?", [id])?;
        conn.execute("DELETE FROM sources WHERE id=?", [id])?;
        Ok(())
    })?;
    index::optimize_source_items(conn)?;
    Ok(())
}

/// A poll succeeded.
pub fn polled(conn: &Connection, id: &str, cursor: &Value, now: i64) -> ApiResult<()> {
    conn.execute(
        "UPDATE sources SET cursor_json=?, last_polled_at=?, last_error=NULL, failures=0, noted_at=NULL WHERE id=?",
        params![cursor.to_string(), now, id],
    )?;
    Ok(())
}

/// A poll failed: how many have in a row.
pub fn failed(conn: &Connection, id: &str, error: &str, now: i64) -> ApiResult<i64> {
    conn.execute(
        "UPDATE sources SET last_polled_at=?, last_error=?, failures=failures+1 WHERE id=?",
        params![now, error, id],
    )?;
    Ok(get(conn, id)?.failures)
}

pub fn noted(conn: &Connection, id: &str, now: i64) -> ApiResult<()> {
    conn.execute("UPDATE sources SET noted_at=? WHERE id=?", params![now, id])?;
    Ok(())
}

// ---------- items ----------

/// What a poll saw of one thing.
#[derive(Clone, Debug, PartialEq)]
pub struct NewItem {
    /// Its id at the source (`<uidvalidity>:<uid>`, an event's UID, ...).
    pub external_id: String,
    /// `message`, `event`, `assignment`, `notification` or `commit`.
    pub kind: &'static str,
    pub title: String,
    pub who: Option<String>,
    pub at: Option<i64>,
    pub summary: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub source_id: String,
    pub external_id: String,
    pub kind: String,
    pub title: String,
    pub who: Option<String>,
    pub at: Option<i64>,
    pub summary: String,
    pub url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Item {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            source_id: row.get("source_id")?,
            external_id: row.get("external_id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            who: row.get("who")?,
            at: row.get("at")?,
            summary: row.get("summary")?,
            url: row.get("url")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    fn terms(&self) -> String {
        format!(
            "{} {} {}",
            self.title,
            self.who.as_deref().unwrap_or_default(),
            self.summary
        )
    }
}

/// Keep what a poll saw: new things are added, changed ones updated. The
/// items that are new or changed.
pub fn put_items(
    conn: &Connection,
    source_id: &str,
    items: &[NewItem],
    now: i64,
) -> ApiResult<Vec<Item>> {
    crate::db::atomic(conn, |conn| {
        let mut changed = Vec::new();
        for item in items {
            let found = conn
                .query_row(
                    "SELECT * FROM source_items WHERE source_id=? AND external_id=?",
                    params![source_id, item.external_id],
                    Item::from_row,
                )
                .optional()?;
            let id = match found {
                Some(found)
                    if found.title == item.title
                        && found.who == item.who
                        && found.at == item.at
                        && found.summary == item.summary
                        && found.url == item.url =>
                {
                    continue;
                }
                Some(found) => {
                    conn.execute(
                        "UPDATE source_items SET kind=?, title=?, who=?, at=?, summary=?, url=?, updated_at=? WHERE id=?",
                        params![item.kind, item.title, item.who, item.at, item.summary, item.url, now, found.id],
                    )?;
                    found.id
                }
                None => {
                    let id = new_id("item");
                    conn.execute(
                        "INSERT INTO source_items (id,source_id,external_id,kind,title,who,at,summary,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        params![id, source_id, item.external_id, item.kind, item.title, item.who, item.at, item.summary, item.url, now, now],
                    )?;
                    id
                }
            };
            let stored = conn.query_row(
                "SELECT * FROM source_items WHERE id=?",
                [&id],
                Item::from_row,
            )?;
            index::put_source_item(conn, &id, &stored.terms())?;
            changed.push(stored);
        }
        Ok(changed)
    })
}

/// Things gone from the source: their summary says so. The items changed.
pub fn mark_removed(
    conn: &Connection,
    source_id: &str,
    external_ids: &[String],
    now: i64,
) -> ApiResult<Vec<Item>> {
    const REMOVED: &str = "Removed: ";
    crate::db::atomic(conn, |conn| {
        let mut changed = Vec::new();
        for external_id in external_ids {
            let found = conn
                .query_row(
                    "SELECT * FROM source_items WHERE source_id=? AND external_id=?",
                    params![source_id, external_id],
                    Item::from_row,
                )
                .optional()?;
            let Some(mut found) = found.filter(|found| !found.summary.starts_with(REMOVED)) else {
                continue;
            };
            found.summary = format!("{REMOVED}{}", found.summary);
            found.updated_at = now;
            conn.execute(
                "UPDATE source_items SET summary=?, updated_at=? WHERE id=?",
                params![found.summary, now, found.id],
            )?;
            index::put_source_item(conn, &found.id, &found.terms())?;
            changed.push(found);
        }
        Ok(changed)
    })
}

/// A source's items, the latest first.
pub fn recent_items(conn: &Connection, source_id: &str, limit: usize) -> ApiResult<Vec<Item>> {
    let mut statement = conn.prepare(
        "SELECT * FROM source_items WHERE source_id=? ORDER BY coalesce(at, updated_at) DESC, rowid DESC LIMIT ?",
    )?;
    let rows = statement.query_map(
        params![source_id, limit.clamp(1, MAX_ITEMS) as i64],
        Item::from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Items matching a search (the memory search's terms, ranked by BM25),
/// of one source or all.
pub fn search_items(
    conn: &Connection,
    query: &str,
    source_id: Option<&str>,
    limit: usize,
) -> ApiResult<Vec<Item>> {
    let Some(matched) = crate::memory::text::match_query(query) else {
        return Err(ApiError::new(400, "invalid_input", "Nothing to search for"));
    };
    let mut statement = conn.prepare(
        "SELECT source_items.* FROM source_items_fts JOIN source_items ON source_items.id = source_items_fts.id
         WHERE source_items_fts MATCH ?1 AND (?2 IS NULL OR source_items.source_id = ?2)
         ORDER BY bm25(source_items_fts), coalesce(source_items.at, source_items.updated_at) DESC LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![matched, source_id, limit.clamp(1, MAX_ITEMS) as i64],
        Item::from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn item(external_id: &str, title: &str) -> NewItem {
        NewItem {
            external_id: external_id.to_owned(),
            kind: "message",
            title: title.to_owned(),
            who: Some("Prof. Lin <lin@school.edu>".to_owned()),
            at: Some(1_000),
            summary: format!("Prof. Lin: {title}"),
            url: None,
        }
    }

    #[test]
    fn sources_and_their_items() {
        let db = Db::memory();
        let conn = db.lock();
        let id = new_source_id(&conn, "email", "Gmail (school)").unwrap();
        assert_eq!(id, "email:gmail-school");
        let config = json!({ "host": "imap.gmail.com" });
        let source = insert(
            &conn,
            &NewSource {
                id: &id,
                kind: "email",
                name: "Gmail (school)",
                owner: "me",
                config: &config,
            },
            1,
        )
        .unwrap();
        assert_eq!(source.cursor, None);
        assert_eq!(
            new_source_id(&conn, "email", "gmail school").unwrap(),
            "email:gmail-school-2"
        );
        assert!(
            new_source_id(&conn, "moodle", "學校")
                .unwrap()
                .starts_with("moodle:")
        );

        let changed = put_items(
            &conn,
            &id,
            &[item("1:1", "HW3 extended"), item("1:2", "資料庫期中考")],
            5,
        )
        .unwrap();
        assert_eq!(changed.len(), 2);
        // Seen again unchanged: nothing; changed: updated in place.
        assert!(
            put_items(&conn, &id, &[item("1:1", "HW3 extended")], 6)
                .unwrap()
                .is_empty()
        );
        let again = put_items(&conn, &id, &[item("1:1", "HW3 extended to Friday")], 7).unwrap();
        assert_eq!(
            (again.len(), again[0].id.as_str()),
            (1, changed[0].id.as_str())
        );
        assert_eq!(recent_items(&conn, &id, 10).unwrap().len(), 2);

        let found = search_items(&conn, "期中", None, 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "資料庫期中考");
        assert_eq!(
            search_items(&conn, "friday", Some(&id), 10).unwrap().len(),
            1
        );
        assert!(
            search_items(&conn, "friday", Some("email:other"), 10)
                .unwrap()
                .is_empty()
        );

        polled(&conn, &id, &json!({ "lastUid": 2 }), 8).unwrap();
        assert_eq!(failed(&conn, &id, "timeout", 9).unwrap(), 1);
        assert_eq!(failed(&conn, &id, "timeout", 10).unwrap(), 2);
        let source = get(&conn, &id).unwrap();
        assert_eq!(source.cursor, Some(json!({ "lastUid": 2 })));
        assert_eq!(source.last_error.as_deref(), Some("timeout"));
        // A new configuration starts over.
        let source = update(&conn, &id, None, Some(&json!({ "host": "x" })), 11).unwrap();
        assert_eq!((source.cursor, source.failures), (None, 0));

        delete(&conn, &id).unwrap();
        assert!(find(&conn, &id).unwrap().is_none());
        let left: i64 = conn
            .query_row("SELECT count(*) FROM source_items_fts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }
}
