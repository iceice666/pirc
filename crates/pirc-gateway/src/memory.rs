//! The assistant's memory (`apps/gateway/src/daemon/memory.ts`,
//! `memory-interactions.ts`, `memory-routes.ts`) and its agent operations
//! (`assistant.context`, `memory.note`, `memory.proposeUser`,
//! `memory.search`, `recall.remote` in `agent-ops.ts`).

mod interactions;
mod ops;
mod provenance;
mod routes;
pub(crate) mod schema;
mod store;
pub(crate) mod text;

use axum::Router;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::db::{Store as _, atomic};
use crate::error::{ApiError, ApiResult};

pub use ops::Op;
pub use store::{
    Budgets, ProjectAction, ProjectChoice, ProjectDecision, ProjectEntry, ProjectProposal,
    ProjectProposalDecision, Store,
};

/// The memory store over `conn`, with the configured budgets.
pub fn store<'a>(app: &App, conn: &'a Connection) -> Store<'a> {
    Store::new(
        conn,
        Budgets {
            user: app.config.memory_budget_user,
            note: app.config.memory_budget_note,
        },
    )
}

pub fn parse_op(op: &str, args: &Value) -> Option<Result<Op, ()>> {
    ops::parse_op(op, args)
}

pub async fn run_op(app: &AppState, context: &OpContext, op: Op) -> ApiResult<Value> {
    ops::run_op(app, context, op).await
}

/// `/api/memory*`.
pub fn routes() -> Router<AppState> {
    routes::routes()
}

/// Forget what memory learned from a deleted chat (`MemoryStore.forgetSession`),
/// inside the deletion's transaction.
pub fn forget_session(app: &App, conn: &Connection, user: &str, session_id: &str) -> ApiResult<()> {
    let project_cleanup: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM project_memory_cleanup_sessions s JOIN project_memory_cleanup c USING(workspace_id) WHERE s.session_id=? AND c.owner_user=?)",[session_id,user],|r| r.get(0))?;
    if project_cleanup {
        return Ok(());
    }
    interactions::ensure_known(app, conn);
    store(app, conn).forget_session(user, session_id)
}

/// Whether the global-memory part of this deletion already committed.
pub fn project_cleanup_complete(conn: &Connection, user: &str, scope: &str) -> ApiResult<bool> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT owner_user FROM project_memory_cleanup WHERE workspace_id=?",
            [scope],
            |r| r.get(0),
        )
        .optional()?;
    if owner.as_ref().is_some_and(|owner| owner != user) {
        return Err(ApiError::new(
            403,
            "forbidden",
            "Project belongs to another user",
        ));
    }
    Ok(owner.is_some())
}

pub fn project_plan(
    app: &App,
    conn: &Connection,
    user: &str,
    scope: &str,
) -> ApiResult<Vec<ProjectEntry>> {
    if project_cleanup_complete(conn, user, scope)? {
        return Ok(Vec::new());
    }
    store(app, conn).project_plan(user, scope)
}
pub fn project_proposals(
    app: &App,
    conn: &Connection,
    user: &str,
    scope: &str,
) -> ApiResult<Vec<ProjectProposal>> {
    if project_cleanup_complete(conn, user, scope)? {
        return Ok(Vec::new());
    }
    store(app, conn).project_proposals(user, scope)
}

/// Memory effects and receipt commit with the project fence. No final sweep:
/// later edits must not be overwritten when the remote cleanup is retried.
pub fn delete_project(
    app: &App,
    conn: &Connection,
    user: &str,
    scope: &str,
    decisions: &[(String, ProjectDecision)],
    proposal_decisions: &[(String, ProjectProposalDecision)],
) -> ApiResult<()> {
    atomic(conn, |conn| {
        if project_cleanup_complete(conn, user, scope)? {
            return Ok(());
        }
        let deletion = conn
            .workspace_deletion(scope)?
            .ok_or_else(ApiError::internal)?;
        if deletion.owner_user != user {
            return Err(ApiError::new(
                403,
                "forbidden",
                "Project belongs to another user",
            ));
        }
        interactions::ensure_known(app, conn);
        store(app, conn).delete_project(user, scope, decisions, proposal_decisions)?;
        conn.execute(
            "INSERT INTO project_memory_cleanup VALUES(?,?,1,?)",
            params![scope, user, crate::util::now_ms()],
        )?;
        conn.execute("INSERT INTO project_memory_cleanup_sessions SELECT id,workspace_id FROM sessions WHERE workspace_id=?",[scope])?;
        Ok(())
    })
}

/// The user's memory changed (`MemoryInteractions.changed`): its pending
/// proposals' interactions are published to their sessions. Hints are the caller's.
pub fn changed(app: &App, user: &str) {
    interactions::changed(app, user);
}

/// Pending USER-memory proposals of the session, as interactions.
pub fn pending_interactions(app: &App, session_id: &str, user: &str) -> Vec<Value> {
    let conn = app.db.lock();
    interactions::pending(&store(app, &conn), session_id, user).unwrap_or_default()
}

/// Answer a memory proposal's interaction; `None` when it is not one.
pub fn answer(
    app: &App,
    session_id: &str,
    interaction_id: &str,
    user: &str,
    answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    interactions::answer(app, session_id, interaction_id, user, answer)
}

#[cfg(test)]
pub(crate) mod tests;
