//! Deleting a chat project (docs/guides/chat-projects.md, "Deleting a
//! project"): `GET /api/workspaces/:id/deletion` shows what goes and what
//! stays, `POST` with the user's decisions on mixed memory entries deletes.
//!
//! The fence, origin-based memory plan and durable completion receipt commit
//! together before Node cleanup. Retrying completes Node/Gateway removal without
//! reinterpreting memory decisions or touching later user edits. Only current
//! member chats are destroyed; moved authors' old memory keeps its write-time origin.
//! Legacy origins need explicit review. The node must be online.

use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::routing::get;
use pirc_protocol::HttpMethod;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::{App, AppState, ReqBody, forward};
use crate::auth::Identity;
use crate::db::{DeletionStatus, Session, Store, Workspace, atomic};
use crate::error::{ApiError, ApiResult};
use crate::http::{no_content, ok};
use crate::memory::{ProjectChoice, ProjectDecision, ProjectProposalDecision};
use crate::routes::{Handled, urlencoding_component};

/// Decisions one request may carry.
const DECISIONS_MAX: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/workspaces/{workspace_id}/deletion",
        get(preview).post(delete),
    )
}

fn offline() -> ApiError {
    ApiError::new(
        503,
        "node_offline",
        "Connect the chat node before deleting this project",
    )
}

/// The project, if `user` may delete it; `Ok(None)` once it is deleted.
fn project(
    app: &App,
    conn: &Connection,
    workspace_id: &str,
    user: &str,
) -> ApiResult<Option<Workspace>> {
    if !conn.checkpoint_workspace_visible_to_user(workspace_id, user)? {
        return Err(ApiError::not_found("Workspace not found"));
    }
    if let Some(deletion) = conn.workspace_deletion(workspace_id)? {
        if deletion.owner_user != user {
            return Err(ApiError::new(
                403,
                "forbidden",
                "Project belongs to another user",
            ));
        }
        if deletion.status == DeletionStatus::Deleted {
            return Ok(None);
        }
    }
    let workspace = conn
        .find_workspace(workspace_id)?
        .ok_or_else(|| ApiError::not_found("Workspace not found"))?;
    if !crate::project_links::is_project(&app.catalog(), &workspace) {
        return Err(ApiError::new(
            400,
            "invalid_input",
            "Only chat projects can be deleted",
        ));
    }
    for session_id in conn.workspace_session_ids(workspace_id)? {
        if conn.get_session(&session_id)?.owner_user.as_deref() != Some(user) {
            return Err(ApiError::new(
                403,
                "forbidden",
                "The project has another user's chats",
            ));
        }
    }
    Ok(Some(workspace))
}

fn sessions(conn: &Connection, workspace_id: &str) -> ApiResult<Vec<Session>> {
    conn.workspace_session_ids(workspace_id)?
        .iter()
        .map(|id| conn.get_session(id))
        .collect()
}

/// Rows of `sql` (one `?` per value) as JSON objects of `columns`.
fn rows(conn: &Connection, sql: &str, values: &[&str], columns: &[&str]) -> ApiResult<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(values), |row| {
        let mut object = serde_json::Map::new();
        for (index, column) in columns.iter().enumerate() {
            let value: Option<String> = row.get(index)?;
            object.insert((*column).to_owned(), json!(value));
        }
        Ok(Value::Object(object))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(",")
}

