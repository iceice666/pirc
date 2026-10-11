//! Write leases between sessions (`node/write-broker.ts`, with `pathsOverlap`
//! from `util.ts`). Owner: **runner**.
//!
//! Runners start freely; a session's agent must hold a lease on a path
//! before it writes under it, and no two sessions may hold overlapping paths
//! (either inside the other, or equal). Leases last until the session's run
//! settles, its runner exits, its start fails or it is stopped. Gaining a
//! first lease or losing them all is an activity change:
//! `node.activity.notify_one()`.

use std::path::Path;

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
}

impl WriteBroker {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// Lease `canonical_path` for `session_id`.
    pub fn acquire(&self, session_id: &str, canonical_path: &Path) -> WriteGrant {
        let _ = (&self.node, session_id, canonical_path);
        todo!("runner: WriteBroker.acquire")
    }

    /// Paths `session_id` holds.
    pub fn leases(&self, session_id: &str) -> Vec<String> {
        let _ = session_id;
        todo!("runner: WriteBroker.leases")
    }

    /// Sessions holding any lease (the link's `activity`), in the order
    /// they first acquired one.
    pub fn holders(&self) -> Vec<String> {
        todo!("runner: WriteBroker.holders")
    }

    pub fn release(&self, session_id: &str) {
        let _ = session_id;
        todo!("runner: WriteBroker.release")
    }
}

/// `pathsOverlap`: equal, or one inside the other (by path components).
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let _ = (a, b);
    todo!("runner: port pathsOverlap")
}
