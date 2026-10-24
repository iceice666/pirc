//! Convert authenticated Node progress into metadata-only pots evidence.
//! The caller has resolved the remote session through the authenticated node;
//! model text, board posts and REST bodies never enter this path. These records
//! can track an item, not authorize answering an interaction or executing a tool.
use serde_json::Value;

use crate::{app::App, db::Session, util::now_ms};

pub fn on_progress(app: &App, session: &Session, kind: &str, data: Option<&Value>) {
    let Some(user) = session.owner_user.as_deref() else {
        return;
    };
    let empty = Value::Null;
    let data = data.unwrap_or(&empty);
    let changed = match kind {
        "runner_ready" | "runner_exit" | "runner_error" => {
            super::invalidate_session_progress(&app.db.lock(), user, &session.id, now_ms())
        }
        "interaction_created" => {
            let Some(id) = data.get("id").and_then(Value::as_str) else {
                return;
            };
            // Node interaction payloads have their own runner epoch. The evidence
            // uses the Gateway epoch as a binding/reconnect fence, not that epoch.
            if data.get("status").and_then(Value::as_str) != Some("pending") {
                return;
            }
            let now = now_ms();
            let Some(expires_at) = data
                .get("expiresAt")
                .and_then(Value::as_i64)
                .filter(|at| *at > now)
            else {
                return;
            };
            super::ingest_progress(
                &app.db.lock(),
                user,
                &session.workspace_id,
                &session.id,
                session.runner_epoch,
                id,
                expires_at,
                now,
            )
        }
        "interaction_answered" => {
            let Some(id) = data.get("interactionId").and_then(Value::as_str) else {
                return;
            };
            super::resolve_progress(
                &app.db.lock(),
                user,
                &session.id,
                session.runner_epoch,
                id,
                now_ms(),
            )
        }
        _ => return,
    };
    // Durable inbox is authoritative; hints are only a refresh optimization.
    // No notification here and no background LLM call or automatic dispatch.
    match changed {
        Ok(items) if !items.is_empty() => app.sessions_changed(Some(user)),
        Ok(_) => {}
        Err(_) => crate::log::warn("pots progress observation unavailable; no work was dispatched"),
    }
}
