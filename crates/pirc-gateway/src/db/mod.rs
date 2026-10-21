//! The gateway's SQLite database, `$PIRC_STATE_DIR/pirc.sqlite`
//! (plans/rewrite/01-rooms.md): a fresh file with its own schema
//! (`schema.sql`), versioned from 1. Nothing is carried over from the old
//! `gateway.sqlite` (decision #14): that file is left where it is, unread.
//!
//! - [`engine`]: the engine's index of workspaces, sessions, commands and
//!   leases, which the nodes own.
//! - [`rooms`]: rooms, their messages, reads and pending input.
//!
//! Feature modules (devices, memory, delegations, ...) keep their own
//! queries next to their logic. Queries are methods implemented for
//! [`Connection`], so a transaction (which dereferences to a connection)
//! can combine several.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::error::{ApiError, ApiResult};

pub mod engine;
pub mod rooms;

pub use engine::*;

/// `PRAGMA application_id` of a pirc database ("pirc"). A database without
/// it is not ours, whatever its `user_version` says: the old gateway's
/// files numbered their schemas 1 to 1005.
const APPLICATION_ID: i32 = 0x7069_7263;
/// `PRAGMA user_version` of `schema.sql`.
pub const SCHEMA_VERSION: i64 = 7;
const SCHEMA: &str = include_str!("schema.sql");
/// Each migration takes a database from the version before it to its own;
/// `schema.sql` is always the newest whole.
const MIGRATIONS: &[(i64, &str)] = &[
    (2, include_str!("migrations/2-brain-turns.sql")),
    (3, include_str!("migrations/3-memory.sql")),
    (4, include_str!("migrations/4-open-loops.sql")),
    (5, include_str!("migrations/5-wakes.sql")),
    (6, include_str!("migrations/6-workers.sql")),
    (7, include_str!("migrations/7-sources.sql")),
];

/// The database file in a state directory when `PIRC_DATABASE_PATH` does
/// not name another (pirc-config's default).
#[cfg(test)]
const DATABASE_FILE: &str = "pirc.sqlite";
/// The database of the gateway before the rewrite, left in place.
pub const LEGACY_DATABASE_FILE: &str = "gateway.sqlite";

/// The open database. Never hold the lock across an `await`.
pub struct Db(Mutex<Connection>);

impl Db {
    /// Open (creating) the database at `path`, readable by the owner only.
    pub fn open(path: &Path) -> Result<Self, String> {
        let describe = |error: rusqlite::Error| format!("{}: {error}", path.display());
        let connection = Connection::open(path).map_err(describe)?;
        // Another process may hold the write lock (opening, migrating).
        connection
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
            .map_err(describe)?;
        // Push keys, device-token hashes and memory live here. SQLite gives
        // the WAL and shm files the main file's mode, so this covers them.
        restrict_mode(path)?;
        enable_wal_mode_with_retry(&connection, path, || {})?;
        for suffix in ["-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            restrict_mode(Path::new(&name))?;
        }
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(describe)?;
        // Deleted and overwritten content (forgotten memory, revoked tokens)
        // is zeroed in the database file, not left in free space. Measured
        // at under 1% more WAL bytes and no measurable time on a
        // representative write mix; it does not clean old WAL frames,
        // backups or copies (docs/deploy/backup-and-recovery.md).
        connection
            .pragma_update(None, "secure_delete", "ON")
            .map_err(describe)?;
        create_schema(&connection, path)?;
        Ok(Self(Mutex::new(connection)))
    }

