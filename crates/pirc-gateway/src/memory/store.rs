//! Preferences (plans/rewrite/03-memory.md): the small layer of the
//! brain's memory that is always in its prompt. They are the person's
//! word: the brain saves one only with a quote of what they said (checked
//! in the brain's conversation), and the person removes, restores and
//! forgets them. Every change is logged as a revision. Forgetting erases a
//! preference's content and history and keeps only hashes
//! ([`tombstone`]), which refuse the same text from then on, as a
//! preference or as a fact.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use super::text::{content_hash, grouped, squash};
use crate::db::atomic;
use crate::dispatch::redact_secrets;
use crate::error::{ApiError, ApiResult};
use crate::util::{hex, now_ms, random_bytes, safe_json};

/// Characters one preference or fact holds at most.
pub const ENTRY_MAX_CHARS: usize = 1000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preference {
    pub id: String,
    /// Empty once forgotten.
    pub content: String,
    /// `active`, `removed` or `forgotten`.
    pub status: String,
    pub revision: i64,
    pub origins: Value,
    pub sources: Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub created_in_room: Option<String>,
}

impl Preference {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            content: row.get("content")?,
            status: row.get("status")?,
            revision: row.get("revision")?,
            origins: safe_json(&row.get::<_, String>("origins_json")?, json!([])),
            sources: safe_json(&row.get::<_, String>("sources_json")?, json!({})),
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            created_in_room: row.get("created_in_room")?,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub revision: i64,
    pub op: String,
    pub content: Option<String>,
    pub origins: Value,
    pub sources: Value,
    pub actor: String,
    pub at: i64,
}

/// Who is changing memory, and what backs the change. `actor`:
/// `user:<email>`, `face:<id>` or `om`.
#[derive(Clone, Debug)]
pub struct Change {
    pub actor: String,
    pub origins: Value,
    pub sources: Value,
}

/// Memory text is one line; secrets are removed before anything is stored.
pub fn clean(text: &str) -> String {
    squash(&redact_secrets(text))
}

fn len(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

/// A cleaned entry, or why it cannot be one.
pub fn entry_text(value: &str) -> ApiResult<String> {
    let text = clean(value);
    if text.is_empty() {
        return Err(ApiError::new(400, "invalid_input", "content is required"));
    }
    if len(&text) > ENTRY_MAX_CHARS as i64 {
        return Err(ApiError::new(
            413,
            "payload_too_large",
            format!(
                "One entry holds at most {ENTRY_MAX_CHARS} characters; split it into separate facts"
            ),
        ));
    }
    Ok(text)
}

/// Refuse text the user asked to forget (ignoring case, width and spacing).
pub fn refuse_forgotten(conn: &Connection, user: &str, content: &str) -> ApiResult<()> {
    let found = conn
        .query_row(
            "SELECT 1 FROM memory_tombstones WHERE owner_user=? AND content_hash=?",
            [user, &content_hash(content)],
            |_| Ok(()),
        )
        .optional()?;
    if found.is_some() {
        return Err(ApiError::new(
            409,
            "forgotten",
            "The user asked to forget this; do not save it again",
        ));
    }
    Ok(())
}

/// Refuse these texts from now on.
pub fn tombstone<'a>(
    conn: &Connection,
    user: &str,
    contents: impl IntoIterator<Item = &'a String>,
) -> ApiResult<()> {
    let at = now_ms();
    for content in contents {
        if content.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO memory_tombstones (owner_user,content_hash,forgotten_at) VALUES (?,?,?)",
            params![user, content_hash(content), at],
        )?;
    }
    Ok(())
}

/// Log a revision of a preference or fact; removed and forgotten ones keep
/// no text in the log.
pub fn log(
    conn: &Connection,
    user: &str,
    (id, revision): (&str, i64),
    op: &str,
    (content, origins, sources): (&str, &Value, &Value),
    actor: &str,
) -> ApiResult<()> {
    let kept = op != "remove" && op != "forget";
    conn.execute(
        "INSERT INTO memory_log (owner_user,entry_id,revision,op,content,origins_json,sources_json,actor,at) VALUES (?,?,?,?,?,?,?,?,?)",
        params![
            user,
            id,
            revision,
            op,
            kept.then_some(content),
            if kept { origins.to_string() } else { "[]".to_owned() },
            if kept { sources.to_string() } else { "{}".to_owned() },
            actor,
            now_ms(),
        ],
    )?;
    Ok(())
}

