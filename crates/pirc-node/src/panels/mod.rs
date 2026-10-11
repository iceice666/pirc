//! The side panels' routes (`node/panel-routes.ts`): git and files,
//! panel state and context, background tasks, terminals and the browser
//! recording. Owner: **panels**.
//!
//! Every route here goes through `local` of TS: claim the session (owner
//! check, not being deleted), then `chat::session_root` (which creates a
//! chat session's directory, even for a GET). Terminal routes check
//! `config.terminals_enabled` first (403 "Terminals are disabled on this
//! node"), before the claim. Golden cases: `panel.integration.test.ts`,
//! `context-panel.integration.test.ts`.

pub mod inspect;

use crate::router::Route;

/// The panel routes, merged with core's by the router:
///
/// - `GET /api/sessions/:id/git/status`, `.../git/diff`, `.../git/log`,
///   `.../git/commits/:sha`
/// - `GET /api/sessions/:id/files`, `.../files/content`
/// - `GET /api/sessions/:id/panel/state`, `.../panel/context`,
///   `.../panel/background/:taskId`, `POST .../panel/background/:taskId/stop`
/// - `GET /api/sessions/:id/terminals`, `POST .../terminals`,
///   `POST .../terminals/:terminalId/close`
/// - `GET /api/sessions/:id/browser/recording` (reads files only; no browser)
pub fn routes() -> Vec<Route> {
    Vec::new()
}