/// `GET /api/workspaces/:id/deletion`.
async fn preview(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(workspace_id): Path<String>,
) -> Handled {
    let user = identity.user.as_str();
    let conn = app.db.lock();
    let Some(workspace) = project(&app, &conn, &workspace_id, user)? else {
        return Err(ApiError::not_found("Workspace not found").into());
    };
    let chats = sessions(&conn, &workspace_id)?;
    let ids: Vec<String> = chats.iter().map(|session| session.id.clone()).collect();
    let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let schedules = rows(
        &conn,
        "SELECT id, title FROM schedules WHERE workspace_id=? ORDER BY created_at, id",
        &[&workspace_id],
        &["id", "title"],
    )?;
    let (kept_schedules, delegations) = if ids.is_empty() {
        (Vec::new(), 0)
    } else {
        let mut values = id_refs.clone();
        values.push(&workspace_id);
        let kept = rows(
            &conn,
            &format!(
                "SELECT s.id, s.title, s.workspace_id, w.display_name FROM schedules s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.created_by_session IN ({}) AND s.workspace_id!=? ORDER BY s.created_at, s.id",
                placeholders(ids.len())
            ),
            &values,
            &["id", "title", "workspaceId", "workspaceName"],
        )?;
        let delegations: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM delegations WHERE assistant_session_id IN ({})",
                    placeholders(ids.len())
                ),
                rusqlite::params_from_iter(&id_refs),
                |row| row.get(0),
            )
            .map_err(ApiError::from)?;
        (kept, delegations)
    };
    let links: i64 = conn
        .query_row(
            "SELECT count(*) FROM project_links WHERE project_workspace_id=?",
            [&workspace_id],
            |row| row.get(0),
        )
        .map_err(ApiError::from)?;
    let memory = crate::memory::project_plan(&app, &conn, user, &workspace_id)?;
    let memory_proposals = crate::memory::project_proposals(&app, &conn, user, &workspace_id)?;
    let memory_cleanup_complete =
        crate::memory::project_cleanup_complete(&conn, user, &workspace_id)?;
    let deleting = conn.workspace_deletion(&workspace_id)?.is_some();
    drop(conn);
    Ok(ok(json!({
        "project": { "id": workspace.id, "displayName": workspace.display_name },
        "nodeOnline": app.nodes.get(&workspace.host_id).is_some(),
        "deleting": deleting,
        "chats": chats.iter().map(|s| json!({ "id": s.id, "name": s.name })).collect::<Vec<_>>(),
        "schedules": schedules,
        "keptSchedules": kept_schedules,
        "delegations": delegations,
        "links": links,
        "memory": memory,
        "memoryProposals": memory_proposals,
        "memoryCleanupComplete": memory_cleanup_complete,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeleteBody {
    #[serde(default)]
    decisions: Vec<DecisionBody>,
    #[serde(default)]
    proposal_decisions: Vec<ProposalDecisionBody>,
    #[serde(default)]
    memory_review_version: Option<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DecisionBody {
    entry_id: String,
    revision: i64,
    action: String,
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProposalDecisionBody {
    proposal_id: String,
    status: String,
    action: String,
}
fn proposal_decisions(
    items: Vec<ProposalDecisionBody>,
) -> ApiResult<Vec<(String, ProjectProposalDecision)>> {
    if items.len() > DECISIONS_MAX {
        return Err(ApiError::invalid_input());
    }
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .map(|d| {
            if d.proposal_id.is_empty()
                || d.proposal_id.len() > 100
                || !seen.insert(d.proposal_id.clone())
                || !matches!(
                    d.status.as_str(),
                    "pending" | "approved" | "rejected" | "superseded"
                )
            {
                return Err(ApiError::invalid_input());
            }
            let forget = match d.action.as_str() {
                "forget" => true,
                "keep" => false,
                _ => return Err(ApiError::invalid_input()),
            };
            Ok((
                d.proposal_id,
                ProjectProposalDecision {
                    status: d.status,
                    forget,
                },
            ))
        })
        .collect()
}

fn decisions(items: Vec<DecisionBody>) -> ApiResult<Vec<(String, ProjectDecision)>> {
    if items.len() > DECISIONS_MAX {
        return Err(ApiError::invalid_input());
    }
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .map(|decision| {
            if decision.entry_id.is_empty()
                || decision.entry_id.len() > 100
                || !seen.insert(decision.entry_id.clone())
            {
                return Err(ApiError::invalid_input());
            }
            let choice = match (decision.action.as_str(), decision.content) {
                ("forget", None) => ProjectChoice::Forget,
                ("keep", None) => ProjectChoice::Keep,
                ("edit", Some(content)) if content.encode_utf16().count() <= 10_000 => {
                    ProjectChoice::Edit(content)
                }
                _ => return Err(ApiError::invalid_input()),
            };
            Ok((
                decision.entry_id,
                ProjectDecision {
                    revision: decision.revision,
                    choice,
                },
            ))
        })
        .collect()
}

/// `POST /api/workspaces/:id/deletion`: 204 once the project is gone.
async fn delete(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(workspace_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let user = identity.user.as_str();
    let body: DeleteBody = body.parse()?;
    let memory_review_version = body.memory_review_version;
    if memory_review_version.is_some_and(|v| v != 1) {
        return Err(ApiError::invalid_input().into());
    }
    let decisions = decisions(body.decisions)?;
    let proposal_decisions = proposal_decisions(body.proposal_decisions)?;
    let workspace = {
        let conn = app.db.lock();
        match project(&app, &conn, &workspace_id, user)? {
            Some(workspace) => workspace,
            None => return Ok(no_content()),
        }
    };
    let Some(local_id) = workspace.local_id().map(str::to_owned) else {
        return Err(ApiError::internal().into());
    };
    if app.nodes.get(&workspace.host_id).is_none() {
        return Err(offline().into());
    }
    // (1) Fence, memory and cleanup receipt are one transaction.
    {
        let conn = app.db.lock();
        atomic(&conn, |conn| {
            if memory_review_version != Some(1)
                && (crate::memory::project_plan(&app, conn, user, &workspace_id)?
                    .iter()
                    .any(|e| e.unknown_origin)
                    || crate::memory::project_proposals(&app, conn, user, &workspace_id)?
                        .iter()
                        .any(|p| p.action == crate::memory::ProjectAction::Review))
            {
                return Err(ApiError::new(
                    409,
                    "memory_review_required",
                    "Update this client to review memory with unknown project origins before deleting this project",
                ));
            }
            conn.begin_workspace_deletion(&workspace_id, user)?;
            crate::memory::delete_project(
                &app,
                conn,
                user,
                &workspace_id,
                &decisions,
                &proposal_decisions,
            )
        })?;
    }
    app.memory_changed(user);
    app.directory_changed();
    // (2) The node.
    let response = app
        .relay(
            &workspace.host_id,
            &identity,
            HttpMethod::Delete,
            format!("/api/workspaces/{}", urlencoding_component(&local_id)),
            None,
        )
        .await?;
    // A node that no longer has the project (its state restored from before
    // it existed) has nothing left to delete.
    let gone = response.status == 404
        && response
            .body
            .as_ref()
            .and_then(|body| body["error"]["message"].as_str())
            == Some("Workspace not found");
    if response.status >= 400 && !gone {
        return Ok(forward(response));
    }
    // (3) The gateway's rows.
    let deleted = {
        let conn = app.db.lock();
        atomic(&conn, |conn| finish(&app, conn, user, &workspace_id))?
    };
    app.nodes.remove_workspace(&workspace.host_id, &local_id);
    for session in &deleted {
        app.events.publish(
            &session.id,
            session.runner_epoch,
            "session_deleted",
            json!({ "sessionId": session.id }),
        );
        app.events.forget(&session.id);
    }
    app.memory_changed(user);
    app.sessions_changed(Some(user));
    app.schedules_changed(user);
    app.directory_changed();
    Ok(no_content())
}

/// Step (3): the sessions it deleted.
fn finish(
    _app: &App,
    conn: &Connection,
    user: &str,
    workspace_id: &str,
) -> ApiResult<Vec<Session>> {
    let chats = sessions(conn, workspace_id)?;
    if !crate::memory::project_cleanup_complete(conn, user, workspace_id)? {
        return Err(ApiError::internal());
    }
    for id in chats.iter().map(|session| &session.id) {
        conn.finish_session_deletion(id)?;
    }
    // Schedules that run in the project, with their history.
    conn.execute(
        "DELETE FROM schedule_proposals WHERE schedule_id IN (SELECT id FROM schedules WHERE workspace_id=?)",
        [workspace_id],
    )?;
    conn.execute(
        "DELETE FROM schedule_runs WHERE schedule_id IN (SELECT id FROM schedules WHERE workspace_id=?)",
        [workspace_id],
    )?;
    conn.execute("DELETE FROM schedules WHERE workspace_id=?", [workspace_id])?;
    for sql in [
        "DELETE FROM project_links WHERE project_workspace_id=?",
        "DELETE FROM workspace_capabilities WHERE workspace_id=?",
        "DELETE FROM delegations WHERE workspace_id=?",
        "DELETE FROM memory_records WHERE workspace_id=?",
        "DELETE FROM workspaces WHERE id=?",
    ] {
        conn.execute(sql, [workspace_id])?;
    }
    conn.execute(
        "UPDATE workspace_deletions SET status='deleted' WHERE workspace_id=?",
        params![workspace_id],
    )?;
    Ok(chats)
}

#[cfg(test)]
mod tests;
