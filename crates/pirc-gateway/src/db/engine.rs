//! The engine's index (plans/rewrite/01-rooms.md): workspaces, sessions,
//! commands and leases. The nodes own the sessions; the gateway keeps which
//! node has each, who owns it, and the browser commands sent to it.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::atomic;
use crate::error::{ApiError, ApiResult};
use crate::util::{new_id, now_ms, safe_json};

pub use pirc_protocol::mode::ModeId;

/// Placeholder name of a new session until the agent's title replaces it.
pub const PLACEHOLDER_SESSION_NAME: &str = "New session";

/// A workspace as clients see it (its stored `canonical_path` is a
/// gateway-internal unique key and is not read).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub host_id: String,
    pub display_name: String,
    pub defaults: Value,
    pub mode: ModeId,
    /// Its repository's normalized `origin`, as its node last reported it.
    #[serde(skip)]
    pub repo: Option<String>,
}

impl Workspace {
    pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            host_id: row.get("host_id")?,
            display_name: row.get("display_name")?,
            defaults: safe_json(&row.get::<_, String>("defaults_json")?, json!({})),
            mode: ModeId::new(row.get::<_, String>("kind")?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    std::io::Error::new(std::io::ErrorKind::InvalidData, error).into(),
                )
            })?,
            repo: row.get("repo")?,
        })
    }

    /// The node's own id of the workspace (`<nodeId>:<local>`), when it is a node's.
    pub fn local_id(&self) -> Option<&str> {
        self.id
            .strip_prefix(self.host_id.as_str())
            .and_then(|rest| rest.strip_prefix(':'))
    }
}

/// A session row. Serializing gives the public session (`publicSession`):
/// the node's session id and the owner never leave the gateway.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub node_id: Option<String>,
    pub name: String,
    /// `auto`: a placeholder or generated title that a new one may replace.
    pub name_source: String,
    pub runner_state: String,
    /// Finished runs are the nodes' business; the gateway never records one.
    pub run_status: Option<String>,
    pub runner_epoch: i64,
    pub pinned_at: Option<i64>,
    pub settled_at: Option<i64>,
    pub unread: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip)]
    pub owner_user: Option<String>,
    #[serde(skip)]
    pub pi_session_id: Option<String>,
}

impl Session {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let activity: Option<i64> = row.get("activity_at")?;
        let read: Option<i64> = row.get("read_at")?;
        Ok(Self {
            id: row.get("id")?,
            workspace_id: row.get("workspace_id")?,
            node_id: row.get("node_id")?,
            owner_user: row.get("owner_user")?,
            name: row.get("name")?,
            name_source: if row.get::<_, String>("name_source")? == "auto" {
                "auto".into()
            } else {
                "user".into()
            },
            runner_state: row.get("runner_state")?,
            run_status: None,
            runner_epoch: row.get("runner_epoch")?,
            pinned_at: row.get("pinned_at")?,
            settled_at: row.get("settled_at")?,
            unread: activity.is_some_and(|activity| activity > read.unwrap_or(0)),
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            pi_session_id: row.get("pi_session_id")?,
        })
    }

    /// The public session as JSON.
    pub fn public(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// A browser command, kept for idempotency.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub session_id: String,
    pub payload_hash: String,
    pub payload: Value,
    pub status: String,
    pub result: Value,
    pub error: Option<String>,
}

impl Command {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let result: Option<String> = row.get("result_json")?;
        Ok(Self {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            payload_hash: row.get("payload_hash")?,
            payload: safe_json(&row.get::<_, String>("payload_json")?, Value::Null),
            status: row.get("status")?,
            result: result.map_or(Value::Null, |result| safe_json(&result, Value::Null)),
            error: row.get("error_text")?,
        })
    }
}

/// What started a session other than the user.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionOrigin {
    #[serde(rename_all = "camelCase")]
    Delegation {
        delegation_id: String,
        title: String,
        from_session_id: String,
        /// The delegation's status (`running`, `waiting_input`,
        /// `completed`, `failed`): delegated sessions are left as they are
        /// once their result is delivered, so the list says how they ended.
        status: String,
    },
}

/// A node's lease as it reports it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub client_id: String,
    pub generation: i64,
    pub expires_at: i64,
}

