//! The node's SQLite store: the node half of `apps/gateway/src/database.ts`
//! with a fresh schema (`schema.sql`, only the tables a node uses). No
//! TS-era database is read (plans/rust-rewrite.md, decisions): one is
//! refused at start-up with a pointer to the upgrade notes, as the gateway
//! does.
//!
//! Layout: opening ([`Db::open`], WAL, 0600 files, `user_version`) and the
//! row types are implemented here; the queries ([`Store`]) are owned by
//! **core**. As in the gateway, queries are methods of [`Store`],
//! implemented for [`Connection`], so a transaction (which dereferences to a
//! connection) can combine several; modules with queries of their own
//! (memory mirror, recap, workspace-memory recall) keep them next to their
//! logic and run them on `node.db.lock()`.
//!
//! Every method returns [`ApiResult`]: a SQLite failure is logged and
//! answered as 500 `internal_error` (TS threw, and Fastify answered 500).
//! Run and lease changes must be followed by `node.activity.notify_one()`
//! (TS `onRunsChanged`), by the caller.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub use pirc_protocol::WorkspaceKind;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ApiResult;

/// `PRAGMA user_version` of the node's schema. The TS node's database used
/// the gateway's migrations (1 to 19) and the Rust gateway's schema is 1000;
/// the node's line starts apart from both, so each is recognized.
pub const SCHEMA_VERSION: i64 = 2000;
/// The Rust gateway's `user_version`.
const GATEWAY_SCHEMA_VERSION: i64 = 1000;
const SCHEMA: &str = include_str!("schema.sql");

/// Placeholder name of a new session until the agent's title replaces it.
pub const PLACEHOLDER_SESSION_NAME: &str = "New session";

/// The open store. Never hold the lock across an `await`.
pub struct Db(Mutex<Connection>);

impl Db {
    /// Open (creating) the store at `path`, readable by the owner only.
    pub fn open(path: &Path) -> Result<Self, String> {
        let describe = |error: rusqlite::Error| format!("{}: {error}", path.display());
        let connection = Connection::open(path).map_err(describe)?;
        // SQLite gives the WAL and shm files the main file's mode.
        restrict_mode(path)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(describe)?;
        for suffix in ["-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            restrict_mode(Path::new(&name))?;
        }
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(describe)?;
        create_schema(&connection, path)?;
        Ok(Self(Mutex::new(connection)))
    }

