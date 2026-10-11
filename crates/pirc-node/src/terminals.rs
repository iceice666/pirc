//! Interactive shells for the side panel (`node/terminals.ts`). Owner:
//! **panels**. Not a sandbox: a terminal has the node account's rights, and
//! agents cannot reach it.
//!
//! A PTY (`pty-process`, as the agent's background tasks) running
//! `/bin/sh -c 'exec "$0" -l' <shell>` as a session leader with the
//! terminal as its controlling tty; the environment `without_secrets` plus
//! `SSH_AUTH_SOCK`, `TERM=xterm-256color`, `COLORTERM=truecolor`,
//! `PIRC_TERMINAL=1`, `HOME`. Limits: 4 live terminals per session, 24 in
//! all; 20..500 columns, 5..200 rows; 256 KiB of scrollback in whole
//! chunks; input over 65,536 UTF-16 units dropped; exited terminals kept
//! 30 minutes. Closing sends SIGHUP to the process group, SIGKILL 2 s later.

use std::path::Path;

use serde::Serialize;

use crate::error::ApiResult;
use crate::services::WeakNode;

/// `TerminalInfo`, as the REST routes and the `ready` frame show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    /// 8 hex digits.
    pub id: String,
    pub session_id: String,
    /// The shell's file name.
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at: i64,
    /// `None` while it runs, or when a signal ended it.
    pub exit_code: Option<i32>,
    pub exited: bool,
}

/// `TerminalManager`.
pub struct Terminals {
    node: WeakNode,
}

impl Terminals {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// Every terminal of the session, exited ones too.
    pub fn list(&self, session_id: &str) -> Vec<TerminalInfo> {
        let _ = (&self.node, session_id);
        todo!("panels: TerminalManager.list")
    }

    /// Start a shell in `cwd` (409 `conflict` past the limits, 503 while
    /// the node shuts down, 500 `runner_unavailable` "Could not start
    /// shell: ..." when it cannot start).
    pub fn create(
        &self,
        session_id: &str,
        cwd: &Path,
        cols: Option<i64>,
        rows: Option<i64>,
    ) -> ApiResult<TerminalInfo> {
        let _ = (session_id, cwd, cols, rows);
        todo!("panels: TerminalManager.create")
    }

    /// 404 `not_found` "Terminal not found".
    pub fn close(&self, session_id: &str, terminal_id: &str) -> ApiResult<()> {
        let _ = (session_id, terminal_id);
        todo!("panels: TerminalManager.close")
    }

    /// Close a session's terminals and wait for their processes to exit
    /// (chat deletion, before its files go).
    pub async fn dispose_session(&self, session_id: &str) {
        let _ = session_id;
        todo!("panels: TerminalManager.disposeSession")
    }

    /// Node shutdown: refuse new terminals, kill every one, wait for none.
    pub fn shutdown(&self) {
        todo!("panels: TerminalManager.shutdown")
    }
}
