//! The terminal and browser streams multiplexed on the link
//! (`node/runtime.ts` `openTerminal`, `terminalStreams` and
//! `browserStreams` of `node/panel-routes.ts`). Owner: **panels**.
//!
//! `terminal_open` attaches a stream: the browser kind goes to
//! [`crate::browser::BrowserService`] (unavailable until M8: 4403 "The
//! browser is not available on this node"), the terminal kind to
//! [`crate::terminals::Terminals`]. Frames go out as `terminal_frame`
//! through `LinkSender::send` (browser `frame` frames are dropped while the
//! link's backlog exceeds `link::BROWSER_FRAME_BACKLOG_BYTES`). A failed
//! open is `terminal_closed` with 4401/4403/4404 by the error's status
//! (else 4400) and the message's first 120 UTF-16 units; a shell's exit is
//! the `exit` frame then `terminal_closed` 1000 "terminal exited". Input is
//! checked against the control lease per message. An already open
//! `streamId` is ignored.

use pirc_protocol::TerminalKind;
use serde_json::Value;

use crate::services::WeakNode;

pub struct Streams {
    node: WeakNode,
}

impl Streams {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// `terminal_open` (kind absent: terminal).
    pub fn open(
        &self,
        stream_id: &str,
        kind: TerminalKind,
        user: &str,
        session_id: &str,
        terminal_id: &str,
    ) {
        let _ = (&self.node, stream_id, kind, user, session_id, terminal_id);
        todo!("panels: open a stream")
    }

    /// `terminal_input`: the browser's message, raw.
    pub fn input(&self, stream_id: &str, message: Option<Value>) {
        let _ = (stream_id, message);
        todo!("panels: stream input")
    }

    /// `terminal_close`: detach the stream (the terminal lives on).
    pub fn close(&self, stream_id: &str) {
        let _ = stream_id;
        todo!("panels: close a stream")
    }

    /// The link dropped or the node closes: detach every stream.
    pub fn close_all(&self) {
        todo!("panels: close every stream")
    }
}
