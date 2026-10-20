//! Workspace memory from every node, held by the gateway for the
//! assistant's search (`apps/gateway/src/daemon/memory-records.ts`). Nodes
//! mirror their ledgers (`memory_mirror`); this applies the lines the way
//! the ledger fold does, and finds each item's owner and workspace through
//! the session that wrote it. Items whose session the gateway does not know
//! have no owner and are never found.
//!
//! Each item also keeps its workspace's repository (normalized `origin`)
//! as of its recording, so a search in one clone of a repository finds the
//! notes of its other clones, on any node.
//!
//! Search matches every word anywhere (`LIKE`), in any script, and ranks by
//! how many words a note holds: the corpus is small (a few thousand notes),
//! and a trigram index would miss two-character Chinese words anyway.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::db::{Store, atomic};
use crate::dispatch::resolve_directory_workspace;
use crate::error::{ApiError, ApiResult};
use crate::memory::schema::{array, hex12, optional, required, string};
use crate::memory::text::{clip, fold, local_stamp, match_query, parse_date, query_phrases, words};
use crate::util::{now_ms, safe_json};

const HIT_CHARS: usize = 600;
const MAX_TERMS: usize = 8;

/// What one node may keep mirrored here (security audit I3): rows,
/// forgotten tombstones included, and note bytes. Far above a real ledger
/// (notes are folded and capped on the node); a node past it gets no new
/// rows until some are cleared, and the gateway logs it. The node's ledger
/// stays the record; this is only the search copy.
const NODE_MAX_ROWS: u64 = 200_000;
const NODE_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// A node's mirrored rows and note bytes, and its limits.
struct Quota {
    rows: u64,
    bytes: u64,
    max_rows: u64,
    max_bytes: u64,
    refused: u64,
}

impl Quota {
    fn of(conn: &Connection, node_id: &str, max_rows: u64, max_bytes: u64) -> ApiResult<Self> {
        let (rows, bytes) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(CAST(content AS BLOB))),0) FROM memory_records WHERE node_id=?",
            [node_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        Ok(Self {
            rows: rows.max(0) as u64,
            bytes: bytes.max(0) as u64,
            max_rows,
            max_bytes,
            refused: 0,
        })
    }

    fn with(mut self, refused: u64) -> Self {
        self.refused = refused;
        self
    }

    /// Take room for one row of `bytes` content, or count it refused.
    fn admit(&mut self, bytes: usize) -> bool {
        let bytes = bytes as u64;
        if self.rows >= self.max_rows || self.bytes + bytes > self.max_bytes {
            self.refused += 1;
            return false;
        }
        self.rows += 1;
        self.bytes += bytes;
        true
    }
}