    /// An in-memory store (tests).
    pub fn memory() -> Self {
        let connection = Connection::open_in_memory().expect("an in-memory database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys");
        create_schema(&connection, Path::new(":memory:")).expect("the node schema");
        Self(Mutex::new(connection))
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A TS-era `gateway.sqlite` left in the state directory while
/// `PIRC_DATABASE_PATH` points elsewhere is refused too.
pub fn refuse_typescript_database(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if (1..GATEWAY_SCHEMA_VERSION).contains(&version) {
        return Err(typescript_era(path));
    }
    Ok(())
}

fn typescript_era(path: &Path) -> String {
    format!(
        "{} was written by the TypeScript node (pirc 0.3 or earlier). This node starts from a \
         fresh state directory: sessions start anew. See the upgrade notes \
         (docs/deploy/upgrades.md), then move the old state directory away.",
        path.display()
    )
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

/// Create the schema in a new store; refuse a TS-era one, a gateway's, or
/// one of a version this node does not know.
fn create_schema(connection: &Connection, path: &Path) -> Result<(), String> {
    let describe = |error: rusqlite::Error| format!("{}: {error}", path.display());
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(describe)?;
    match version {
        SCHEMA_VERSION => return Ok(()),
        0 => {}
        1..GATEWAY_SCHEMA_VERSION => return Err(typescript_era(path)),
        GATEWAY_SCHEMA_VERSION => {
            return Err(format!(
                "{} is a pirc-gateway database, not a node's; give the node its own state directory",
                path.display()
            ));
        }
        _ => {
            return Err(format!(
                "{} has schema version {version}, which this node ({SCHEMA_VERSION}) does not know",
                path.display()
            ));
        }
    }
    let tables: i64 = connection
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))
        .map_err(describe)?;
    if tables > 0 {
        return Err(format!(
            "{} is not empty but has no pirc schema version; refusing to use it",
            path.display()
        ));
    }
    connection
        .execute_batch(&format!(
            "BEGIN; {SCHEMA}\nPRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
        ))
        .map_err(describe)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnerState {
    Stopped,
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingInput,
    Stopping,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunStatus {
    /// Queued, running, waiting for input or stopping (`RUNNING` in TS).
    pub fn is_open(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::WaitingInput | Self::Stopping
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    Received,
    Dispatched,
    Accepted,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    Pending,
    Answered,
    Cancelled,
    Expired,
    Stale,
}

/// `user`: the user named it; `auto`: a placeholder or generated title,
/// which a new generated title may replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NameSource {
    User,
    Auto,
}

/// `Workspace` (`types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub host_id: String,
    pub display_name: String,
    pub canonical_path: String,
    pub defaults: Map<String, Value>,
    pub kind: WorkspaceKind,
}

/// `SessionRow`. Serializing it gives `publicSession(row)`, the session as
/// the gateway and clients see it: the private fields are never written.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub workspace_id: String,
    pub node_id: Option<String>,
    #[serde(skip)]
    pub owner_user: Option<String>,
    pub name: String,
    pub name_source: NameSource,
    pub runner_state: RunnerState,
    /// The newest run's status.
    pub run_status: Option<RunStatus>,
    pub runner_epoch: i64,
    pub pinned_at: Option<i64>,
    pub settled_at: Option<i64>,
    pub unread: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip)]
    pub private_session_path: String,
    #[serde(skip)]
    pub pi_session_id: Option<String>,
    #[serde(skip)]
    pub partial_output_lost: bool,
}

/// `CommandRow`, as the commands route answers it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRow {
    pub id: String,
    pub session_id: String,
    pub payload_hash: String,
    pub payload: Value,
    pub status: CommandStatus,
    /// `null` when there is none.
    pub result: Value,
    pub error: Option<String>,
}

/// `InteractionRow`, as snapshots list pending ones.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionRow {
    pub id: String,
    pub rpc_id: String,
    pub session_id: String,
    pub runner_epoch: i64,
    pub kind: String,
    pub status: InteractionStatus,
    pub request: Map<String, Value>,
    pub expires_at: i64,
}

/// A granted or renewed control lease (`{clientId, generation, expiresAt}`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub client_id: String,
    pub generation: i64,
    pub expires_at: i64,
}

/// `getLease`: the lease with whether it has expired.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseView {
    pub client_id: String,
    pub generation: i64,
    pub expires_at: i64,
    pub expired: bool,
}

/// `latestRun`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub status: RunStatus,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub failure_reason: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadKind {
    Image,
    File,
}

/// `getUpload`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRow {
    pub id: String,
    pub owner_user: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub storage_name: String,
    pub sha256: String,
    pub kind: UploadKind,
    pub filename: Option<String>,
}

/// `recoverStartup`'s counts, logged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub interrupted_runs: usize,
    pub stale_interactions: usize,
    pub unknown_commands: usize,
}

/// A row of `session_deletions`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionDeletion {
    pub owner_user: String,
    /// `deleting` or `deleted`.
    pub status: String,
}

