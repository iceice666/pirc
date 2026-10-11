//! Message types (`agent/messages.ts`): the wire types of `pirc-protocol`,
//! and the agent's token estimate.

pub use pirc_protocol::{
    AssistantContent, AssistantDelta, AssistantMessage, Message, StopReason, Usage, UserBlock,
    UserContent,
};

/// `estimateTokens(message)`: characters / 4, images as 4800 characters.
pub fn estimate_tokens(message: &Message) -> u64 {
    let _ = message;
    todo!("M4 store: estimateTokens")
}

/// `emptyUsage()`.
pub fn empty_usage() -> Usage {
    Usage {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 0,
    }
}