/// The logged revisions of a preference or fact, newest first.
pub fn versions(conn: &Connection, user: &str, id: &str) -> ApiResult<Vec<Version>> {
    let mut statement = conn
        .prepare("SELECT * FROM memory_log WHERE entry_id=? AND owner_user=? ORDER BY seq DESC")?;
    let rows = statement.query_map([id, user], |row| {
        Ok(Version {
            revision: row.get("revision")?,
            op: row.get("op")?,
            content: row.get("content")?,
            origins: safe_json(&row.get::<_, String>("origins_json")?, json!([])),
            sources: safe_json(&row.get::<_, String>("sources_json")?, json!({})),
            actor: row.get("actor")?,
            at: row.get("at")?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The texts a preference or fact ever had (its log), to tombstone.
pub fn logged_texts(conn: &Connection, user: &str, id: &str) -> ApiResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT content FROM memory_log WHERE entry_id=? AND owner_user=? AND content IS NOT NULL",
    )?;
    let rows = statement.query_map([id, user], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The preferences of every user, over one connection (or transaction).
pub struct Store<'a> {
    conn: &'a Connection,
    /// Characters of active preferences per user.
    pub budget: usize,
}

impl<'a> Store<'a> {
    pub fn new(conn: &'a Connection, budget: usize) -> Self {
        Self { conn, budget }
    }

    fn tx<T>(&self, body: impl FnOnce() -> ApiResult<T>) -> ApiResult<T> {
        atomic(self.conn, |_| body())
    }

    // ---------- reading ----------

    /// Oldest first; with `status`, only those.
    pub fn list(&self, user: &str, status: Option<&str>) -> ApiResult<Vec<Preference>> {
        let mut statement = self
            .conn
            .prepare("SELECT * FROM preferences WHERE owner_user=? ORDER BY created_at, id")?;
        let rows = statement.query_map([user], Preference::from_row)?;
        let mut out = Vec::new();
        for preference in rows {
            let preference = preference?;
            if status.is_none_or(|status| preference.status == status) {
                out.push(preference);
            }
        }
        Ok(out)
    }

    pub fn get(&self, user: &str, id: &str) -> ApiResult<Preference> {
        self.conn
            .query_row(
                "SELECT * FROM preferences WHERE id=? AND owner_user=?",
                [id, user],
                Preference::from_row,
            )
            .optional()?
            .ok_or_else(|| ApiError::not_found(format!("No preference {id}")))
    }

    fn used(&self, user: &str) -> ApiResult<i64> {
        Ok(self
            .list(user, Some("active"))?
            .iter()
            .map(|preference| len(&preference.content))
            .sum())
    }

    pub fn usage(&self, user: &str) -> ApiResult<Value> {
        Ok(json!({ "used": self.used(user)?, "max": self.budget }))
    }

    /// Newest first.
    pub fn history(&self, user: &str, id: &str) -> ApiResult<Vec<Version>> {
        self.get(user, id)?;
        versions(self.conn, user, id)
    }

    // ---------- changes ----------

    /// Save a preference; an active one with the same text (ignoring case
    /// and spacing) is returned unchanged (`true`).
    pub fn add(
        &self,
        user: &str,
        content: &str,
        room: Option<&str>,
        change: &Change,
    ) -> ApiResult<(Preference, bool)> {
        self.tx(|| {
            let content = entry_text(content)?;
            refuse_forgotten(self.conn, user, &content)?;
            let hash = content_hash(&content);
            if let Some(same) = self
                .list(user, Some("active"))?
                .into_iter()
                .find(|preference| content_hash(&preference.content) == hash)
            {
                return Ok((same, true));
            }
            self.make_room(user, len(&content))?;
            let id = new_id(self.conn)?;
            let at = now_ms();
            self.conn.execute(
                "INSERT INTO preferences (id,owner_user,content,status,revision,origins_json,sources_json,created_at,updated_at,created_in_room) VALUES (?,?,?,'active',1,?,?,?,?,?)",
                params![
                    id,
                    user,
                    content,
                    change.origins.to_string(),
                    change.sources.to_string(),
                    at,
                    at,
                    room,
                ],
            )?;
            let preference = self.get(user, &id)?;
            self.logged(user, &preference, "add", &change.actor)?;
            Ok((preference, false))
        })
    }

    /// Take a preference out of the prompt; it can be restored.
    pub fn remove(&self, user: &str, id: &str, actor: &str) -> ApiResult<Preference> {
        self.tx(|| {
            let preference = self.get(user, id)?;
            if preference.status != "active" {
                return Ok(preference);
            }
            self.update(
                user,
                &preference,
                Next {
                    status: Some("removed"),
                    ..Next::default()
                },
                "remove",
                actor,
            )
        })
    }

    /// Erase a preference: its text and every earlier version. Hashes of
    /// all its versions stay as tombstones, which refuse the same text
    /// (ignoring case and spacing) from then on. Rewordings are not caught.
    pub fn forget(&self, user: &str, id: &str) -> ApiResult<()> {
        self.tx(|| {
            let preference = self.get(user, id)?;
            if preference.status == "forgotten" {
                return Ok(());
            }
            let mut texts = logged_texts(self.conn, user, id)?;
            texts.push(preference.content.clone());
            tombstone(self.conn, user, &texts)?;
            self.conn.execute(
                "UPDATE preferences SET content='', status='forgotten', revision=revision+1, origins_json='[]', sources_json='{}', updated_at=? WHERE id=?",
                params![now_ms(), id],
            )?;
            self.conn.execute(
                "DELETE FROM memory_log WHERE entry_id=? AND owner_user=?",
                [id, user],
            )?;
            let forgotten = self.get(user, id)?;
            self.logged(user, &forgotten, "forget", &format!("user:{user}"))
        })
    }

    /// Bring back a removed preference, or an earlier version (`revision`)
    /// of an active or removed one.
    pub fn restore(&self, user: &str, id: &str, revision: Option<i64>) -> ApiResult<Preference> {
        self.tx(|| {
            let preference = self.get(user, id)?;
            if preference.status == "forgotten" {
                return Err(ApiError::new(
                    409,
                    "forgotten",
                    "This preference was forgotten; nothing is left to restore",
                ));
            }
            let (content, origins, sources) = match revision {
                None => {
                    if preference.status == "active" {
                        return Ok(preference);
                    }
                    (
                        preference.content.clone(),
                        preference.origins.clone(),
                        preference.sources.clone(),
                    )
                }
                Some(revision) => self
                    .conn
                    .query_row(
                        "SELECT * FROM memory_log WHERE entry_id=? AND owner_user=? AND revision=? AND content IS NOT NULL",
                        params![id, user, revision],
                        |row| {
                            Ok((
                                row.get::<_, String>("content")?,
                                safe_json(&row.get::<_, String>("origins_json")?, json!([])),
                                safe_json(&row.get::<_, String>("sources_json")?, json!({})),
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| ApiError::not_found(format!("No version {revision} of {id}")))?,
            };
            if preference.status == "active" && content == preference.content {
                return Ok(preference);
            }
            refuse_forgotten(self.conn, user, &content)?;
            let before = if preference.status == "active" {
                len(&preference.content)
            } else {
                0
            };
            self.make_room(user, len(&content) - before)?;
            self.update(
                user,
                &preference,
                Next {
                    content: Some(&content),
                    status: Some("active"),
                    origins: Some(&origins),
                    sources: Some(&sources),
                },
                "restore",
                &format!("user:{user}"),
            )
        })
    }

    // ---------- internals ----------

    fn make_room(&self, user: &str, delta: i64) -> ApiResult<()> {
        if delta <= 0 {
            return Ok(());
        }
        let used = self.used(user)?;
        let max = self.budget as i64;
        if used + delta > max {
            return Err(ApiError::new(
                409,
                "memory_full",
                format!(
                    "Preferences are full ({}/{} characters, {} more needed); remove one to make room",
                    grouped(used),
                    grouped(max),
                    grouped(delta)
                ),
            )
            .with_details(json!({ "used": used, "max": max, "needed": delta })));
        }
        Ok(())
    }

    fn update(
        &self,
        user: &str,
        preference: &Preference,
        next: Next<'_>,
        op: &str,
        actor: &str,
    ) -> ApiResult<Preference> {
        self.conn.execute(
            "UPDATE preferences SET content=?, status=?, revision=?, origins_json=?, sources_json=?, updated_at=? WHERE id=? AND owner_user=?",
            params![
                next.content.unwrap_or(&preference.content),
                next.status.unwrap_or(&preference.status),
                preference.revision + 1,
                next.origins.unwrap_or(&preference.origins).to_string(),
                next.sources.unwrap_or(&preference.sources).to_string(),
                now_ms(),
                preference.id,
                user,
            ],
        )?;
        let updated = self.get(user, &preference.id)?;
        self.logged(user, &updated, op, actor)?;
        Ok(updated)
    }

    fn logged(&self, user: &str, preference: &Preference, op: &str, actor: &str) -> ApiResult<()> {
        log(
            self.conn,
            user,
            (&preference.id, preference.revision),
            op,
            (
                &preference.content,
                &preference.origins,
                &preference.sources,
            ),
            actor,
        )
    }
}

/// `p` and eight hex digits, unused.
fn new_id(conn: &Connection) -> ApiResult<String> {
    loop {
        let id = format!("p{}", hex(&random_bytes::<4>()));
        let exists = conn
            .query_row("SELECT 1 FROM preferences WHERE id=?", [&id], |_| Ok(()))
            .optional()?;
        if exists.is_none() {
            return Ok(id);
        }
    }
}

/// What an update changes.
#[derive(Default)]
struct Next<'a> {
    content: Option<&'a str>,
    status: Option<&'a str>,
    origins: Option<&'a Value>,
    sources: Option<&'a Value>,
}
