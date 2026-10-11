//! Chat workspace layout (`node/chat.ts`). Owner: **core**; `session_root`
//! and the instructions readers are used by the runner and the panels.
//!
//! - A chat workspace's directory is `<state>/chat/<workspace id>` (0700,
//!   realpath); the chat node's top-level chats are workspace
//!   [`pirc_config::CHAT_WORKSPACE_ID`] "Chats".
//! - A chat session works in `<workspace>/sessions/<basename(session id)>`
//!   (created 0700 on every call); a directory workspace's sessions work in
//!   the workspace.
//! - A chat project's instructions are `<workspace>/instructions.md`, at
//!   most [`INSTRUCTIONS_MAX_CHARS`] UTF-16 units, written 0600 through a
//!   temporary file and rename; empty removes the file.

use std::path::PathBuf;

use pirc_config::NodeConfig;

use crate::error::ApiResult;
use crate::store::Workspace;

pub const INSTRUCTIONS_FILE: &str = "instructions.md";
pub const INSTRUCTIONS_MAX_CHARS: usize = 8000;

/// `chatWorkspaceDir`: created if needed, canonical.
pub fn chat_workspace_dir(config: &NodeConfig, workspace_id: &str) -> ApiResult<PathBuf> {
    let _ = (config, workspace_id);
    todo!("core: chatWorkspaceDir")
}

/// `sessionRoot`: where the session's agent, terminals and panels work.
pub fn session_root(workspace: &Workspace, session_id: &str) -> ApiResult<PathBuf> {
    let _ = (workspace, session_id);
    todo!("core: sessionRoot")
}

/// `projectInstructionsPath`: a chat workspace's instructions file.
pub fn project_instructions_path(workspace: &Workspace) -> Option<PathBuf> {
    let _ = workspace;
    todo!("core: projectInstructionsPath")
}

/// `readProjectInstructions`: trimmed and cut to the limit; `""` for none.
pub fn read_project_instructions(workspace: &Workspace) -> String {
    let _ = workspace;
    todo!("core: readProjectInstructions")
}

/// `writeProjectInstructions`: the stored text (413 `payload_too_large`
/// "Instructions are limited to 8000 characters").
pub fn write_project_instructions(workspace: &Workspace, text: &str) -> ApiResult<String> {
    let _ = (workspace, text);
    todo!("core: writeProjectInstructions")
}