/// The node's queries (owner: **core**), each the `GatewayDatabase`
/// method of the same name; error statuses, codes and messages as there.
pub trait Store {
    /// In one transaction: open runs → `interrupted` ("gateway restarted"),
    /// pending interactions → `stale`, dispatched commands →
    /// `outcome_unknown`, sessions not stopped → `stopped` with
    /// `partial_output_lost`, every lease deleted.
    fn recover_startup(&self) -> ApiResult<Recovery>;
    /// Upsert the configured workspaces (`PIRC_WORKSPACES`), forcing `directory`.
    fn sync_workspaces(
        &self,
        host_id: &str,
        workspaces: &[pirc_config::ConfigWorkspace],
    ) -> ApiResult<()>;
    /// Create or repair a chat workspace the node manages.
    fn ensure_chat_workspace(
        &self,
        workspace_id: &str,
        host_id: &str,
        display_name: &str,
        canonical_path: &str,
    ) -> ApiResult<Workspace>;
    /// 409 `conflict` "Workspace ID or path is already registered".
    fn add_workspace(
        &self,
        workspace_id: &str,
        host_id: &str,
        display_name: &str,
        canonical_path: &str,
        kind: WorkspaceKind,
    ) -> ApiResult<Workspace>;
    /// By display name.
    fn list_workspaces(&self) -> ApiResult<Vec<Workspace>>;
    /// 404 "Workspace not found".
    fn get_workspace(&self, workspace_id: &str) -> ApiResult<Workspace>;
    fn get_workspace_trust(&self, workspace_id: &str) -> ApiResult<Option<String>>;
    /// `None` revokes; 400 for a non-directory workspace.
    fn set_workspace_trust(
        &self,
        workspace_id: &str,
        hash: Option<&str>,
        user: &str,
    ) -> ApiResult<()>;
    /// A new session named [`PLACEHOLDER_SESSION_NAME`] (`auto`), owned by `owner_user`.
    fn create_session(
        &self,
        workspace_id: &str,
        private_session_path: &str,
        owner_user: &str,
    ) -> ApiResult<SessionRow>;
    /// 404 "Session not found".
    fn get_session(&self, session_id: &str) -> ApiResult<SessionRow>;
    /// Name it as the user did (`name_source = user`).
    fn rename_session(&self, session_id: &str, name: &str) -> ApiResult<SessionRow>;
    /// A generated title, unless the user named the session; whether it changed.
    fn auto_rename_session(&self, session_id: &str, name: &str) -> ApiResult<bool>;
    /// 403 "Session belongs to another user"; unless `deleting`, 409 while it is being deleted.
    fn claim_session(&self, session_id: &str, user: &str, deleting: bool) -> ApiResult<SessionRow>;
    fn session_deletion(&self, session_id: &str) -> ApiResult<Option<SessionDeletion>>;
    /// 409 `conflict` "This chat is being deleted. Retry Delete to finish cleanup."
    fn require_session_available(&self, session_id: &str) -> ApiResult<()>;
    fn begin_session_deletion(&self, session_id: &str, user: &str) -> ApiResult<()>;
    /// Delete the session's rows (fenced first, else an internal error).
    fn finish_session_deletion(&self, session_id: &str) -> ApiResult<()>;
    fn set_runner_state(&self, session_id: &str, state: RunnerState) -> ApiResult<()>;
    /// The next epoch (and `partial_output_lost` cleared).
    fn increment_epoch(&self, session_id: &str) -> ApiResult<i64>;
    fn set_pi_session(&self, session_id: &str, pi_session_id: Option<&str>) -> ApiResult<()>;
    /// `(session id, status)` of every open run.
    fn active_runs(&self) -> ApiResult<Vec<(String, RunStatus)>>;
    /// A `queued` run; 409 `conflict` "Session already has an active run".
    fn create_run(&self, session_id: &str) -> ApiResult<String>;
    /// `started_at` on running, `ended_at` on a final status, the failure
    /// reason cleared on running and succeeded.
    fn update_run(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
    ) -> ApiResult<()>;
    fn latest_run(&self, session_id: &str) -> ApiResult<Option<RunRow>>;
    /// The command and whether it is a duplicate; 409 `conflict` "commandId
    /// was already used with a different payload".
    fn receive_command(
        &self,
        command_id: &str,
        session_id: &str,
        hash: &str,
        payload: &Value,
    ) -> ApiResult<(CommandRow, bool)>;
    /// 404 "Command not found".
    fn get_command(&self, command_id: &str) -> ApiResult<CommandRow>;
    fn update_command(
        &self,
        command_id: &str,
        status: CommandStatus,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> ApiResult<()>;
    fn mark_dispatched_unknown(&self, session_id: &str, reason: &str) -> ApiResult<usize>;
    fn create_interaction(
        &self,
        session_id: &str,
        epoch: i64,
        rpc_id: &str,
        kind: &str,
        request: &Map<String, Value>,
        expires_at: i64,
    ) -> ApiResult<InteractionRow>;
    /// 404 "Interaction not found".
    fn get_interaction(&self, interaction_id: &str) -> ApiResult<InteractionRow>;
    /// Pending and unexpired, oldest first.
    fn pending_interactions(&self, session_id: &str) -> ApiResult<Vec<InteractionRow>>;
    /// 409 `stale_interaction` ("Interaction is no longer answerable" /
    /// "Interaction was already answered").
    fn claim_interaction(
        &self,
        interaction_id: &str,
        session_id: &str,
        epoch: i64,
        answer: &Value,
    ) -> ApiResult<InteractionRow>;
    /// The agent withdrew a dialog: the interaction id if one was pending.
    fn cancel_interaction_by_rpc_id(
        &self,
        session_id: &str,
        epoch: i64,
        rpc_id: &str,
    ) -> ApiResult<Option<String>>;
    fn stale_epoch_interactions(&self, session_id: &str, epoch: i64) -> ApiResult<()>;
    fn get_lease(&self, session_id: &str) -> ApiResult<Option<LeaseView>>;
    /// 409 `lost_control` "Another client holds control".
    fn acquire_lease(
        &self,
        session_id: &str,
        client_id: &str,
        force: bool,
        ttl_ms: u64,
    ) -> ApiResult<Lease>;
    /// 409 `lost_control` "Control lease is missing, expired, or superseded".
    fn validate_lease(&self, session_id: &str, client_id: &str, generation: i64) -> ApiResult<()>;
    fn heartbeat_lease(
        &self,
        session_id: &str,
        client_id: &str,
        generation: i64,
        ttl_ms: u64,
    ) -> ApiResult<Lease>;
    fn release_lease(&self, session_id: &str, client_id: &str, generation: i64) -> ApiResult<()>;
    fn create_upload(&self, upload: &UploadRow) -> ApiResult<()>;
    /// 404 "Upload not found".
    fn get_upload(&self, upload_id: &str) -> ApiResult<UploadRow>;
}

impl Store for Connection {
    fn recover_startup(&self) -> ApiResult<Recovery> {
        todo!("core")
    }
    fn sync_workspaces(
        &self,
        host_id: &str,
        workspaces: &[pirc_config::ConfigWorkspace],
    ) -> ApiResult<()> {
        let _ = (host_id, workspaces);
        todo!("core")
    }
    fn ensure_chat_workspace(
        &self,
        workspace_id: &str,
        host_id: &str,
        display_name: &str,
        canonical_path: &str,
    ) -> ApiResult<Workspace> {
        let _ = (workspace_id, host_id, display_name, canonical_path);
        todo!("core")
    }
    fn add_workspace(
        &self,
        workspace_id: &str,
        host_id: &str,
        display_name: &str,
        canonical_path: &str,
        kind: WorkspaceKind,
    ) -> ApiResult<Workspace> {
        let _ = (workspace_id, host_id, display_name, canonical_path, kind);
        todo!("core")
    }
    fn list_workspaces(&self) -> ApiResult<Vec<Workspace>> {
        todo!("core")
    }
    fn get_workspace(&self, workspace_id: &str) -> ApiResult<Workspace> {
        let _ = workspace_id;
        todo!("core")
    }
    fn get_workspace_trust(&self, workspace_id: &str) -> ApiResult<Option<String>> {
        let _ = workspace_id;
        todo!("core")
    }
    fn set_workspace_trust(
        &self,
        workspace_id: &str,
        hash: Option<&str>,
        user: &str,
    ) -> ApiResult<()> {
        let _ = (workspace_id, hash, user);
        todo!("core")
    }
    fn create_session(
        &self,
        workspace_id: &str,
        private_session_path: &str,
        owner_user: &str,
    ) -> ApiResult<SessionRow> {
        let _ = (workspace_id, private_session_path, owner_user);
        todo!("core")
    }
    fn get_session(&self, session_id: &str) -> ApiResult<SessionRow> {
        let _ = session_id;
        todo!("core")
    }
    fn rename_session(&self, session_id: &str, name: &str) -> ApiResult<SessionRow> {
        let _ = (session_id, name);
        todo!("core")
    }
    fn auto_rename_session(&self, session_id: &str, name: &str) -> ApiResult<bool> {
        let _ = (session_id, name);
        todo!("core")
    }
    fn claim_session(&self, session_id: &str, user: &str, deleting: bool) -> ApiResult<SessionRow> {
        let _ = (session_id, user, deleting);
        todo!("core")
    }
    fn session_deletion(&self, session_id: &str) -> ApiResult<Option<SessionDeletion>> {
        let _ = session_id;
        todo!("core")
    }
    fn require_session_available(&self, session_id: &str) -> ApiResult<()> {
        let _ = session_id;
        todo!("core")
    }
    fn begin_session_deletion(&self, session_id: &str, user: &str) -> ApiResult<()> {
        let _ = (session_id, user);
        todo!("core")
    }
    fn finish_session_deletion(&self, session_id: &str) -> ApiResult<()> {
        let _ = session_id;
        todo!("core")
    }
    fn set_runner_state(&self, session_id: &str, state: RunnerState) -> ApiResult<()> {
        let _ = (session_id, state);
        todo!("core")
    }
    fn increment_epoch(&self, session_id: &str) -> ApiResult<i64> {
        let _ = session_id;
        todo!("core")
    }
    fn set_pi_session(&self, session_id: &str, pi_session_id: Option<&str>) -> ApiResult<()> {
        let _ = (session_id, pi_session_id);
        todo!("core")
    }
    fn active_runs(&self) -> ApiResult<Vec<(String, RunStatus)>> {
        todo!("core")
    }
    fn create_run(&self, session_id: &str) -> ApiResult<String> {
        let _ = session_id;
        todo!("core")
    }
    fn update_run(
        &self,
        run_id: &str,
        status: RunStatus,
        failure_reason: Option<&str>,
    ) -> ApiResult<()> {
        let _ = (run_id, status, failure_reason);
        todo!("core")
    }
    fn latest_run(&self, session_id: &str) -> ApiResult<Option<RunRow>> {
        let _ = session_id;
        todo!("core")
    }
    fn receive_command(
        &self,
        command_id: &str,
        session_id: &str,
        hash: &str,
        payload: &Value,
    ) -> ApiResult<(CommandRow, bool)> {
        let _ = (command_id, session_id, hash, payload);
        todo!("core")
    }
    fn get_command(&self, command_id: &str) -> ApiResult<CommandRow> {
        let _ = command_id;
        todo!("core")
    }
    fn update_command(
        &self,
        command_id: &str,
        status: CommandStatus,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> ApiResult<()> {
        let _ = (command_id, status, result, error);
        todo!("core")
    }
    fn mark_dispatched_unknown(&self, session_id: &str, reason: &str) -> ApiResult<usize> {
        let _ = (session_id, reason);
        todo!("core")
    }
    fn create_interaction(
        &self,
        session_id: &str,
        epoch: i64,
        rpc_id: &str,
        kind: &str,
        request: &Map<String, Value>,
        expires_at: i64,
    ) -> ApiResult<InteractionRow> {
        let _ = (session_id, epoch, rpc_id, kind, request, expires_at);
        todo!("core")
    }
    fn get_interaction(&self, interaction_id: &str) -> ApiResult<InteractionRow> {
        let _ = interaction_id;
        todo!("core")
    }
    fn pending_interactions(&self, session_id: &str) -> ApiResult<Vec<InteractionRow>> {
        let _ = session_id;
        todo!("core")
    }
    fn claim_interaction(
        &self,
        interaction_id: &str,
        session_id: &str,
        epoch: i64,
        answer: &Value,
    ) -> ApiResult<InteractionRow> {
        let _ = (interaction_id, session_id, epoch, answer);
        todo!("core")
    }
    fn cancel_interaction_by_rpc_id(
        &self,
        session_id: &str,
        epoch: i64,
        rpc_id: &str,
    ) -> ApiResult<Option<String>> {
        let _ = (session_id, epoch, rpc_id);
        todo!("core")
    }
    fn stale_epoch_interactions(&self, session_id: &str, epoch: i64) -> ApiResult<()> {
        let _ = (session_id, epoch);
        todo!("core")
    }
    fn get_lease(&self, session_id: &str) -> ApiResult<Option<LeaseView>> {
        let _ = session_id;
        todo!("core")
    }
    fn acquire_lease(
        &self,
        session_id: &str,
        client_id: &str,
        force: bool,
        ttl_ms: u64,
    ) -> ApiResult<Lease> {
        let _ = (session_id, client_id, force, ttl_ms);
        todo!("core")
    }
    fn validate_lease(&self, session_id: &str, client_id: &str, generation: i64) -> ApiResult<()> {
        let _ = (session_id, client_id, generation);
        todo!("core")
    }
    fn heartbeat_lease(
        &self,
        session_id: &str,
        client_id: &str,
        generation: i64,
        ttl_ms: u64,
    ) -> ApiResult<Lease> {
        let _ = (session_id, client_id, generation, ttl_ms);
        todo!("core")
    }
    fn release_lease(&self, session_id: &str, client_id: &str, generation: i64) -> ApiResult<()> {
        let _ = (session_id, client_id, generation);
        todo!("core")
    }
    fn create_upload(&self, upload: &UploadRow) -> ApiResult<()> {
        let _ = upload;
        todo!("core")
    }
    fn get_upload(&self, upload_id: &str) -> ApiResult<UploadRow> {
        let _ = upload_id;
        todo!("core")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_private_and_refuses_other_databases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.sqlite");
        let db = Db::open(&path).unwrap();
        let version: i64 = db
            .lock()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let journal: String = db
            .lock()
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        drop(db);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // Opening again keeps it.
        Db::open(&path).unwrap();
        refuse_typescript_database(&path).unwrap();

        for (version, message) in [
            (19, "TypeScript node"),
            (1000, "pirc-gateway database"),
            (5000, "does not know"),
        ] {
            let other = dir.path().join(format!("{version}.sqlite"));
            let connection = Connection::open(&other).unwrap();
            connection
                .execute_batch(&format!(
                    "CREATE TABLE t (x); PRAGMA user_version = {version};"
                ))
                .unwrap();
            drop(connection);
            let error = Db::open(&other).err().unwrap();
            assert!(error.contains(message), "{error}");
        }
        assert!(
            refuse_typescript_database(&dir.path().join("19.sqlite"))
                .unwrap_err()
                .contains("upgrade notes")
        );
        let unversioned = dir.path().join("unversioned.sqlite");
        Connection::open(&unversioned)
            .unwrap()
            .execute_batch("CREATE TABLE t (x);")
            .unwrap();
        assert!(
            Db::open(&unversioned)
                .err()
                .unwrap()
                .contains("no pirc schema version")
        );
    }

    #[test]
    fn sessions_serialize_as_the_public_row() {
        let row = SessionRow {
            id: "session_1".into(),
            workspace_id: "w".into(),
            node_id: None,
            owner_user: Some("u".into()),
            name: PLACEHOLDER_SESSION_NAME.into(),
            name_source: NameSource::Auto,
            runner_state: RunnerState::Stopped,
            run_status: Some(RunStatus::WaitingInput),
            runner_epoch: 0,
            pinned_at: None,
            settled_at: None,
            unread: false,
            created_at: 1,
            updated_at: 2,
            private_session_path: "/secret".into(),
            pi_session_id: Some("pi".into()),
            partial_output_lost: true,
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            serde_json::json!({ "id": "session_1", "workspaceId": "w", "nodeId": null,
                "name": "New session", "nameSource": "auto", "runnerState": "stopped",
                "runStatus": "waiting_input", "runnerEpoch": 0, "pinnedAt": null,
                "settledAt": null, "unread": false, "createdAt": 1, "updatedAt": 2 })
        );
        Db::memory();
    }
}