fn session_not_found() -> ApiError {
    ApiError::not_found("Session not found")
}

/// The gateway's queries; see the module documentation.
pub trait Store {
    fn recover_startup(&self) -> ApiResult<RecoveredStartup>;

    fn sync_remote_workspaces(
        &self,
        node_id: &str,
        workspaces: &[(String, String, ModeId)],
    ) -> ApiResult<()>;
    /// Record the repositories a node reported for its workspaces (local
    /// ids), and give their mirrored notes that had none the same.
    fn set_workspace_repos(
        &self,
        node_id: &str,
        repos: &[(String, Option<String>)],
    ) -> ApiResult<()>;
    fn list_workspaces(&self) -> ApiResult<Vec<Workspace>>;
    /// 404 "Workspace not found".
    fn get_workspace(&self, workspace_id: &str) -> ApiResult<Workspace>;
    fn find_workspace(&self, workspace_id: &str) -> ApiResult<Option<Workspace>>;

    fn create_session(
        &self,
        workspace_id: &str,
        private_session_path: &str,
        node_id: &str,
        remote_session_id: &str,
        owner_user: &str,
    ) -> ApiResult<Session>;
    fn list_sessions(&self) -> ApiResult<Vec<Session>>;
    fn get_session(&self, session_id: &str) -> ApiResult<Session>;
    fn rename_session(&self, session_id: &str, name: &str) -> ApiResult<Session>;
    fn set_session_flags(
        &self,
        session_id: &str,
        pinned: Option<bool>,
        settled: Option<bool>,
    ) -> ApiResult<Session>;
    fn mark_session_activity(&self, session_id: &str) -> ApiResult<()>;
    fn mark_session_read(&self, session_id: &str) -> ApiResult<bool>;
    fn auto_rename_session(&self, session_id: &str, name: &str) -> ApiResult<bool>;
    fn claim_session(&self, session_id: &str, user: &str) -> ApiResult<Session>;
    fn session_origins(&self, owner_user: &str) -> ApiResult<Vec<(String, SessionOrigin)>>;
    fn resolve_remote_session(&self, node_id: &str, remote_id: &str) -> ApiResult<Option<String>>;
    fn interrupt_remote_session(&self, session_id: &str) -> ApiResult<()>;
    fn remote_session_ids(&self, node_id: &str) -> ApiResult<Vec<String>>;
    fn set_runner_state(&self, session_id: &str, state: &str) -> ApiResult<()>;
    fn increment_epoch(&self, session_id: &str) -> ApiResult<i64>;

    fn receive_command(
        &self,
        command_id: &str,
        session_id: &str,
        hash: &str,
        payload: &Value,
    ) -> ApiResult<(Command, bool)>;
    fn get_command(&self, command_id: &str) -> ApiResult<Command>;
    fn update_command(
        &self,
        command_id: &str,
        status: &str,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> ApiResult<()>;

    fn check_lease_user(&self, session_id: &str, user: &str, force: bool) -> ApiResult<()>;
    fn mirror_lease(
        &self,
        session_id: &str,
        lease: &Lease,
        user: &str,
        force: bool,
    ) -> ApiResult<()>;
    fn clear_remote_lease(&self, session_id: &str) -> ApiResult<()>;
    fn validate_lease_user(&self, session_id: &str, user: &str) -> ApiResult<()>;
    fn get_lease(&self, session_id: &str) -> ApiResult<Value>;
    fn validate_lease(&self, session_id: &str, client_id: &str, generation: i64) -> ApiResult<()>;
}

/// What startup recovery found (logged).
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredStartup {
    pub unknown_commands: usize,
}

const SESSION_SELECT: &str = "SELECT * FROM sessions";

impl Store for Connection {
    /// Commands in flight when the gateway stopped have an unknown outcome;
    /// runners and leases belong to nodes that reconnect.
    fn recover_startup(&self) -> ApiResult<RecoveredStartup> {
        let stamp = now_ms();
        atomic(self, |tx| {
            let unknown_commands = tx.execute(
            "UPDATE commands SET status='outcome_unknown', error_text='gateway restarted before RPC acceptance was recorded', updated_at=? WHERE status='dispatched'",
            [stamp],
        )?;
            tx.execute(
            "UPDATE sessions SET runner_state='stopped', partial_output_lost=1, updated_at=? WHERE runner_state!='stopped'",
            [stamp],
        )?;
            tx.execute("DELETE FROM leases", [])?;
            Ok(RecoveredStartup { unknown_commands })
        })
    }

