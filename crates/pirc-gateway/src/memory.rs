//! The assistant's memory (`apps/gateway/src/daemon/memory.ts`,
//! `memory-routes.ts`) and its agent operations (`assistant.context`,
//! `memory.note`, `memory.search`, `recall.remote` in `agent-ops.ts`).

mod ops;
mod routes;
pub(crate) mod schema;
mod store;
pub(crate) mod text;

use axum::Router;
use rusqlite::Connection;
use serde_json::Value;

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::error::ApiResult;

pub use ops::Op;
pub use store::{Budgets, Store};

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

#[cfg(test)]
pub(crate) mod tests;