/// Byte offsets of a node's mirrored ledgers, by ledger key (sent in `registered`).
pub fn watermarks(app: &App, node_id: &str) -> Value {
    let conn = app.db.lock();
    let rows = conn
        .prepare("SELECT ledger_key, watermark FROM memory_mirrors WHERE node_id=?")
        .and_then(|mut statement| {
            statement
                .query_map([node_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        });
    match rows {
        Ok(rows) => Value::Object(
            rows.into_iter()
                .map(|(key, watermark)| (key, json!(watermark)))
                .collect(),
        ),
        Err(error) => {
            crate::log::error(&format!("database: {error}"));
            json!({})
        }
    }
}

/// Store a `memory_mirror` chunk and return the ledger's watermark. A chunk
/// must start exactly where the stored part ends (or start over with
/// `reset`); anything else is ignored, and the answer tells the node where
/// to resume.
pub fn ingest(
    app: &App,
    node_id: &str,
    ledger_key: &str,
    offset: u64,
    end: u64,
    reset: bool,
    lines: &[Value],
) -> ApiResult<u64> {
    ingest_within(
        app,
        node_id,
        ledger_key,
        (offset, end, reset),
        lines,
        (NODE_MAX_ROWS, NODE_MAX_BYTES),
    )
}

/// [`ingest`] with the node's row and byte limits.
fn ingest_within(
    app: &App,
    node_id: &str,
    ledger_key: &str,
    (offset, end, reset): (u64, u64, bool),
    lines: &[Value],
    (max_rows, max_bytes): (u64, u64),
) -> ApiResult<u64> {
    let conn = app.db.lock();
    let refused = std::cell::Cell::new(0);
    // Something left the index: merge its segments before committing.
    let erased = std::cell::Cell::new(false);
    let stored = atomic(&conn, |conn| {
        let current: u64 = conn
            .query_row(
                "SELECT watermark FROM memory_mirrors WHERE node_id=? AND ledger_key=?",
                [node_id, ledger_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map_or(0, |watermark| watermark.max(0) as u64);
        if reset {
            if offset != 0 {
                return Ok(current);
            }
            conn.execute(
                "DELETE FROM memory_records WHERE node_id=? AND ledger_key=?",
                [node_id, ledger_key],
            )?;
            index::delete_ledger(conn, node_id, ledger_key)?;
            erased.set(true);
        } else if offset != current {
            return Ok(current);
        }
        if end < offset {
            return Ok(if reset { 0 } else { current });
        }
        let mut quota = Quota::of(conn, node_id, max_rows, max_bytes)?;
        for line in lines {
            if let Some(line) = Line::parse(line) {
                erased.set(apply(conn, node_id, ledger_key, line, &mut quota)? | erased.get());
            }
        }
        if erased.get() {
            index::optimize(conn)?;
        }
        refused.set(quota.refused);
        conn.execute(
            "INSERT INTO memory_mirrors (node_id,ledger_key,watermark,updated_at) VALUES (?,?,?,?) ON CONFLICT(node_id,ledger_key) DO UPDATE SET watermark=excluded.watermark, updated_at=excluded.updated_at",
            params![node_id, ledger_key, end as i64, now_ms()],
        )?;
        Ok(end)
    })?;
    if refused.get() > 0 {
        crate::log::warn(&format!(
            "memory mirror: node {node_id} is over its quota ({max_rows} rows, {max_bytes} bytes); {} new records not kept for search",
            refused.get()
        ));
    }
    Ok(stored)
}

/// One ledger line (`lineSchema`); its items are checked one by one, so one
/// bad item never costs its line.
enum Line<'a> {
    Recorded(&'a [Value]),
    Retired { ids: Vec<&'a str>, forgotten: bool },
    Cleared,
}

impl<'a> Line<'a> {
    fn parse(value: &'a Value) -> Option<Self> {
        let object = value.as_object()?;
        match object.get("type")?.as_str()? {
            "recorded" => {
                let items = object.get("items")?.as_array()?;
                (items.len() <= 2000).then_some(Self::Recorded(items))
            }
            "retired" => {
                let ids = array(object.get("ids")?, 0, 2000, |id| string(id, 0, 40))?;
                let forgotten = match object.get("reason")?.as_str()? {
                    "superseded" => false,
                    "forgotten" => true,
                    _ => return None,
                };
                Some(Self::Retired { ids, forgotten })
            }
            "cleared" => Some(Self::Cleared),
            _ => None,
        }
    }
}

/// A mirrored item (`itemSchema`).
struct Item {
    id: String,
    content: String,
    relevance: String,
    timestamp: String,
    session_id: Option<String>,
    git: Option<Value>,
    source_ids: Vec<String>,
    origins: Option<Vec<String>>,
}

impl Item {
    fn parse(value: &Value) -> Option<Self> {
        Self::fields(value.as_object()?).ok()
    }

    fn fields(object: &Map<String, Value>) -> Result<Self, ()> {
        let owned = |text: &str| text.to_owned();
        let id = required(object, "id", hex12)?.to_owned();
        let content = required(object, "content", |v| string(v, 0, 20_000).map(owned))?;
        let relevance = required(object, "relevance", |v| {
            v.as_str()
                .filter(|r| ["low", "medium", "high", "critical"].contains(r))
                .map(owned)
        })?;
        let timestamp = required(object, "timestamp", |v| string(v, 0, 40).map(owned))?;
        let session_id = optional(object, "sessionId", |v| string(v, 1, 200).map(owned))?;
        let git = optional(object, "git", |v| {
            let git = v.as_object()?;
            let mut out = Map::new();
            out.insert("head".into(), json!(string(git.get("head")?, 0, 64)?));
            if let Some(branch) = optional(git, "branch", |b| string(b, 0, 300)).ok()? {
                out.insert("branch".into(), json!(branch));
            }
            out.insert("dirty".into(), json!(git.get("dirty")?.as_bool()?));
            Some(Value::Object(out))
        })?;
        let source_ids = required(object, "sourceMemoryIds", |v| {
            array(v, 0, 200, |id| string(id, 0, 40).map(owned))
        })?;
        let origins = optional(object, "origins", |v| {
            array(v, 0, 50, |origin| string(origin, 0, 100).map(owned))
        })?;
        Ok(Self {
            id,
            content,
            relevance,
            timestamp,
            session_id,
            git,
            source_ids,
            origins,
        })
    }
}

/// One ledger line, applied like `foldWorkspace`; whether it took text
/// out of the index.
fn apply(
    conn: &Connection,
    node_id: &str,
    key: &str,
    line: Line<'_>,
    quota: &mut Quota,
) -> ApiResult<bool> {
    let mut erased = false;
    match line {
        Line::Cleared => {
            conn.execute(
                "DELETE FROM memory_records WHERE node_id=? AND ledger_key=? AND status!='forgotten'",
                [node_id, key],
            )?;
            index::delete_ledger(conn, node_id, key)?;
            erased = true;
            *quota = Quota::of(conn, node_id, quota.max_rows, quota.max_bytes)?.with(quota.refused);
        }
        Line::Retired { ids, forgotten } => {
            for id in ids {
                if !forgotten {
                    conn.execute(
                        "UPDATE memory_records SET status='superseded' WHERE node_id=? AND ledger_key=? AND id=? AND status='active'",
                        [node_id, key, id],
                    )?;
                    continue;
                }
                // Forgotten: nothing of it stays here, and it is never recorded again.
                let freed: Option<i64> = conn
                    .query_row(
                        "SELECT length(CAST(content AS BLOB)) FROM memory_records WHERE node_id=? AND ledger_key=? AND id=?",
                        [node_id, key, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let updated = conn.execute(
                    "UPDATE memory_records SET content='', git_json=NULL, source_ids_json='[]', origins_json=NULL, status='forgotten' WHERE node_id=? AND ledger_key=? AND id=?",
                    [node_id, key, id],
                )?;
                index::delete_record(conn, node_id, key, id)?;
                erased = true;
                if let Some(freed) = freed {
                    quota.bytes = quota.bytes.saturating_sub(freed.max(0) as u64);
                }
                if updated == 0 && quota.admit(0) {
                    conn.execute(
                        "INSERT INTO memory_records (node_id,ledger_key,id,content,relevance,recorded_at,source_ids_json,status) VALUES (?,?,?,'','low','','[]','forgotten')",
                        [node_id, key, id],
                    )?;
                }
            }
        }
        Line::Recorded(items) => {
            for raw in items {
                let Some(item) = Item::parse(raw) else {
                    continue;
                };
                // First record wins, and a forgotten id stays forgotten.
                let exists = conn
                    .query_row(
                        "SELECT 1 FROM memory_records WHERE node_id=? AND ledger_key=? AND id=?",
                        [node_id, key, &item.id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if exists.is_some() || !quota.admit(item.content.len()) {
                    continue;
                }
                let (session_id, workspace_id, owner_user) =
                    source(conn, node_id, item.session_id.as_deref())?;
                let repo: Option<String> = match &workspace_id {
                    Some(workspace_id) => conn
                        .query_row(
                            "SELECT repo FROM workspaces WHERE id=?",
                            [workspace_id],
                            |row| row.get(0),
                        )
                        .optional()?
                        .flatten(),
                    None => None,
                };
                conn.execute(
                    "INSERT INTO memory_records (node_id,ledger_key,id,content,relevance,recorded_at,git_json,source_ids_json,origins_json,node_session_id,session_id,workspace_id,owner_user,status,repo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)",
                    params![
                        node_id,
                        key,
                        item.id,
                        item.content,
                        item.relevance,
                        item.timestamp,
                        item.git.map(|git| git.to_string()),
                        json!(item.source_ids).to_string(),
                        item.origins.map(|origins| json!(origins).to_string()),
                        item.session_id,
                        session_id,
                        workspace_id,
                        owner_user,
                        repo,
                    ],
                )?;
                index::put_record(conn, node_id, key, &item.id, &item.content)?;
            }
        }
    }
    Ok(erased)
}

/// The gateway's session behind a node session: its id, workspace and owner.
fn source(
    conn: &Connection,
    node_id: &str,
    node_session_id: Option<&str>,
) -> ApiResult<(Option<String>, Option<String>, Option<String>)> {
    let Some(node_session_id) = node_session_id else {
        return Ok((None, None, None));
    };
    let Some(session_id) = conn.resolve_remote_session(node_id, node_session_id)? else {
        return Ok((None, None, None));
    };
    let session = conn.get_session(&session_id)?;
    Ok((
        Some(session_id),
        Some(session.workspace_id),
        session.owner_user,
    ))
}

/// `${branch ?? 'detached'}@${head.slice(0, 7)}${dirty ? '*' : ''}`, for a git state with a head.
fn git_label(git: &Value) -> Option<String> {
    let head = git.get("head")?.as_str().filter(|head| !head.is_empty())?;
    let branch = git
        .get("branch")
        .and_then(Value::as_str)
        .unwrap_or("detached");
    let short: String = String::from_utf16_lossy(&head.encode_utf16().take(7).collect::<Vec<_>>());
    let dirty = git.get("dirty").and_then(Value::as_bool).unwrap_or(false);
    Some(format!("{branch}@{short}{}", if dirty { "*" } else { "" }))
}

/// `${displayName} on ${hostId}`, else what is known of it.
fn label(conn: &Connection, workspace_id: Option<&str>, node_id: Option<&str>) -> String {
    if let Some(workspace_id) = workspace_id
        && let Ok(workspace) = conn.get_workspace(workspace_id)
    {
        return format!("{} on {}", workspace.display_name, workspace.host_id);
    }
    match (node_id, workspace_id) {
        (Some(node_id), _) => format!("a repository on {node_id}"),
        (None, Some(workspace_id)) => workspace_id.to_owned(),
        (None, None) => "a workspace".to_owned(),
    }
}

fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

struct Ranked {
    /// Higher is better: BM25 relevance, or how many words a note holds.
    score: f64,
    current: bool,
    time: i64,
    hit: Value,
}

fn all_rows(conn: &Connection, sql: &str, values: Vec<Sql>) -> ApiResult<Vec<Map<String, Value>>> {
    let mut statement = conn.prepare(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let rows = statement.query_map(params_from_iter(values), |row: &Row<'_>| {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get::<_, Sql>(index)? {
                Sql::Null => Value::Null,
                Sql::Integer(int) => json!(int),
                Sql::Real(real) => json!(real),
                Sql::Text(text) => json!(text),
                Sql::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        Ok(object)
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The workspaces a search keeps to: their ledgers, and every record and
/// delegation of their repositories.
struct Scope {
    ids: Vec<String>,
    repos: Vec<String>,
}

/// `(?,?,…)`, or `(NULL)` (matching nothing) for none.
fn placeholders(count: usize) -> String {
    if count == 0 {
        "(NULL)".to_owned()
    } else {
        format!("({})", vec!["?"; count].join(","))
    }
}

/// Where a search without a workspace looked, in a project with links.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Searched {
    /// The linked workspaces and the other clones of their repositories.
    Linked,
    /// Nothing there: every workspace.
    Everywhere,
}

impl Searched {
    pub fn name(self) -> &'static str {
        match self {
            Self::Linked => "linked",
            Self::Everywhere => "everywhere",
        }
    }
}

/// Which facts a search looks at: the repositories' notes (and the
/// delegations), the household's facts, or both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scopes {
    Repo,
    Person,
    All,
}

impl Scopes {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "repo" => Some(Self::Repo),
            "person" => Some(Self::Person),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    fn repo(self) -> bool {
        self != Self::Person
    }
}

/// A search query, ready for the index and for the substring fallback.
struct Terms {
    /// The FTS5 query (`memory/text.rs` `match_query`) and its phrases.
    fts: Option<String>,
    phrases: Vec<String>,
    /// Folded words, for `LIKE` when the index finds nothing (part of a
    /// hash or an identifier).
    like: Vec<String>,
}

impl Terms {
    fn of(query: &str) -> ApiResult<Self> {
        let folded = fold(query);
        let all: Vec<&str> = words(&folded).collect();
        if all.is_empty() {
            return Err(ApiError::new(400, "invalid_input", "query is required"));
        }
        // Short words (`I`, `on`) as substrings match nearly every note.
        let mut like: Vec<String> = Vec::new();
        for word in all {
            let long = word.chars().count() >= 3 || !word.is_ascii();
            if long && !like.iter().any(|known| known == word) {
                like.push(word.to_owned());
            }
        }
        like.truncate(MAX_TERMS);
        Ok(Self {
            fts: match_query(query),
            phrases: query_phrases(query),
            like,
        })
    }
}

/// Notes and delegations of `user` holding any of the words in `query`,
/// most relevant first, then current before superseded, then newest. With
/// `workspace`, those of its ledger and of every clone of its repository.
#[cfg(test)]
pub fn search(
    app: &App,
    user: &str,
    query: &str,
    workspace: Option<&str>,
    limit: Option<i64>,
) -> ApiResult<Vec<Value>> {
    search_in(app, user, query, workspace, limit, None, false).map(|(hits, _)| hits)
}

/// [`search`] from a chat in `project`: without a workspace, and unless
/// `everywhere`, the workspaces it is linked to (and their clones) first,
/// then every workspace if nothing is found there.
pub fn search_in(
    app: &App,
    user: &str,
    query: &str,
    workspace: Option<&str>,
    limit: Option<i64>,
    project: Option<&str>,
    everywhere: bool,
) -> ApiResult<(Vec<Value>, Option<Searched>)> {
    let terms = Terms::of(query)?;
    let limit = limit.unwrap_or(8).clamp(1, 20) as usize;
    let users = [user.to_owned()];
    let find = |scope: Option<&Scope>| find_hits(app, &users, &terms, limit, Scopes::Repo, scope);
    if let Some(reference) = workspace {
        let workspace = resolve_directory_workspace(app, reference)?;
        let scope = Scope {
            ids: vec![workspace.id],
            repos: workspace.repo.into_iter().collect(),
        };
        return Ok((find(Some(&scope))?, None));
    }
    if !everywhere && let Some(project) = project {
        let scope = {
            let conn = app.db.lock();
            let links = crate::project_links::links(&conn, project)?;
            Scope {
                repos: crate::project_links::repos(&conn, &links)?,
                ids: links.into_iter().map(|link| link.workspace_id).collect(),
            }
        };
        if !scope.ids.is_empty() {
            let hits = find(Some(&scope))?;
            if !hits.is_empty() {
                return Ok((hits, Some(Searched::Linked)));
            }
            return Ok((find(None)?, Some(Searched::Everywhere)));
        }
    }
    Ok((find(None)?, None))
}

/// The brain's search: the facts of `users` (the people in the turn) in
/// `scopes`, every workspace.
pub fn search_facts(
    app: &App,
    users: &[String],
    query: &str,
    limit: usize,
    scopes: Scopes,
) -> ApiResult<Vec<Value>> {
    let terms = Terms::of(query)?;
    find_hits(app, users, &terms, limit.clamp(1, 20), scopes, None)
}

/// The index first; when it finds nothing, every word as a substring.
fn find_hits(
    app: &App,
    users: &[String],
    terms: &Terms,
    limit: usize,
    scopes: Scopes,
    scope: Option<&Scope>,
) -> ApiResult<Vec<Value>> {
    if users.is_empty() {
        return Ok(Vec::new());
    }
    let conn = app.db.lock();
    if let Some(fts) = &terms.fts {
        let matching = Match::Index(fts, &terms.phrases);
        let hits = query_hits(&conn, users, matching, limit, scopes, scope)?;
        if !hits.is_empty() {
            return Ok(hits);
        }
    }
    if terms.like.is_empty() {
        return Ok(Vec::new());
    }
    query_hits(&conn, users, Match::Like(&terms.like), limit, scopes, scope)
}

enum Match<'a> {
    /// The FTS5 query, and its phrases.
    Index(&'a str, &'a [String]),
    Like(&'a [String]),
}

/// Rows the index ranks first, at most, before the merge with delegations.
const INDEX_CANDIDATES: usize = 50;

fn query_hits(
    conn: &Connection,
    users: &[String],
    matching: Match<'_>,
    limit: usize,
    scopes: Scopes,
    scope: Option<&Scope>,
) -> ApiResult<Vec<Value>> {
    let owners = placeholders(users.len());
    let owner_values = || users.iter().cloned().map(Sql::Text);
    let scope_values = |values: &mut Vec<Sql>| {
        if let Some(scope) = scope {
            values.extend(scope.ids.iter().cloned().map(Sql::Text));
            // A workspace without a repository keeps to its own ledgers.
            values.extend(scope.repos.iter().cloned().map(Sql::Text));
        }
    };
    let (records_in, delegations_in) = match scope {
        Some(scope) => {
            let (ids, repos) = (
                placeholders(scope.ids.len()),
                placeholders(scope.repos.len()),
            );
            (
                format!(
                    " AND (r.scope='person' OR (r.node_id || '/' || r.ledger_key) IN (SELECT node_id || '/' || ledger_key FROM memory_records WHERE workspace_id IN {ids}) OR r.repo IN {repos})"
                ),
                format!(
                    " AND (d.workspace_id IN {ids} OR d.workspace_id IN (SELECT id FROM workspaces WHERE repo IN {repos}))"
                ),
            )
        }
        None => (String::new(), String::new()),
    };
    let scope_names = match scopes {
        Scopes::Repo => "('repo')",
        Scopes::Person => "('person')",
        Scopes::All => "('repo','person')",
    };
    let like_any = |terms: &[String], column: &str| {
        format!(
            "({})",
            terms
                .iter()
                .map(|_| format!("{column} LIKE ? ESCAPE '\\'"))
                .collect::<Vec<_>>()
                .join(" OR ")
        )
    };
    let patterns = |terms: &[String]| {
        terms
            .iter()
            .map(|term| Sql::Text(format!("%{}%", escape_like(term))))
            .collect::<Vec<_>>()
    };
    // Records.
    let mut values: Vec<Sql> = Vec::new();
    let (from, matched, rank) = match matching {
        Match::Index(fts, _) => {
            values.push(Sql::Text(fts.to_owned()));
            (
                "memory_records_fts f JOIN memory_records r ON r.node_id=f.node_id AND r.ledger_key=f.ledger_key AND r.id=f.id",
                "memory_records_fts MATCH ?".to_owned(),
                "bm25(memory_records_fts)",
            )
        }
        Match::Like(terms) => {
            values.extend(patterns(terms));
            ("memory_records r", like_any(terms, "r.content"), "0")
        }
    };
    values.extend(owner_values());
    scope_values(&mut values);
    let records = all_rows(
        conn,
        &format!(
            "SELECT r.*, {rank} AS rank FROM {from} WHERE {matched} AND r.owner_user IN {owners} AND r.status IN ('active','superseded') AND r.scope IN {scope_names}{records_in} ORDER BY rank LIMIT {INDEX_CANDIDATES}",
        ),
        values,
    )?;
    // Delegations.
    let delegations = if scopes.repo() {
        let mut values: Vec<Sql> = Vec::new();
        let (from, matched, rank) = match matching {
            Match::Index(fts, _) => {
                values.push(Sql::Text(fts.to_owned()));
                (
                    "delegations_fts f JOIN delegations d ON d.id=f.id",
                    "delegations_fts MATCH ?".to_owned(),
                    "bm25(delegations_fts, 0.0, 2.0, 1.0)",
                )
            }
            Match::Like(terms) => {
                values.extend(patterns(terms));
                (
                    "delegations d",
                    like_any(
                        terms,
                        "(d.title || ' ' || d.task || ' ' || COALESCE(d.result, ''))",
                    ),
                    "0",
                )
            }
        };
        values.extend(owner_values());
        scope_values(&mut values);
        all_rows(
            conn,
            &format!(
                "SELECT d.*, {rank} AS rank FROM {from} WHERE {matched} AND d.owner_user IN {owners}{delegations_in} ORDER BY rank LIMIT {INDEX_CANDIDATES}",
            ),
            values,
        )?
    } else {
        Vec::new()
    };
    // BM25 is lower for better matches, and only comparable within one
    // table: each table's scores are scaled to its best match.
    let best = |rows: &[Map<String, Value>]| {
        rows.iter()
            .filter_map(|row| row.get("rank").and_then(Value::as_f64))
            .map(|rank| -rank)
            .fold(f64::MIN_POSITIVE, f64::max)
    };
    let (best_record, best_delegation) = (best(&records), best(&delegations));
    // How many of the query's phrases a hit holds comes first (so a note
    // and a delegation compare), its relevance within its table next.
    let score = |row: &Map<String, Value>, text: &str, best: f64| -> f64 {
        match matching {
            Match::Index(_, phrases) => {
                let folded = fold(text);
                let held = phrases
                    .iter()
                    .filter(|phrase| folded.contains(phrase.as_str()))
                    .count() as f64;
                held - row.get("rank").and_then(Value::as_f64).unwrap_or(0.0) / best
            }
            Match::Like(terms) => {
                let folded = fold(text);
                terms
                    .iter()
                    .filter(|term| folded.contains(term.as_str()))
                    .count() as f64
            }
        }
    };
    let text = |row: &Map<String, Value>, key: &str| -> String {
        row.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut ranked: Vec<Ranked> = Vec::new();
    for row in &records {
        let content = text(row, "content");
        let current = text(row, "status") == "active";
        ranked.push(Ranked {
            // A note replaced by a newer one counts half.
            score: score(row, &content, best_record) * if current { 1.0 } else { 0.5 },
            current,
            time: parse_date(&text(row, "recorded_at").replacen(' ', "T", 1)).unwrap_or(0),
            hit: record_hit(conn, row),
        });
    }
    for row in &delegations {
        let result = row.get("result").and_then(Value::as_str);
        let (title, task) = (text(row, "title"), text(row, "task"));
        let updated_at = row.get("updated_at").and_then(Value::as_i64).unwrap_or(0);
        ranked.push(Ranked {
            score: score(
                row,
                &format!("{title} {task} {}", result.unwrap_or_default()),
                best_delegation,
            ),
            current: true,
            time: updated_at,
            hit: json!({
                "id": text(row, "id"),
                "kind": "delegation",
                "workspace": label(conn, row.get("workspace_id").and_then(Value::as_str), None),
                "date": local_stamp(updated_at),
                "status": text(row, "status"),
                "content": clip(&format!("{title}: {}", result.unwrap_or(&task)), HIT_CHARS),
            }),
        });
    }
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(b.current.cmp(&a.current))
            .then(b.time.cmp(&a.time))
    });
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|ranked| ranked.hit)
        .collect())
}

/// A fact as search shows it: a household fact with its origin, a
/// repository's note with its workspace and git state.
fn record_hit(conn: &Connection, row: &Map<String, Value>) -> Value {
    let text = |key: &str| -> String {
        row.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut hit = Map::new();
    hit.insert("id".into(), json!(text("id")));
    if text("scope") == "person" {
        hit.insert("kind".into(), json!("fact"));
        hit.insert("origin".into(), json!(text("origin")));
        if let Some(room_id) = row.get("room_id").filter(|room| room.is_string()) {
            hit.insert("roomId".into(), room_id.clone());
        }
        // A demoted open loop (plans/rewrite/04-open-loops.md).
        if let Some(loop_id) = row.get("open_loop_id").filter(|id| id.is_string()) {
            hit.insert("openLoopId".into(), loop_id.clone());
        }
    } else {
        hit.insert("kind".into(), json!("workspace"));
        hit.insert(
            "workspace".into(),
            json!(label(
                conn,
                row.get("workspace_id").and_then(Value::as_str),
                row.get("node_id").and_then(Value::as_str),
            )),
        );
    }
    hit.insert("date".into(), json!(text("recorded_at")));
    hit.insert("status".into(), json!(text("status")));
    let git = row
        .get("git_json")
        .and_then(Value::as_str)
        .map(|git| safe_json(git, Value::Null))
        .and_then(|git| git_label(&git));
    if let Some(git) = git {
        hit.insert("git".into(), json!(git));
    }
    hit.insert("relevance".into(), json!(text("relevance")));
    hit.insert("content".into(), json!(clip(&text("content"), HIT_CHARS)));
    Value::Object(hit)
}

/// `user`'s newest active facts in `scopes`, as search hits.
pub fn recent(app: &App, user: &str, scopes: Scopes, limit: usize) -> ApiResult<Vec<Value>> {
    let scope_names = match scopes {
        Scopes::Repo => "('repo')",
        Scopes::Person => "('person')",
        Scopes::All => "('repo','person')",
    };
    let conn = app.db.lock();
    let rows = all_rows(
        &conn,
        &format!(
            "SELECT r.* FROM memory_records r WHERE r.owner_user=? AND r.status='active' AND r.scope IN {scope_names} ORDER BY r.recorded_at DESC, r.created_at DESC LIMIT {limit}"
        ),
        vec![Sql::Text(user.to_owned())],
    )?;
    Ok(rows.iter().map(|row| record_hit(&conn, row)).collect())
}

/// A mirrored note to recall.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub node_id: String,
    pub ledger_key: String,
    pub workspace: String,
    pub date: String,
    pub status: String,
    pub content: String,
}

/// The user's mirrored notes with this id (usually one), for recall.
pub fn find(app: &App, user: &str, id: &str) -> ApiResult<Vec<Found>> {
    let conn = app.db.lock();
    let rows: Vec<(String, String, Option<String>, String, String, String)> = {
        let mut statement = conn.prepare(
            "SELECT node_id, ledger_key, workspace_id, recorded_at, status, content FROM memory_records WHERE id=? AND owner_user=? AND status!='forgotten' ORDER BY rowid",
        )?;
        let rows = statement.query_map([id, user], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    Ok(rows
        .into_iter()
        .map(
            |(node_id, ledger_key, workspace_id, date, status, content)| Found {
                workspace: label(&conn, workspace_id.as_deref(), Some(&node_id)),
                node_id,
                ledger_key,
                date,
                status,
                content,
            },
        )
        .collect())
}

#[cfg(test)]
mod eval;
pub mod index;
pub mod person;
#[cfg(test)]
mod tests;
