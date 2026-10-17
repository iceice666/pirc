//! Deleting a chat project (docs/guides/chat-projects.md, "Deleting a
//! project"): `GET /api/workspaces/:id/deletion` shows what goes and what
//! stays, `POST` with the user's decisions on mixed memory entries deletes.
//!
//! Order, each step safe to repeat: (1) one transaction fences the project
//! and its chats (`workspace_deletions`, `session_deletions`) and deletes
//! the memory its chats wrote (`memory::delete_project`, strict: every
//! entry needing review has a decision on its current revision); (2) the
//! chat node deletes its chats, uploads, browser profile and directory;
//! (3) one transaction sweeps memory again (what arrived in between) and
//! deletes the gateway's rows. A failure after (1) leaves the project
//! fenced and listed as `deleting`; Delete again redoes (1) for what is
//! left (the entries the user kept come up again) and resumes. The memory
//! of a project covers its chats deleted one by one before (recorded in
//! `session_deletions.workspace_id` since schema 1004). The fence row stays, without
//! content, so a node announcing the project again cannot recreate it.
//!
//! Requires the chat node online: there is no pending state.

use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::routing::get;
use pirc_protocol::HttpMethod;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::{App, AppState, ReqBody, forward};
use crate::auth::Identity;
use crate::db::{Session, Store, Workspace, atomic};
use crate::error::{ApiError, ApiResult};
use crate::http::{no_content, ok};
use crate::memory::{ProjectChoice, ProjectDecision};
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
fn project(conn: &Connection, workspace_id: &str, user: &str) -> ApiResult<Option<Workspace>> {
    if let Some(deletion) = conn.workspace_deletion(workspace_id)? {
        if deletion.owner_user != user {
            return Err(ApiError::new(
                403,
                "forbidden",
                "Project belongs to another user",
            ));
        }
        if deletion.status == "deleted" {
            return Ok(None);
        }
    }
    let workspace = conn
        .find_workspace(workspace_id)?
        .ok_or_else(|| ApiError::not_found("Workspace not found"))?;
    if !crate::project_links::is_project(&workspace) {
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
    let Some(workspace) = project(&conn, &workspace_id, user)? else {
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
    let history = conn.workspace_history_session_ids(&workspace_id)?;
    let memory = crate::memory::project_plan(&app, &conn, user, &history)?;
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
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteBody {
    #[serde(default)]
    decisions: Vec<DecisionBody>,
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

fn decisions(body: DeleteBody) -> ApiResult<Vec<(String, ProjectDecision)>> {
    if body.decisions.len() > DECISIONS_MAX {
        return Err(ApiError::invalid_input());
    }
    body.decisions
        .into_iter()
        .map(|decision| {
            if decision.entry_id.is_empty() || decision.entry_id.len() > 100 {
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
    let decisions = decisions(body.parse()?)?;
    let workspace = {
        let conn = app.db.lock();
        match project(&conn, &workspace_id, user)? {
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
    // (1) The fence and the memory, together. A retry does it again: what
    // was done is not in the plan any more, and entries the user kept are
    // decided again.
    {
        let conn = app.db.lock();
        atomic(&conn, |conn| {
            conn.begin_workspace_deletion(&workspace_id, user)?;
            let ids = conn.workspace_history_session_ids(&workspace_id)?;
            crate::memory::delete_project(&app, conn, user, &ids, &workspace_id, &decisions, true)
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
fn finish(app: &App, conn: &Connection, user: &str, workspace_id: &str) -> ApiResult<Vec<Session>> {
    let chats = sessions(conn, workspace_id)?;
    let history = conn.workspace_history_session_ids(workspace_id)?;
    crate::memory::delete_project(app, conn, user, &history, workspace_id, &[], false)?;
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
