//! Workspace memory mirrored to the gateway for the assistant's search
//! (`node/memory-mirror.ts`). Owner: **panels**.
//!
//! Ledgers `<workspace memory dir>/<16 hex>.jsonl` (not recursive) are sent
//! as complete lines from the offset the gateway acknowledged, at most
//! [`pirc_protocol::MIRROR_CHUNK_BYTES`] per frame (a longer single line up
//! to 8 MiB), through `LinkSender::send_agent_frame`; a shrunken ledger
//! starts over with `reset`. Items lose their paths: a session directory
//! becomes the node session id (a cached lookup by `private_session_path`),
//! git loses its worktree. One frame per ledger in flight (60 s), a scan
//! every `config.memory_mirror_ms`, an immediate next chunk on each ack.
//! Golden cases: `memory-mirror.test.ts`.

use indexmap::IndexMap;

use crate::services::WeakNode;

pub struct MemoryMirror {
    node: WeakNode,
}

impl MemoryMirror {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// The link registered: the gateway's acknowledged offsets by ledger
    /// key; start scanning.
    pub fn connect(&self, mirrors: IndexMap<String, u64>) {
        let _ = (&self.node, mirrors);
        todo!("panels: MemoryMirror.connect")
    }

    /// `memory_mirror_ack`.
    pub fn receive(&self, ledger_key: &str, watermark: u64) {
        let _ = (ledger_key, watermark);
        todo!("panels: MemoryMirror.receive")
    }

    /// The link dropped or the node closes: stop scanning.
    pub fn disconnect(&self) {
        todo!("panels: MemoryMirror.disconnect")
    }
}
