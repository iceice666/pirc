//! JSONL framing of the agent's stdout (`node/rpc-framing.ts`). Owner:
//! **runner**.
//!
//! LF only: a line ending in `\r` is an error ("RPC protocol requires
//! LF-only framing"); empty lines are skipped; each line, complete or still
//! buffered, is limited to `max_line_bytes` UTF-8 bytes; the total is not.
//! A multi-byte character split across reads is reassembled. Golden cases:
//! `rpc-framing.test.ts`. Outbound lines are `JSON + "\n"`.

use serde_json::Value;

/// `JsonlParser`.
pub struct JsonlParser {
    max_line_bytes: usize,
    buffer: Vec<u8>,
}

impl JsonlParser {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            max_line_bytes,
            buffer: Vec::new(),
        }
    }

    /// The values of the complete lines in `chunk`, or the framing error
    /// (the runner then kills the agent).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        let _ = (chunk, self.max_line_bytes, &self.buffer);
        todo!("runner: port JsonlParser.push")
    }

    /// The stream ended: an unterminated line is an error.
    pub fn end(&mut self) -> Result<(), String> {
        todo!("runner: port JsonlParser.end")
    }
}
