//! Durable user-only adoption. The main node DB atomically binds one job to a
//! new owned workspace/session; no history, tools or memory are replayed.
use super::Scope;
use crate::{
    error::{ApiError, ApiResult},
    services::Node,
    store::{SessionRow, Store, Workspace},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;
use std::path::Path;

pub fn roots(db: &Connection) -> ApiResult<BTreeMap<String, String>> {
    let mut s=db.prepare("SELECT w.id,w.canonical_path FROM workspaces w JOIN checkpoint_workspaces r ON r.workspace_id=w.id")?;
    Ok(s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}
pub fn is_workspace(db: &Connection, id: &str) -> ApiResult<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM checkpoint_workspaces WHERE workspace_id=?1)",
        [id],
        |r| r.get(0),
    )?)
}
pub fn require_workspace_owner(db: &Connection, id: &str, user: &str) -> ApiResult<()> {
    let owner: Option<String> = db
        .query_row(
            "SELECT owner FROM checkpoint_workspaces WHERE workspace_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if owner.is_some_and(|o| o != user) {
        return Err(ApiError::not_found("Workspace not found"));
    }
    Ok(())
}
/// Return only opaque origin identities to the already-authorized workspace
/// owner. Gateway resolves the local identities and rechecks source visibility.
pub fn origin(
    db: &Connection,
    workspace: &str,
    user: &str,
) -> ApiResult<Option<serde_json::Value>> {
    let row: Option<(String,String,String,String)> = db.query_row(
        "SELECT i.source_session,i.capture,w.job,i.scope_json FROM checkpoint_workspaces w JOIN checkpoint_intents i ON i.job=w.job WHERE w.workspace_id=?1 AND w.owner=?2",
        params![workspace,user], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
    ).optional()?;
    row.map(|(session,capture,job,json)| {
        let scope: Scope = serde_json::from_str(&json).map_err(|_|ApiError::internal())?;
        Ok(serde_json::json!({"sessionId":session,"workspaceId":scope.workspace,"captureId":capture,"jobId":job}))
    }).transpose()
}
pub fn mapped(
    db: &Connection,
    job: &str,
    user: &str,
    source: &str,
) -> ApiResult<Option<(Workspace, SessionRow)>> {
    let row:Option<(String,String)>=db.query_row("SELECT workspace_id,session_id FROM checkpoint_workspaces w JOIN checkpoint_intents i ON i.job=w.job WHERE w.job=?1 AND w.owner=?2 AND i.source_session=?3",params![job,user,source],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(w, s)| Ok((db.get_workspace(&w)?, db.claim_session(&s, user, false)?)))
        .transpose()
}
#[allow(clippy::too_many_arguments)]
pub fn intent(
    db: &Connection,
    job: &str,
    user: &str,
    source: &str,
    capture: &str,
    revision: i64,
    current_revision: i64,
    accept: bool,
    scope: &Scope,
) -> ApiResult<()> {
    let old:Option<(String,String,String,i64,bool)>=db.query_row("SELECT owner,source_session,capture,expected_revision,accept_unresolved FROM checkpoint_intents WHERE job=?1",[job],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    if let Some(old) = old {
        if (&old.0, &old.1, &old.2) != (&user.to_owned(), &source.to_owned(), &capture.to_owned()) {
            return Err(ApiError::conflict(
                "Recovery confirmation belongs to another scope",
            ));
        }
        if (old.3, old.4) == (revision, accept) {
            return Ok(());
        }
        if revision != current_revision {
            return Err(ApiError::conflict(
                "Recovery confirmation already handled or stale",
            ));
        }
        db.execute("UPDATE checkpoint_intents SET expected_revision=?2,accept_unresolved=?3,scope_json=?4 WHERE job=?1",params![job,revision,accept,serde_json::to_string(scope).map_err(|_|ApiError::internal())?])?;
        return Ok(());
    }
    db.execute("INSERT INTO checkpoint_intents(job,owner,source_session,capture,expected_revision,accept_unresolved,scope_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![job,user,source,capture,revision,accept,serde_json::to_string(scope).map_err(|_|ApiError::internal())?,crate::util::now_ms()])?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub fn adopt(
    node: &Node,
    source: &SessionRow,
    scope: &Scope,
    capture: &str,
    job: &str,
    root: &Path,
    client: &str,
    generation: i64,
) -> ApiResult<(Workspace, SessionRow)> {
    let mut db = node.db.lock();
    let tx = db.transaction()?;
    tx.validate_lease(&source.id, client, generation)?;
    if let Some(existing) = mapped(&tx, job, &scope.owner, &source.id)? {
        return Ok(existing);
    }
    let original = tx.get_workspace(&source.workspace_id)?;
    let id = format!("recovery_{job}");
    let workspace = tx.add_workspace(
        &id,
        &node.config.node_id,
        crate::util::head16(&format!("Recovery · {}", original.display_name), 200),
        &root.to_string_lossy(),
        original.mode,
    )?;
    let defaults = serde_json::json!({"checkpointOrigin":{"sourceSessionId":source.id,"captureId":capture,"jobId":job}});
    tx.execute(
        "UPDATE workspaces SET defaults_json=?2 WHERE id=?1",
        params![id, defaults.to_string()],
    )?;
    let private = node
        .config
        .sessions_dir
        .join(crate::util::prefix_uuid("pi"));
    // Its private session directory is created by normal runner startup.
    let session = tx.create_session(&workspace.id, &private.to_string_lossy(), &scope.owner)?;
    let session = tx.rename_session(
        &session.id,
        crate::util::head16(&format!("Recovery · {}", source.name), 200),
    )?;
    tx.execute("INSERT INTO checkpoint_workspaces(workspace_id,job,owner,session_id,created_at) VALUES(?1,?2,?3,?4,?5)",params![workspace.id,job,scope.owner,session.id,crate::util::now_ms()])?;
    let workspace = tx.get_workspace(&workspace.id)?;
    tx.commit()?;
    drop(db);
    node.recovery_roots
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .insert(workspace.id.clone(), workspace.canonical_path.clone());
    if let Some(service) = &node.checkpoints {
        service.inherit(&workspace.id, &source.workspace_id);
    }
    Ok((workspace, session))
}
/// Existing adopted workspaces restart independently of later original edits.
/// The original remains protected; ownership, identity and the writer lock are
/// revalidated each time. Adoption is never inferred from a caller's path.
pub async fn runner_ticket(
    node: &Node,
    workspace: &Workspace,
    user: &str,
) -> ApiResult<Option<super::isolation::RecoveryIsolation>> {
    let row:Option<(String,String)>=node.db.lock().query_row("SELECT w.job,i.scope_json FROM checkpoint_workspaces w JOIN checkpoint_intents i ON i.job=w.job WHERE w.workspace_id=?1 AND w.owner=?2",params![workspace.id,user],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((id, json)) = row else {
        return Ok(None);
    };
    let scope: Scope = serde_json::from_str(&json)
        .map_err(|_| ApiError::conflict("Recovery origin metadata is unavailable"))?;
    let service = node.checkpoints.as_ref().ok_or_else(|| {
        ApiError::conflict("Checkpoint service is disabled; recovery execution unavailable")
    })?;
    let factory = service
        .recovery_factory(Default::default())
        .map_err(super::api::failure)?;
    factory
        .reopen_adopted(scope, id, workspace.canonical_path.clone().into())
        .await
        .map(Some)
        .map_err(super::api::failure)
}
