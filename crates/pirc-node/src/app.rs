//! The node's own routes (`node/app.ts`, all but the panels'). Owner:
//! **core**.
//!
//! - Workspaces: `POST /api/workspaces` (chat projects on the chat node,
//!   directories under `$HOME` elsewhere, never around the node's state or
//!   a credential store), `GET`/`PATCH /api/workspaces/:id/instructions`,
//!   `GET /api/workspaces/:id/project-config`,
//!   `POST /api/workspaces/:id/project-trust`; on the chat node
//!   `GET /api/assistant/prompts`, `PUT /api/assistant/prompts/:name`.
//! - Sessions: `POST /api/sessions`, `DELETE /api/sessions/:id` (chat
//!   only, fenced, idempotent), `PATCH /api/sessions/:id` (rename),
//!   `GET /api/sessions/:id/snapshot`, `POST /api/sessions/:id/deliver`,
//!   `POST /api/sessions/:id/commands`, control (`GET .../control`,
//!   `POST .../control/acquire|heartbeat|release`),
//!   `POST .../interactions/:interactionId/answer`, `POST .../uploads`.
//! - `POST /api/workspace-memory/recall`.
//!
//! Golden cases: `app.integration.test.ts`, `chat-workspaces`,
//! `project-instructions`, `project-trust`, `assistant-prompts` and the
//! node halves of `relay.integration.test.ts`.

use pirc_config::NodeConfig;

use crate::router::Route;

/// Core's routes for this node's role (the assistant prompt routes exist on
/// the chat node only).
pub fn routes(config: &NodeConfig) -> Vec<Route> {
    let _ = config;
    Vec::new()
}

/// `applySessionName` (`session-name.ts`): persist a name the agent
/// reported or the user chose and publish `session_renamed`; a generated
/// (`auto`) title never replaces a user's name. Used by the runner
/// (`session_name_changed`) and the rename route.
pub fn apply_session_name(
    node: &crate::services::Node,
    session_id: &str,
    epoch: i64,
    data: &serde_json::Value,
) -> crate::error::ApiResult<()> {
    let _ = (node, session_id, epoch, data);
    todo!("core: applySessionName")
}
