//! Operations an agent may ask the gateway for through its node
//! (`agent_request`; `apps/gateway/src/daemon/agent-ops.ts`). The node names
//! the session. An operation runs only if it is allowlisted, the session
//! belongs to that node and to a user who is still allowed; an agent can
//! never act as another session.
//!
//! Each area parses and runs its own operations (`memory`, `delegations`,
//! `web_search`); this module does the common checks in the TS
//! order: unknown session, foreign session, unknown op, invalid arguments,
//! then the op.

use serde_json::{Value, json};

use crate::app::AppState;
use crate::db::{Session, Store, Workspace};
use crate::error::ApiError;
use crate::{delegations, memory, web_search};

/// Who is asking.
pub struct OpContext {
    pub session: Session,
    pub workspace: Workspace,
    pub mode: pirc_protocol::Mode,
    pub user: String,
}

fn agent_error(status: u16, code: &str, message: &str) -> (u16, Value) {
    (
        status,
        json!({ "error": { "code": code, "message": message } }),
    )
}

/// One area's parsed operation.
enum Parsed {
    Memory(memory::Op),
    Delegation(delegations::Op),
    Web(web_search::Op),
}

/// `None`: no such operation; `Some(Err)`: invalid arguments.
fn parse(op: &str, args: &Value) -> Option<Result<Parsed, ()>> {
    if let Some(parsed) = memory::parse_op(op, args) {
        return Some(parsed.map(Parsed::Memory));
    }
    if let Some(parsed) = delegations::parse_op(op, args) {
        return Some(parsed.map(Parsed::Delegation));
    }
    web_search::parse_op(op, args).map(|parsed| parsed.map(Parsed::Web))
}

/// Answer an agent's operation: `(status, body)`, `{result}` on success.
pub async fn run(
    app: &AppState,
    node_id: &str,
    remote_session_id: &str,
    op: &str,
    args: Value,
) -> (u16, Value) {
    let session = {
        let conn = app.db.lock();
        let Ok(Some(session_id)) = conn.resolve_remote_session(node_id, remote_session_id) else {
            return agent_error(404, "not_found", "The gateway does not know this session");
        };
        match conn.get_session(&session_id) {
            Ok(session) => session,
            Err(_) => {
                return agent_error(404, "not_found", "The gateway does not know this session");
            }
        }
    };
    let user = match &session.owner_user {
        Some(user)
            if session.node_id.as_deref() == Some(node_id)
                && app.config.auth.allowed_users.contains(user) =>
        {
            user.clone()
        }
        _ => return agent_error(403, "forbidden", "This session may not use the gateway"),
    };
    let Some(parsed) = parse(op, &args) else {
        return agent_error(
            404,
            "unknown_operation",
            &format!("Unknown gateway operation: {op}"),
        );
    };
    let Ok(parsed) = parsed else {
        return agent_error(400, "invalid_input", &format!("Invalid arguments for {op}"));
    };
    let outcome = async {
        let workspace = app.db.lock().get_workspace(&session.workspace_id)?;
        let mode = app.require_mode(&workspace)?;
        let context = OpContext {
            mode,
            session,
            workspace,
            user,
        };
        match parsed {
            Parsed::Memory(op) => memory::run_op(app, &context, op).await,
            Parsed::Delegation(op) => delegations::run_op(app, &context, op).await,
            Parsed::Web(op) => web_search::run_op(app, &context, op).await,
        }
    }
    .await;
    match outcome {
        Ok(result) => (200, json!({ "result": result })),
        Err(ApiError {
            status,
            code,
            message,
            details,
        }) => {
            let mut error = json!({ "code": code, "message": message });
            if let Some(details) = details {
                error["details"] = details;
            }
            (status, json!({ "error": error }))
        }
    }
}
