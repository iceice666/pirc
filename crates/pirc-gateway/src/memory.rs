//! The brain's memory (plans/rewrite/03-memory.md): preferences
//! ([`store`], always in its prompt), and the routes of the web app's
//! memory pages. Facts, the household's and the repositories', live in
//! [`crate::memory_records`]; open loops come with plan 04.

pub mod lines;
mod ops;
mod routes;
pub(crate) mod schema;
pub(crate) mod store;
pub(crate) mod text;

use axum::Router;
use rusqlite::Connection;
use serde_json::Value;

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::error::ApiResult;

pub use ops::{Op, recall};
pub use store::Store;

/// The preferences over `conn`, with the configured budget.
pub fn store<'a>(app: &App, conn: &'a Connection) -> Store<'a> {
    Store::new(conn, app.config.memory_budget_user)
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