    fn sync_remote_workspaces(
        &self,
        node_id: &str,
        workspaces: &[(String, String, ModeId)],
    ) -> ApiResult<()> {
        atomic(self, |tx| {
            let mut insert = tx.prepare(
                "INSERT INTO workspaces (id,host_id,display_name,canonical_path,defaults_json,created_at,kind) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, kind=excluded.kind",
            )?;
            for (id, display_name, kind) in workspaces {
                insert.execute(params![
                    format!("{node_id}:{id}"),
                    node_id,
                    display_name,
                    format!("node://{node_id}/{id}"),
                    "{}",
                    now_ms(),
                    kind.as_str(),
                ])?;
            }
            Ok(())
        })
    }

    fn set_workspace_repos(
        &self,
        node_id: &str,
        repos: &[(String, Option<String>)],
    ) -> ApiResult<()> {
        atomic(self, |tx| {
            for (id, repo) in repos {
                let id = format!("{node_id}:{id}");
                let repo = repo
                    .as_deref()
                    .filter(|repo| pirc_protocol::valid_repo(repo));
                let changed =
                    tx.execute("UPDATE workspaces SET repo=? WHERE id=?", params![repo, id])?;
                // Only a directory workspace has a repository: a key reported for a chat
                // workspace must not tag its notes or links either.
                if changed == 0 {
                    continue;
                }
                if let Some(repo) = repo {
                    tx.execute(
                        "UPDATE memory_records SET repo=? WHERE workspace_id=? AND repo IS NULL AND status!='forgotten'",
                        params![repo, id],
                    )?;
                    // Links made before the repository was known cover its clones from now on.
                    tx.execute(
                        "UPDATE project_links SET repo=? WHERE workspace_id=? AND repo IS NULL",
                        params![repo, id],
                    )?;
                }
            }
            Ok(())
        })
    }

