//! Session branches read straight from the agent's `session.jsonl`
//! (`node/branch-cache.ts`). Owner: **runner**; used by core's snapshot
//! route and the panels.
//!
//! Keyed by directory, valid while the file's size and modification time
//! are unchanged (session files only grow); a missing file is an empty
//! branch, not cached; at most 16 directories, least recently read dropped
//! first. The branch comes from `pirc_agent::session_store::read_session_branch`.

use std::path::Path;
use std::sync::Arc;

use pirc_agent::session_store::SessionEntry;

#[derive(Default)]
pub struct BranchCache {
    _private: (),
}

impl BranchCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The session's active branch; `Err` when the file cannot be read or
    /// parsed (TS threw, and the route answered 500).
    pub fn read(&self, dir: &Path) -> Result<Arc<Vec<SessionEntry>>, String> {
        let _ = dir;
        todo!("runner: BranchCache.read")
    }

    /// A deleted session's directory.
    pub fn forget(&self, dir: &Path) {
        let _ = dir;
        todo!("runner: BranchCache.forget")
    }
}
