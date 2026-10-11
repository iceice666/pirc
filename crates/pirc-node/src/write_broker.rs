//! Write leases between sessions (`node/write-broker.ts`, with `pathsOverlap`
//! from `util.ts`). Owner: **runner**.
//!
//! Runners start freely; a session's agent must hold a lease on a path
//! before it writes under it, and no two sessions may hold overlapping paths
//! (either inside the other, or equal). Leases last until the session's run
//! settles, its runner exits, its start fails or it is stopped. Gaining a
//! first lease or losing them all is an activity change:
//! `node.activity.notify_one()`.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use indexmap::{IndexMap, IndexSet};

use crate::services::WeakNode;

/// `WriteGrant`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteGrant {
    Granted,
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

    /// Lease `canonical_path` for `session_id`.
    pub fn acquire(&self, session_id: &str, canonical_path: &Path) -> WriteGrant {
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

    /// Sessions holding any lease (the link's `activity`), in the order
    /// they first acquired one.
    pub fn holders(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
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
        assert_eq!(broker.holders(), ["s1", "s2"]);
        broker.release("s1");
        broker.release("s1");
        assert_eq!(broker.holders(), ["s2"]);
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