    fn list_workspaces(&self) -> ApiResult<Vec<Workspace>> {
        let mut statement = self.prepare("SELECT * FROM workspaces ORDER BY display_name")?;
        let rows = statement.query_map([], Workspace::from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn get_workspace(&self, workspace_id: &str) -> ApiResult<Workspace> {
        self.find_workspace(workspace_id)?
            .ok_or_else(|| ApiError::not_found("Workspace not found"))
    }

    fn find_workspace(&self, workspace_id: &str) -> ApiResult<Option<Workspace>> {
        Ok(self
            .query_row(
                "SELECT * FROM workspaces WHERE id=?",
                [workspace_id],
                Workspace::from_row,
            )
            .optional()?)
    }

    fn create_session(
        &self,
        workspace_id: &str,
        private_session_path: &str,
        node_id: &str,
        remote_session_id: &str,
        owner_user: &str,
    ) -> ApiResult<Session> {
        self.get_workspace(workspace_id)?;
        let session_id = new_id("session");
        let stamp = now_ms();
        self.execute(
            "INSERT INTO sessions (id,workspace_id,private_session_path,name,name_source,node_id,pi_session_id,owner_user,created_at,updated_at) VALUES (?,?,?,?,'auto',?,?,?,?,?)",
            params![
                session_id,
                workspace_id,
                private_session_path,
                PLACEHOLDER_SESSION_NAME,
                node_id,
                remote_session_id,
                owner_user,
                stamp,
                stamp
            ],
        )?;
        self.get_session(&session_id)
    }

    fn list_sessions(&self) -> ApiResult<Vec<Session>> {
        let mut statement = self.prepare(&format!("{SESSION_SELECT} ORDER BY updated_at DESC"))?;
        let rows = statement.query_map([], Session::from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn get_session(&self, session_id: &str) -> ApiResult<Session> {
        self.query_row(
            &format!("{SESSION_SELECT} WHERE id=?"),
            [session_id],
            Session::from_row,
        )
        .optional()?
        .ok_or_else(session_not_found)
    }

    fn rename_session(&self, session_id: &str, name: &str) -> ApiResult<Session> {
        self.get_session(session_id)?;
        self.execute(
            "UPDATE sessions SET name=?, name_source='user', updated_at=? WHERE id=?",
            params![name, now_ms(), session_id],
        )?;
        self.get_session(session_id)
    }

    /// Sidebar organisation only: never touches `updated_at`.
    fn set_session_flags(
        &self,
        session_id: &str,
        pinned: Option<bool>,
        settled: Option<bool>,
    ) -> ApiResult<Session> {
        let session = self.get_session(session_id)?;
        let stamp = now_ms();
        let next = |wanted: Option<bool>, current: Option<i64>| match wanted {
            None => current,
            Some(true) => Some(current.unwrap_or(stamp)),
            Some(false) => None,
        };
        self.execute(
            "UPDATE sessions SET pinned_at=?, settled_at=? WHERE id=?",
            params![
                next(pinned, session.pinned_at),
                next(settled, session.settled_at),
                session_id
            ],
        )?;
        self.get_session(session_id)
    }

    /// The agent finished a run or stopped to ask something: unread until read.
    fn mark_session_activity(&self, session_id: &str) -> ApiResult<()> {
        self.execute(
            "UPDATE sessions SET activity_at=? WHERE id=?",
            params![now_ms(), session_id],
        )?;
        Ok(())
    }

    fn mark_session_read(&self, session_id: &str) -> ApiResult<bool> {
        Ok(self.execute(
            "UPDATE sessions SET read_at=MAX(?, activity_at) WHERE id=? AND activity_at > COALESCE(read_at, 0)",
            params![now_ms(), session_id],
        )? > 0)
    }

    /// A generated title, unless the user has named the session.
    fn auto_rename_session(&self, session_id: &str, name: &str) -> ApiResult<bool> {
        Ok(self.execute(
            "UPDATE sessions SET name=? WHERE id=? AND name_source='auto' AND name!=?",
            params![name, session_id, name],
        )? > 0)
    }

    /// Every session belongs to the user who created it.
    fn claim_session(&self, session_id: &str, user: &str) -> ApiResult<Session> {
        let session = self.get_session(session_id)?;
        if session.owner_user.as_deref() != Some(user) {
            return Err(ApiError::new(
                403,
                "forbidden",
                "Session belongs to another user",
            ));
        }
        Ok(session)
    }

    /// Sessions a delegation started, with what started them (the newest
    /// when a delegation follows up in the same session).
    fn session_origins(&self, owner_user: &str) -> ApiResult<Vec<(String, SessionOrigin)>> {
        let mut origins = Vec::new();
        let mut delegated = self.prepare(
            "SELECT id, target_session_id, assistant_session_id, title, status FROM delegations WHERE owner_user=? AND target_session_id IS NOT NULL ORDER BY created_at",
        )?;
        for row in delegated.query_map([owner_user], |row| {
            Ok((
                row.get::<_, String>(1)?,
                SessionOrigin::Delegation {
                    delegation_id: row.get(0)?,
                    from_session_id: row.get(2)?,
                    title: row.get(3)?,
                    status: row.get(4)?,
                },
            ))
        })? {
            origins.push(row?);
        }
        Ok(origins)
    }

    fn resolve_remote_session(&self, node_id: &str, remote_id: &str) -> ApiResult<Option<String>> {
        Ok(self
            .query_row(
                "SELECT id FROM sessions WHERE node_id=? AND pi_session_id=?",
                [node_id, remote_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn interrupt_remote_session(&self, session_id: &str) -> ApiResult<()> {
        self.execute(
            "UPDATE commands SET status='outcome_unknown', error_text='node disconnected', updated_at=? WHERE session_id=? AND status='dispatched'",
            params![now_ms(), session_id],
        )?;
        self.execute("DELETE FROM leases WHERE session_id=?", [session_id])?;
        Ok(())
    }

    fn remote_session_ids(&self, node_id: &str) -> ApiResult<Vec<String>> {
        let mut statement = self.prepare("SELECT id FROM sessions WHERE node_id=?")?;
        let rows = statement.query_map([node_id], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn set_runner_state(&self, session_id: &str, state: &str) -> ApiResult<()> {
        self.execute(
            "UPDATE sessions SET runner_state=?, updated_at=? WHERE id=?",
            params![state, now_ms(), session_id],
        )?;
        Ok(())
    }

    fn increment_epoch(&self, session_id: &str) -> ApiResult<i64> {
        self.execute(
            "UPDATE sessions SET runner_epoch=runner_epoch+1, partial_output_lost=0, updated_at=? WHERE id=?",
            params![now_ms(), session_id],
        )?;
        Ok(self.get_session(session_id)?.runner_epoch)
    }

    /// Record a command once; a retry with the same id and payload is a
    /// duplicate, with another payload a conflict.
    fn receive_command(
        &self,
        command_id: &str,
        session_id: &str,
        hash: &str,
        payload: &Value,
    ) -> ApiResult<(Command, bool)> {
        atomic(self, |tx| {
            let existing = tx
                .query_row(
                    "SELECT * FROM commands WHERE id=?",
                    [command_id],
                    Command::from_row,
                )
                .optional()?;
            if let Some(existing) = existing {
                if existing.session_id != session_id || existing.payload_hash != hash {
                    return Err(ApiError::new(
                        409,
                        "conflict",
                        "commandId was already used with a different payload",
                    ));
                }
                return Ok((existing, true));
            }
            let stamp = now_ms();
            tx.execute(
            "INSERT INTO commands (id,session_id,payload_hash,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,'received',?,?)",
            params![command_id, session_id, hash, payload.to_string(), stamp, stamp],
        )?;
            Ok((tx.get_command(command_id)?, false))
        })
    }

    fn get_command(&self, command_id: &str) -> ApiResult<Command> {
        self.query_row(
            "SELECT * FROM commands WHERE id=?",
            [command_id],
            Command::from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Command not found"))
    }

    fn update_command(
        &self,
        command_id: &str,
        status: &str,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> ApiResult<()> {
        self.execute(
            "UPDATE commands SET status=?, result_json=?, error_text=?, updated_at=? WHERE id=?",
            params![
                status,
                result.map(Value::to_string),
                error,
                now_ms(),
                command_id
            ],
        )?;
        Ok(())
    }

    fn check_lease_user(&self, session_id: &str, user: &str, force: bool) -> ApiResult<()> {
        let current: Option<(Option<String>, i64)> = self
            .query_row(
                "SELECT owner_user, expires_at FROM leases WHERE session_id=?",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((owner, expires_at)) = current
            && expires_at > now_ms()
            && owner.as_deref() != Some(user)
            && !force
        {
            return Err(ApiError::new(
                409,
                "lost_control",
                "Another user holds control",
            ));
        }
        Ok(())
    }

    fn mirror_lease(
        &self,
        session_id: &str,
        lease: &Lease,
        user: &str,
        force: bool,
    ) -> ApiResult<()> {
        self.check_lease_user(session_id, user, force)?;
        self.execute(
            "INSERT INTO leases (session_id,client_id,generation,expires_at,updated_at,owner_user) VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET client_id=excluded.client_id,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at,owner_user=excluded.owner_user",
            params![
                session_id,
                lease.client_id,
                lease.generation,
                lease.expires_at,
                now_ms(),
                user
            ],
        )?;
        Ok(())
    }

    fn clear_remote_lease(&self, session_id: &str) -> ApiResult<()> {
        self.execute("DELETE FROM leases WHERE session_id=?", [session_id])?;
        Ok(())
    }

    fn validate_lease_user(&self, session_id: &str, user: &str) -> ApiResult<()> {
        let owner: Option<Option<String>> = self
            .query_row(
                "SELECT owner_user FROM leases WHERE session_id=?",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.flatten().as_deref() != Some(user) {
            return Err(ApiError::new(
                409,
                "lost_control",
                "Control belongs to another user",
            ));
        }
        Ok(())
    }

    fn get_lease(&self, session_id: &str) -> ApiResult<Value> {
        let lease = self
            .query_row(
                "SELECT client_id, generation, expires_at FROM leases WHERE session_id=?",
                [session_id],
                |row| {
                    let expires_at: i64 = row.get(2)?;
                    Ok(json!({
                        "clientId": row.get::<_, String>(0)?,
                        "generation": row.get::<_, i64>(1)?,
                        "expiresAt": expires_at,
                        "expired": expires_at <= now_ms(),
                    }))
                },
            )
            .optional()?;
        Ok(lease.unwrap_or(Value::Null))
    }

    fn validate_lease(&self, session_id: &str, client_id: &str, generation: i64) -> ApiResult<()> {
        let lease: Option<(String, i64, i64)> = self
            .query_row(
                "SELECT client_id, generation, expires_at FROM leases WHERE session_id=?",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match lease {
            Some((client, current, expires_at))
                if client == client_id && current == generation && expires_at > now_ms() =>
            {
                Ok(())
            }
            _ => Err(ApiError::new(
                409,
                "lost_control",
                "Control lease is missing, expired, or superseded",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn with_workspace(db: &Db) {
        db.lock()
            .sync_remote_workspaces(
                "n1",
                &[("w".into(), "W".into(), ModeId::new("chat").unwrap())],
            )
            .unwrap();
    }

    #[test]
    fn sessions() {
        let db = Db::memory();
        with_workspace(&db);
        let conn = db.lock();
        let session = conn
            .create_session("n1:w", "node://n1/r1", "n1", "r1", "u")
            .unwrap();
        let public = session.public();
        assert_eq!(public["name"], "New session");
        assert_eq!(public["nameSource"], "auto");
        assert_eq!(public["nodeId"], "n1");
        assert!(public.get("ownerUser").is_none());
        assert!(public.get("piSessionId").is_none());
        assert_eq!(
            conn.resolve_remote_session("n1", "r1").unwrap().as_deref(),
            Some(session.id.as_str())
        );
        assert!(conn.auto_rename_session(&session.id, "Title").unwrap());
        conn.rename_session(&session.id, "Mine").unwrap();
        assert!(!conn.auto_rename_session(&session.id, "Other").unwrap());
        assert_eq!(
            conn.claim_session(&session.id, "v").unwrap_err().code,
            "forbidden"
        );
        assert!(!conn.mark_session_read(&session.id).unwrap());
        conn.mark_session_activity(&session.id).unwrap();
        assert!(conn.get_session(&session.id).unwrap().unread);
        assert!(conn.mark_session_read(&session.id).unwrap());
        let flagged = conn
            .set_session_flags(&session.id, Some(true), None)
            .unwrap();
        assert!(flagged.pinned_at.is_some() && flagged.settled_at.is_none());
        assert_eq!(conn.increment_epoch(&session.id).unwrap(), 1);
        assert_eq!(conn.claim_session(&session.id, "u").unwrap().id, session.id);
    }

    #[test]
    fn commands_and_leases() {
        let db = Db::memory();
        with_workspace(&db);
        let conn = db.lock();
        let session = conn
            .create_session("n1:w", "node://n1/r1", "n1", "r1", "u")
            .unwrap();
        let payload = json!({ "type": "prompt" });
        let (_, duplicate) = conn
            .receive_command("c1", &session.id, "h", &payload)
            .unwrap();
        assert!(!duplicate);
        assert!(
            conn.receive_command("c1", &session.id, "h", &payload)
                .unwrap()
                .1
        );
        assert_eq!(
            conn.receive_command("c1", &session.id, "other", &payload)
                .unwrap_err()
                .code,
            "conflict"
        );
        conn.update_command("c1", "accepted", Some(&json!({ "ok": true })), None)
            .unwrap();
        assert_eq!(conn.get_command("c1").unwrap().result["ok"], true);

        let lease = Lease {
            client_id: "b".into(),
            generation: 1,
            expires_at: now_ms() + 60_000,
        };
        conn.mirror_lease(&session.id, &lease, "u", false).unwrap();
        conn.validate_lease(&session.id, "b", 1).unwrap();
        conn.validate_lease_user(&session.id, "u").unwrap();
        assert!(conn.validate_lease(&session.id, "b", 2).is_err());
        assert!(conn.mirror_lease(&session.id, &lease, "v", false).is_err());
        conn.mirror_lease(&session.id, &lease, "v", true).unwrap();
        assert_eq!(conn.get_lease(&session.id).unwrap()["expired"], false);
        conn.clear_remote_lease(&session.id).unwrap();
        assert_eq!(conn.get_lease(&session.id).unwrap(), Value::Null);
    }
}
