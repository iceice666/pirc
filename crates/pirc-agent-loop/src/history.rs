//! Provider-facing history repair: every issued tool call has a result and
//! no result is orphaned, so providers accept the history.
//!
//! Calls are identified by their occurrence, not their id alone: a provider
//! may reuse an id after a completed group, and an occurrence without a
//! result keeps its id reserved.

mod rewrite;

pub use rewrite::{Rewrite, RewriteError, replace_prefix, safe_boundaries};

use std::collections::HashMap;
use std::collections::hash_map::Entry;

use pirc_llm_types::{AssistantContent, Message, StopReason, UserBlock};

/// Where a call was issued: the index of its message among the events it
/// was paired over, and its index among that message's calls.
pub type Occurrence = (usize, usize);

/// The tool calls `message` issued, `(id, name)` in order: none unless it
/// is a tool-use reply.
pub fn issued(message: &Message) -> Vec<(&str, &str)> {
    match message {
        Message::Assistant(m) if m.stop_reason == StopReason::ToolUse => m
            .content
            .iter()
            .filter_map(|part| match part {
                AssistantContent::ToolCall { id, name, .. } => Some((id.as_str(), name.as_str())),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Issued calls paired with their results.
#[derive(Debug, Default)]
pub struct Pairing<'a> {
    /// `(id, name)` of each issued call.
    pub calls: HashMap<Occurrence, (&'a str, &'a str)>,
    /// Where each answered call's result is, and the result.
    pub results: HashMap<Occurrence, (usize, &'a Message)>,
}

impl<'a> Pairing<'a> {
    /// Pair the calls of a sequence of events, of which the messages are
    /// `Some`: other events keep their index, so occurrences index the
    /// sequence given. A result answers the earliest unanswered call of its
    /// id whose name it has; a call issued while its id is still unanswered
    /// is not a call of its own.
    pub fn collect(events: impl IntoIterator<Item = Option<&'a Message>>) -> Self {
        let mut pairing = Self::default();
        let mut active: HashMap<&str, (Occurrence, &str)> = HashMap::new();
        for (at, event) in events.into_iter().enumerate() {
            let Some(message) = event else {
                continue;
            };
            for (i, (id, name)) in issued(message).into_iter().enumerate() {
                if let Entry::Vacant(entry) = active.entry(id) {
                    let key = (at, i);
                    entry.insert((key, name));
                    pairing.calls.insert(key, (id, name));
                }
            }
            if let Message::ToolResult {
                tool_call_id,
                tool_name,
                ..
            } = message
                && let Some(&(key, name)) = active.get(tool_call_id.as_str())
                && name == tool_name
            {
                active.remove(tool_call_id.as_str());
                pairing.results.insert(key, (at, message));
            }
        }
        pairing
    }
}

/// The history as a provider accepts it: each reply's recorded results
/// follow it in order, a call without a result gets an interrupted one
/// (timestamped `now`), results of no call and calls of no tool-use reply
/// are dropped. `messages` is not changed.
pub fn project(messages: &[Message], now: u64) -> Vec<Message> {
    let pairing = Pairing::collect(messages.iter().map(Some));
    let mut out = Vec::with_capacity(messages.len());
    for (at, message) in messages.iter().enumerate() {
        if matches!(message, Message::ToolResult { .. }) {
            continue;
        }
        let mut projected = message.clone();
        let mut emitted = Vec::new();
        if let Message::Assistant(assistant) = &mut projected {
            let issued = assistant.stop_reason == StopReason::ToolUse;
            let mut i = 0;
            assistant.content.retain(|part| {
                if let AssistantContent::ToolCall { id, name, .. } = part {
                    let key = (at, i);
                    i += 1;
                    if !issued || !pairing.calls.contains_key(&key) {
                        return false;
                    }
                    emitted.push((key, id.clone(), name.clone()));
                }
                true
            });
        }
        out.push(projected);
        let mut completed: Vec<_> = emitted
            .iter()
            .filter_map(|(key, _, _)| pairing.results.get(key))
            .collect();
        completed.sort_by_key(|(at, _)| *at);
        out.extend(completed.into_iter().map(|(_, m)| (*m).clone()));
        for (key, id, name) in emitted {
            if !pairing.results.contains_key(&key) {
                out.push(interrupted_result(id, name, now));
            }
        }
    }
    out
}

/// The result standing in for a call that never got one.
pub fn interrupted_result(id: String, name: String, timestamp: u64) -> Message {
    Message::ToolResult {
        tool_call_id: id,
        tool_name: name,
        content: vec![UserBlock::Text {
            text: "Tool call was interrupted before producing a result.".into(),
            text_signature: None,
        }],
        details: None,
        is_error: true,
        timestamp,
    }
}
