//! Session branches read straight from the agent's `session.jsonl`
//! (`node/branch-cache.ts`). Owner: **runner**; used by core's snapshot
//! route and the panels.
//!
//! Keyed by directory, valid while the file's size and modification time
//! are unchanged (session files only grow, and snapshots and the panel poll
//! after every turn); a missing file is an empty branch, not cached; at
//! most 16 directories, least recently read dropped first. The file is the
//! authority for history: it survives the agent process, and reading it
//! never pushes the whole transcript through the RPC pipe. The branch comes
//! from `pirc_agent::session_store::read_session_branch`.
//!
//! The modification time is compared in nanoseconds where TS compared
//! `mtimeMs` (a float of milliseconds), so a rewrite of the same size
//! within one millisecond is noticed here.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use indexmap::IndexMap;
use pirc_agent::session_store::{SESSION_FILE, SessionEntry, read_session_branch};

/// Sessions viewed at a time are few.
const CAPACITY: usize = 16;

struct Cached {
    size: u64,
    modified: Option<SystemTime>,
    branch: Arc<Vec<SessionEntry>>,
}

#[derive(Default)]
pub struct BranchCache {
    entries: Mutex<IndexMap<PathBuf, Cached>>,
}

impl BranchCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, IndexMap<PathBuf, Cached>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The session's active branch; `Err` when the file cannot be read or
    /// parsed (TS threw, and the route answered 500).
    pub fn read(&self, dir: &Path) -> Result<Arc<Vec<SessionEntry>>, String> {
        let Ok(stat) = std::fs::metadata(dir.join(SESSION_FILE)) else {
            return Ok(Arc::new(Vec::new()));
        };
        let (size, modified) = (stat.len(), stat.modified().ok());
        if let Some(cached) = self.lock().get(dir)
            && cached.size == size
            && cached.modified == modified
        {
            return Ok(cached.branch.clone());
        }
        // Read without the lock: a large file must not stall other sessions.
        let branch = Arc::new(read_session_branch(dir)?);
        let mut entries = self.lock();
        entries.shift_remove(dir);
        entries.insert(
            dir.to_owned(),
            Cached {
                size,
                modified,
                branch: branch.clone(),
            },
        );
        if entries.len() > CAPACITY {
            entries.shift_remove_index(0);
        }
        Ok(branch)
    }

    /// A deleted session's directory.
    pub fn forget(&self, dir: &Path) {
        self.lock().shift_remove(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_by_size_and_time() {
        let root = tempfile::tempdir().unwrap();
        let cache = BranchCache::new();
        let dir = root.path().join("s");
        assert!(cache.read(&dir).unwrap().is_empty());
        std::fs::create_dir(&dir).unwrap();
        let header = r#"{"type":"session","version":1,"sessionId":"pi","cwd":"/w","id":"e1","parentId":null,"timestamp":1}"#;
        std::fs::write(dir.join(SESSION_FILE), format!("{header}\n")).unwrap();
        let first = cache.read(&dir).unwrap();
        assert!(Arc::ptr_eq(&first, &cache.read(&dir).unwrap()));
        cache.forget(&dir);
        assert!(!Arc::ptr_eq(&first, &cache.read(&dir).unwrap()));
        for index in 0..20 {
            let other = root.path().join(format!("o{index}"));
            std::fs::create_dir(&other).unwrap();
            std::fs::write(other.join(SESSION_FILE), format!("{header}\n")).unwrap();
            cache.read(&other).unwrap();
        }
        assert_eq!(cache.lock().len(), CAPACITY);
        assert!(!cache.lock().contains_key(&dir));
    }
}
