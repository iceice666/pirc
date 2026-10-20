//! The memory operations of node sessions: `memory.search` and
//! `recall.remote` (repositories' notes only).

use pirc_protocol::{HttpMethod, NodeHttpRequest};
use serde_json::{Value, json};

use super::schema::{hex12, int, optional, required, strict, string};
use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::error::{ApiError, ApiResult};
use crate::memory_records;

/// A parsed memory operation of a node session.
pub enum Op {
    Search {
        query: String,
        workspace: Option<String>,
        limit: Option<i64>,
        everywhere: bool,
    },
    Recall {
        id: String,
    },
}

fn parse_search(args: &Value) -> Result<Op, ()> {
    let object = strict(args, &["query", "workspace", "limit", "everywhere"]).ok_or(())?;
    Ok(Op::Search {
        query: required(object, "query", |value| {
            string(value, 1, 500).map(str::to_owned)
        })?,
        workspace: optional(object, "workspace", |value| {
            string(value, 1, 300).map(str::to_owned)
        })?,
        limit: optional(object, "limit", |value| {
            int(value).filter(|n| (1..=20).contains(n))
        })?,
        everywhere: optional(object, "everywhere", Value::as_bool)?.unwrap_or(false),
    })
}

pub fn parse_op(op: &str, args: &Value) -> Option<Result<Op, ()>> {
    Some(match op {
        "memory.search" => parse_search(args),
        "recall.remote" => strict(args, &["id"])
            .and_then(|object| object.get("id"))
            .and_then(hex12)
            .map(|id| Op::Recall { id: id.to_owned() })
            .ok_or(()),
        _ => return None,
    })
}

/// Node sessions (workers) have no memory of the household: the brain's
/// memory stays in the gateway (direction §2.7). Searching the
/// repositories' notes stays theirs to have (a decision of 2026-10-20), but
/// no worker has the tool until plans/rewrite/06-workers.md hands it out;
/// until then every operation is refused. Person-scope facts are never
/// served here.
fn require_worker_search(_context: &OpContext) -> ApiResult<()> {
    Err(ApiError::new(
        403,
        "forbidden",
        "No session has memory search yet",
    ))
}

pub async fn run_op(app: &AppState, context: &OpContext, op: Op) -> ApiResult<Value> {
    let user = context.user.as_str();
    match op {
        Op::Search {
            query,
            workspace,
            limit,
            everywhere,
        } => {
            require_worker_search(context)?;
            // In a project linked to workspaces, those (and their clones) first.
            let (hits, searched) = memory_records::search_in(
                app,
                user,
                &query,
                workspace.as_deref(),
                limit,
                Some(&context.workspace.id),
                everywhere,
            )?;
            let mut result = json!({ "hits": hits });
            if let Some(searched) = searched {
                result["searched"] = json!(searched.name());
            }
            Ok(result)
        }
        Op::Recall { id } => {
            require_worker_search(context)?;
            recall(app, user, &id).await
        }
    }
}

/// Recall a workspace-memory note found by search: its node reads the
/// session that wrote it. With the node offline, the gateway's copy.
pub async fn recall(app: &App, user: &str, id: &str) -> ApiResult<Value> {
    let found = memory_records::find(app, user, id)?;
    if found.is_empty() {
        return Err(ApiError::not_found(format!(
            "No workspace memory note {id}"
        )));
    }
    let mut parts = Vec::new();
    for record in found {
        let online = app.nodes.get(&record.node_id).is_some();
        if online {
            let response = app
                .nodes
                .request(
                    &record.node_id,
                    NodeHttpRequest {
                        method: HttpMethod::Post,
                        url: "/api/workspace-memory/recall".into(),
                        user: user.to_owned(),
                        payload: Some(json!({ "ledgerKey": record.ledger_key, "id": id })),
                        body_base64: None,
                        content_type: None,
                    },
                )
                .await;
            if let Ok(response) = response
                && response.status < 400
                && let Some(text) = response
                    .body
                    .as_ref()
                    .and_then(|body| body.get("text"))
                    .and_then(Value::as_str)
            {
                parts.push(format!("{}:\n{text}", record.workspace));
                continue;
            }
        }
        let status = if record.status == "active" {
            String::new()
        } else {
            format!(" [{}]", record.status)
        };
        let source = if online {
            format!("{} could not read its source now.", record.node_id)
        } else {
            format!(
                "{} is offline, so the session that wrote it cannot be read now.",
                record.node_id
            )
        };
        parts.push(format!(
            "Workspace memory ({}), as the gateway last saw it:\n[{id}] {}{status} {}\n{source}",
            record.workspace, record.date, record.content
        ));
    }
    Ok(json!({ "text": parts.join("\n\n"), "status": "ok" }))
}