    /// An in-memory database (tests).
    #[cfg(test)]
    pub fn memory() -> Self {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        create_schema(&connection, Path::new(":memory:")).unwrap();
        Self(Mutex::new(connection))
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The line logged at startup when the old gateway's database is still in
/// the state directory: it is neither read nor changed (decision #14).
pub fn legacy_database_note(state_dir: &Path, database: &Path) -> Option<String> {
    let legacy = state_dir.join(LEGACY_DATABASE_FILE);
    (legacy.exists() && legacy != database).then(|| {
        format!(
            "{} is from the gateway before the rewrite; it is left as it is and not read. \
             This gateway uses {} (docs/deploy/upgrades.md).",
            legacy.display(),
            database.display()
        )
    })
}

fn restrict_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("{}: {error}", path.display()))
        }
        _ => Ok(()),
    }
}

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const WAL_BUSY_TIMEOUT: Duration = Duration::from_millis(50);
const WAL_BUSY_RETRY_WINDOW: Duration = Duration::from_secs(5);
const WAL_BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// WAL mode changes can return SQLITE_BUSY without invoking SQLite's busy
/// handler when multiple connections switch the same new database at once.
/// Retry only that pragma; schema transactions and other errors keep their
/// existing behavior.
fn enable_wal_mode_with_retry(
    connection: &Connection,
    path: &Path,
    mut on_busy: impl FnMut(),
) -> Result<(), String> {
    let describe = |error: rusqlite::Error| format!("{}: {error}", path.display());
    connection
        .busy_timeout(WAL_BUSY_TIMEOUT)
        .map_err(&describe)?;

    let deadline = Instant::now() + WAL_BUSY_RETRY_WINDOW;
    let result = loop {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => break Ok(()),
            Err(error) if is_busy_or_locked(&error) && Instant::now() < deadline => {
                on_busy();
                let remaining = deadline.saturating_duration_since(Instant::now());
                std::thread::sleep(WAL_BUSY_RETRY_INTERVAL.min(remaining));
            }
            Err(error) => break Err(describe(error)),
        }
    };

    let restore_timeout = connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(&describe);
    match (result, restore_timeout) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn is_busy_or_locked(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

/// Create the schema in a new database; refuse one that is not pirc's or is
/// newer than this gateway. The version is read and acted on under one
/// `BEGIN IMMEDIATE` write lock, so two processes opening the same database
/// cannot both create or migrate it; any failure rolls the whole chain back.
fn create_schema(connection: &Connection, path: &Path) -> Result<(), String> {
    let describe = |error: rusqlite::Error| format!("{}: {error}", path.display());
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(describe)?;
    let result = apply_schema(connection, path)
        .and_then(|()| crate::memory_records::index::ensure(connection).map_err(describe))
        .and_then(|()| connection.execute_batch("COMMIT").map_err(describe));
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
    }
    result
}

/// [`create_schema`]'s body, inside its transaction.
fn apply_schema(connection: &Connection, path: &Path) -> Result<(), String> {
    let describe = |error: rusqlite::Error| format!("{}: {error}", path.display());
    let application_id: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(describe)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(describe)?;
    if application_id == APPLICATION_ID {
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        if (1..SCHEMA_VERSION).contains(&version) {
            return migrate(connection, version).map_err(describe);
        }
        return Err(format!(
            "{} has schema version {version}, which this gateway (schema {SCHEMA_VERSION}) cannot read",
            path.display()
        ));
    }
    let tables: i64 = connection
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))
        .map_err(describe)?;
    if tables > 0 {
        return Err(format!(
            "{} is not a pirc database (an older gateway's gateway.sqlite, or another \
             program's); refusing to use it. This gateway starts from a new file: leave \
             PIRC_DATABASE_PATH unset or point it at a new path (docs/deploy/upgrades.md).",
            path.display()
        ));
    }
    connection
        .execute_batch(&format!(
            "{SCHEMA}\nPRAGMA application_id = {APPLICATION_ID};\nPRAGMA user_version = {SCHEMA_VERSION};"
        ))
        .map_err(describe)?;
    rooms::seed(connection).map_err(describe)
}

/// Bring an older schema up to date, inside [`create_schema`]'s transaction.
fn migrate(connection: &Connection, from: i64) -> rusqlite::Result<()> {
    for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > from) {
        connection.execute_batch(&format!("{sql}\nPRAGMA user_version = {version};"))?;
    }
    Ok(())
}

