//! Write leases between sessions (`node/write-broker.ts`, with `pathsOverlap`
//! from `util.ts`). Owner: **runner**.
//!
//! Runners start freely; a session's agent must hold a lease on a path
//! before it writes under it, and no two sessions may hold overlapping paths
//! (either inside the other, or equal). Leases last until the session's run
//! settles, its runner exits, its start fails or it is stopped. Approved host
//! commands separately retain their frozen ranges until observation settles. Gaining a
//! first lease or losing them all is an activity change:
//! `node.activity.notify_one()`.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use indexmap::{IndexMap, IndexSet};

use crate::{
    error::{ApiError, ApiResult},
    host_commands::{Origin, resources},
    services::WeakNode,
    store::Store,
};

/// `WriteGrant`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteGrant {
    Granted,
    Blocked {
        code: String,
        message: String,
    },
    /// Held by session `holder` through `path`.
    Refused {
        holder: String,
        path: String,
    },
}

pub struct WriteBroker {
    node: WeakNode,
    /// Sessions in the order they first acquired a lease (a JS `Map`).
    held: Mutex<IndexMap<String, IndexSet<String>>>,
}

impl WriteBroker {
    pub fn new(node: WeakNode) -> Self {
        Self {
            node,
            held: Mutex::new(IndexMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, IndexMap<String, IndexSet<String>>> {
        self.held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn changed(&self) {
        if let Some(node) = self.node.upgrade() {
            node.activity.notify_one();
        }
    }

    /// Convenience path for callers without a captured runner epoch.
    pub fn acquire(&self, session_id: &str, canonical_path: &Path) -> WriteGrant {
        let epoch = match self.node.upgrade() {
            Some(node) => match node.db.lock().get_session(session_id) {
                Ok(row) => row.runner_epoch,
                Err(error) => return Self::blocked(error),
            },
            None => return self.acquire_held(session_id, canonical_path),
        };
        self.acquire_for(session_id, epoch, canonical_path)
    }

    fn blocked(error: ApiError) -> WriteGrant {
        WriteGrant::Blocked {
            code: error.code.into_owned(),
            message: error.message,
        }
    }

    /// DB admission and insertion share a lock with host reservation and fences.
    /// Ordinary Agent settlement may release `held`, but cannot release a host's
    /// frozen resource journal or let a later epoch inherit its approval.
    pub(crate) fn acquire_for(&self, session_id: &str, epoch: i64, path: &Path) -> WriteGrant {
        let Some(node) = self.node.upgrade() else {
            return Self::blocked(ApiError::internal());
        };
        if !path.is_absolute() {
            return Self::blocked(ApiError::invalid_input());
        }
        if let Err(error) = node.session_mode(session_id) {
            return Self::blocked(error);
        }
        let db = node.db.lock();
        let available = (|| {
            db.require_session_available(session_id)?;
            crate::execution_fences::require_open(&db, session_id)?;
            if db.get_session(session_id)?.runner_epoch != epoch {
                return Err(ApiError::conflict(
                    "The write request belongs to an earlier runner",
                ));
            }
            resources::require_available(
                &db,
                path,
                Some(resources::Writer {
                    session: session_id,
                    epoch,
                    incarnation: &node.incarnation,
                    active_runs: node.host_commands.active_runs(),
                }),
            )
        })();
        if let Err(error) = available {
            return Self::blocked(error);
        }
        self.acquire_held(session_id, path)
    }

    /// Caller holds the DB through the atomic host journal reservation. Taking
    /// the same lock in acquire_for prevents a peer lease entering this window.
    pub(crate) fn host_paths(
        &self,
        db: &rusqlite::Connection,
        origin: &Origin,
        incarnation: &str,
    ) -> ApiResult<Vec<String>> {
        let node = self.node.upgrade().ok_or_else(ApiError::internal)?;
        if !origin.root.is_absolute() {
            return Err(ApiError::internal());
        }
        let active_runs = node.host_commands.active_runs();
        let held = self.lock();
        let mut paths = IndexSet::from([origin.root.to_string_lossy().into_owned()]);
        if let Some(existing) = held.get(&origin.session) {
            paths.extend(existing.iter().cloned());
        }
        for path in &paths {
            resources::require_available(
                db,
                Path::new(path),
                Some(resources::Writer {
                    session: &origin.session,
                    epoch: origin.epoch,
                    incarnation,
                    active_runs: active_runs.clone(),
                }),
            )?;
            if held.iter().any(|(session, ranges)| {
                session != &origin.session
                    && ranges
                        .iter()
                        .any(|range| paths_overlap(Path::new(range), Path::new(path)))
            }) {
                return Err(ApiError::new(
                    409,
                    "host_write_conflict",
                    "Another session holds write access required by this host command; wait for it to finish",
                ));
            }
        }
        Ok(paths.into_iter().collect())
    }

    fn acquire_held(&self, session_id: &str, canonical_path: &Path) -> WriteGrant {
        let path = canonical_path.to_string_lossy().into_owned();
        let first = {
            let mut held = self.lock();
            for (owner, paths) in held.iter() {
                if owner == session_id {
                    continue;
                }
                if let Some(path) = paths
                    .iter()
                    .find(|held| paths_overlap(Path::new(held), canonical_path))
                {
                    return WriteGrant::Refused {
                        holder: owner.clone(),
                        path: path.clone(),
                    };
                }
            }
            let first = !held.contains_key(session_id);
            held.entry(session_id.to_owned()).or_default().insert(path);
            first
        };
        if first {
            self.changed();
        }
        WriteGrant::Granted
    }

    /// Paths `session_id` holds.
    pub fn leases(&self, session_id: &str) -> Vec<String> {
        self.lock()
            .get(session_id)
            .map(|paths| paths.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Includes durable host owners, even after Agent settlement or Node restart.
    /// A failed inventory must never be reported as an empty/idle activity frame.
    pub fn holders(&self) -> ApiResult<Vec<String>> {
        if let Some(node) = self.node.upgrade() {
            let db = node.db.lock();
            let mut owners: IndexSet<String> = self.lock().keys().cloned().collect();
            owners.extend(resources::holders(&db)?);
            Ok(owners.into_iter().collect())
        } else {
            Ok(self.lock().keys().cloned().collect())
        }
    }

    pub fn release(&self, session_id: &str) {
        let removed = self.lock().shift_remove(session_id).is_some();
        if removed {
            self.changed();
        }
    }
}

/// `path.resolve` without the working directory: the node's paths are
/// absolute.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// `pathsOverlap`: equal, or one inside the other (by path components).
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let (a, b) = (lexical(a), lexical(b));
    a.starts_with(&b) || b.starts_with(&a)
}

#[cfg(test)]
mod tests {
    use std::sync::Weak;

    use super::*;

    #[test]
    fn overlaps() {
        let overlap = |a: &str, b: &str| paths_overlap(Path::new(a), Path::new(b));
        assert!(overlap("/w", "/w"));
        assert!(overlap("/w", "/w/a/b"));
        assert!(overlap("/w/a/b", "/w"));
        assert!(overlap("/w/a/../b", "/w/b/c"));
        assert!(overlap("/", "/anything"));
        assert!(!overlap("/w/a", "/w/ab"));
        assert!(!overlap("/w/a", "/w/b"));
        assert!(overlap("/w/..a", "/w/..a/x"));
    }

    #[test]
    fn leases_between_sessions() {
        let broker = WriteBroker::new(Weak::new());
        assert_eq!(broker.acquire("s1", Path::new("/w/a")), WriteGrant::Granted);
        assert_eq!(
            broker.acquire("s1", Path::new("/w/a/b")),
            WriteGrant::Granted
        );
        assert_eq!(broker.acquire("s2", Path::new("/w/c")), WriteGrant::Granted);
        assert_eq!(
            broker.acquire("s2", Path::new("/w")),
            WriteGrant::Refused {
                holder: "s1".into(),
                path: "/w/a".into()
            }
        );
        assert_eq!(broker.leases("s1"), ["/w/a", "/w/a/b"]);
        assert_eq!(broker.holders().unwrap(), ["s1", "s2"]);
        broker.release("s1");
        broker.release("s1");
        assert_eq!(broker.holders().unwrap(), ["s2"]);
        assert_eq!(
            broker.acquire("s1", Path::new("/w")),
            WriteGrant::Refused {
                holder: "s2".into(),
                path: "/w/c".into()
            }
        );
        assert!(broker.leases("s1").is_empty());
    }
}