/// Storage failures are logged and become a plain 500.
impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        crate::log::error(&format!("database: {error}"));
        ApiError::internal()
    }
}

/// Run `body` atomically: a savepoint, so it nests inside a caller's
/// transaction.
pub fn atomic<T>(
    connection: &Connection,
    body: impl FnOnce(&Connection) -> ApiResult<T>,
) -> ApiResult<T> {
    /// Rolls the savepoint back unless released (an error or a panic).
    struct Guard<'a>(&'a Connection, bool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if !self.1 {
                let _ = self.0.execute_batch("ROLLBACK TO atomic; RELEASE atomic");
            }
        }
    }
    connection.execute_batch("SAVEPOINT atomic")?;
    let mut guard = Guard(connection, false);
    let value = body(connection)?;
    connection.execute_batch("RELEASE atomic")?;
    guard.1 = true;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wal_mode_retries_until_a_concurrent_write_transaction_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let blocker = Connection::open(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();

        let (busy_tx, busy_rx) = std::sync::mpsc::channel();
        let release = std::thread::spawn(move || {
            busy_rx
                .recv()
                .expect("WAL switch attempted while the write lock is held");
            blocker.execute_batch("ROLLBACK").unwrap();
        });
        let mut busy_seen = false;
        let result = enable_wal_mode_with_retry(&connection, &path, || {
            busy_seen = true;
            let _ = busy_tx.send(());
        });
        // Unblock the holder if initialization failed before reaching its retry
        // callback.
        let _ = busy_tx.send(());
        release.join().unwrap();
        result.unwrap();
        assert!(
            busy_seen,
            "the held SQLite write lock must trigger the bounded retry"
        );

        let mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");

        let busy_timeout: i64 = connection
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert_eq!(busy_timeout, SQLITE_BUSY_TIMEOUT.as_millis() as i64);
    }

    fn tables(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn concurrent_opens_create_the_schema_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let opens: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        Db::open(&path).map(drop)
                    })
                })
                .collect();
            for open in opens {
                open.join().unwrap().unwrap();
            }
        });
        let db = Db::open(&path).unwrap();
        let version: i64 = db
            .lock()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(tables(&db.lock()), tables(&Db::memory().lock()));
        // Seeded once: one #general, one host face.
        let counts: (i64, i64) = db
            .lock()
            .query_row(
                "SELECT (SELECT count(*) FROM rooms), (SELECT count(*) FROM faces)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1));
    }

    #[test]
    fn refuses_databases_that_are_not_pirc_s() {
        let dir = tempfile::tempdir().unwrap();
        // The old Rust gateway (1000..=1005), the TS gateway (1..=19), and a
        // schema version that happens to equal ours: none has the id.
        for (name, version) in [("rust.sqlite", 1005), ("ts.sqlite", 19), ("one.sqlite", 1)] {
            let path = dir.path().join(name);
            let old = Connection::open(&path).unwrap();
            old.execute_batch(&format!(
                "CREATE TABLE workspaces (id TEXT); PRAGMA user_version = {version};"
            ))
            .unwrap();
            drop(old);
            let error = Db::open(&path).err().unwrap();
            assert!(error.contains("not a pirc database"), "{error}");
            assert!(error.contains("upgrades.md"), "{error}");
            // And it is left as it was.
            let old = Connection::open(&path).unwrap();
            assert_eq!(tables(&old), ["workspaces"]);
            let kept: i64 = old
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(kept, version);
        }
    }

    /// Every table's columns, in order.
    fn columns(connection: &Connection) -> Vec<(String, Vec<String>)> {
        tables(connection)
            .into_iter()
            .map(|table| {
                let mut statement = connection
                    .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                    .unwrap();
                let names = statement
                    .query_map([], |row| row.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                (table, names)
            })
            .collect()
    }

    /// The schema of plan 01 (version 1), from today's.
    const PLAN_01: &str = "
        DROP TABLE source_items_fts;
        DROP TABLE source_items;
        DROP TABLE sources;
        DROP TABLE thread_messages;
        DROP INDEX delegations_thread;
        DROP INDEX delegations_room;
        ALTER TABLE delegations DROP COLUMN face_id;
        ALTER TABLE delegations DROP COLUMN thread_id;
        ALTER TABLE delegations DROP COLUMN anchor_message_id;
        ALTER TABLE delegations DROP COLUMN read_only;
        ALTER TABLE delegations DROP COLUMN context_json;
        ALTER TABLE delegations DROP COLUMN wake_id;
        ALTER TABLE delegations DROP COLUMN note;
        ALTER TABLE delegations RENAME COLUMN room_id TO assistant_session_id;
        CREATE INDEX delegations_assistant ON delegations(assistant_session_id, status);
        DROP TABLE wakes;
        DROP TABLE open_loops;
        ALTER TABLE memory_records DROP COLUMN open_loop_id;
        DROP TABLE brain_turns;
        DROP TABLE preferences;
        DROP TABLE memory_records_fts;
        DROP TABLE delegations_fts;
        DROP TABLE search_index_meta;
        DROP INDEX memory_records_scope;
        ALTER TABLE memory_records DROP COLUMN scope;
        ALTER TABLE memory_records DROP COLUMN room_id;
        ALTER TABLE memory_records DROP COLUMN face_id;
        ALTER TABLE memory_records DROP COLUMN origin;
        ALTER TABLE memory_records DROP COLUMN source_entry_ids_json;
        ALTER TABLE memory_records DROP COLUMN created_at;
        DROP TABLE memory_tombstones;
        CREATE TABLE memory_tombstones (
          owner_user TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT 'global', content_hash TEXT NOT NULL,
          forgotten_at INTEGER NOT NULL,
          PRIMARY KEY (owner_user, scope_id, content_hash)
        );
        CREATE TABLE memory_entries (
          id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
          status TEXT NOT NULL, revision INTEGER NOT NULL, origins_json TEXT NOT NULL,
          sources_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          created_by_session TEXT
        );
        PRAGMA user_version = 1;
    ";

    #[test]
    fn migrates_a_plan_01_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        drop(Db::open(&path).unwrap());
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(PLAN_01).unwrap();
            old.execute_batch(
                "INSERT INTO memory_entries VALUES ('u1','me','user','Prefers short answers','active',1,'[\"user\"]','{}',0,0,NULL);
                 INSERT INTO memory_entries VALUES ('n1','me','note','The NAS is called lumo','active',2,'[\"assistant\"]','{}',0,0,NULL);
                 INSERT INTO memory_tombstones VALUES ('me','global','h1',0), ('me','project','h2',0);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(columns(&conn), columns(&Db::memory().lock()));
        // USER entries are preferences, MEMORY notes the person's facts
        // (indexed), and only Forget's tombstones refuse text.
        let preference: String = conn
            .query_row("SELECT content FROM preferences WHERE id='u1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(preference, "Prefers short answers");
        let (scope, origin): (String, String) = conn
            .query_row(
                "SELECT scope, origin FROM memory_records WHERE id='n1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (scope.as_str(), origin.as_str()),
            ("person", "tool:assistant")
        );
        let found: i64 = conn
            .query_row(
                "SELECT count(*) FROM memory_records_fts WHERE memory_records_fts MATCH 'lumo' AND id='n1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(found, 1);
        let tombstones: Vec<String> = conn
            .prepare("SELECT content_hash FROM memory_tombstones")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tombstones, ["h1"]);
    }

    #[test]
    fn a_forgotten_fact_leaves_the_file_and_its_index() {
        use crate::memory_records::person;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        let sentinel = "zqxforgottensentinel";
        let content = format!("{sentinel} and 遷移秘密 again");
        let fact = person::NewFact {
            content: &content,
            origin: "user",
            room_id: None,
            face_id: None,
            source_entry_ids: &[],
            actor: "face:host",
        };
        let (fact, _) = person::remember(&conn, "me", &fact).unwrap();
        person::forget(&conn, "me", &fact.id, "user:me").unwrap();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        for needle in [sentinel, "遷移秘密", "秘密"] {
            assert!(
                !bytes
                    .windows(needle.len())
                    .any(|window| window == needle.as_bytes()),
                "{needle} is still in the file"
            );
        }
    }

    #[test]
    fn the_search_index_is_rebuilt_for_another_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        drop(Db::open(&path).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "INSERT INTO memory_records (node_id,ledger_key,id,content,relevance,recorded_at,source_ids_json,status) VALUES ('n','k','a','資料庫遷移','low','','[]','active')",
                [],
            )
            .unwrap();
            conn.execute("UPDATE search_index_meta SET version = 0", [])
                .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let found: i64 = db
            .lock()
            .query_row(
                "SELECT count(*) FROM memory_records_fts WHERE memory_records_fts MATCH '\"遷移\"'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(found, 1);
        let version: i64 = db
            .lock()
            .query_row("SELECT version FROM search_index_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, crate::memory::text::SEARCH_INDEX_VERSION);
    }

    #[test]
    fn refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        drop(Db::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        let error = Db::open(&path).err().unwrap();
        assert!(error.contains("cannot read"), "{error}");
    }

    #[test]
    fn notes_the_legacy_database_only_when_it_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join(DATABASE_FILE);
        assert_eq!(legacy_database_note(dir.path(), &database), None);
        let legacy = dir.path().join(LEGACY_DATABASE_FILE);
        std::fs::write(&legacy, b"old").unwrap();
        let note = legacy_database_note(dir.path(), &database).unwrap();
        assert!(
            note.contains("gateway.sqlite") && note.contains("not read"),
            "{note}"
        );
        // PIRC_DATABASE_PATH pointing at the old file itself is refused by
        // Db::open instead.
        assert_eq!(legacy_database_note(dir.path(), &legacy), None);
        assert_eq!(std::fs::read(&legacy).unwrap(), b"old");
    }

    #[test]
    fn deleted_content_is_zeroed() {
        let dir = tempfile::tempdir().unwrap();
        let sentinel = "forgotten-memory-sentinel-7f3a";
        let written = |db: &Connection, path: &Path| {
            db.execute_batch("CREATE TABLE scratch (x TEXT);").unwrap();
            db.execute("INSERT INTO scratch VALUES (?)", [sentinel.repeat(20)])
                .unwrap();
            db.execute("DELETE FROM scratch", []).unwrap();
            db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .unwrap();
            let bytes = std::fs::read(path).unwrap();
            bytes
                .windows(sentinel.len())
                .any(|window| window == sentinel.as_bytes())
        };
        let path = dir.path().join("db.sqlite");
        let db = Db::open(&path).unwrap();
        let on: i64 = db
            .lock()
            .pragma_query_value(None, "secure_delete", |row| row.get(0))
            .unwrap();
        assert_eq!(on, 1);
        assert!(!written(&db.lock(), &path));
        // Without the pragma the text would stay in the file.
        let plain_path = dir.path().join("plain.sqlite");
        let plain = Connection::open(&plain_path).unwrap();
        plain.pragma_update(None, "journal_mode", "WAL").unwrap();
        plain.pragma_update(None, "secure_delete", "OFF").unwrap();
        assert!(written(&plain, &plain_path));
    }

    #[test]
    fn creates_and_reopens() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        drop(Db::open(&path).unwrap());
        let db = Db::open(&path).unwrap();
        let (application_id, version): (i32, i64) = {
            let conn = db.lock();
            (
                conn.pragma_query_value(None, "application_id", |row| row.get(0))
                    .unwrap(),
                conn.pragma_query_value(None, "user_version", |row| row.get(0))
                    .unwrap(),
            )
        };
        assert_eq!((application_id, version), (APPLICATION_ID, SCHEMA_VERSION));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
