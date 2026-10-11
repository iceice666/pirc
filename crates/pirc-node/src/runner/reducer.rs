//! The live state a snapshot shows while an agent runs (`node/reducer.ts`).
//! Owner: **runner** ([`ReducedState::reduce`]); the types are the
//! layout's, read by core's snapshot route.
//!
//! History is not here: snapshots read it from the session file (the
//! branch cache). TS also pushed every `message_end` onto an unused
//! `history`; the port leaves it out.

use std::collections::BTreeMap;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

/// `ReducedSessionState` without `history`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReducedState {
    /// The assistant message being streamed, if any.
    pub partial_message: Option<PartialMessage>,
    pub queue: Queue,
    /// `notify` requests with `receivedAt` (unbounded, as TS).
    pub notifications: Vec<Map<String, Value>>,
    /// Extension panels (`setWidget`), at most 64 lines each.
    pub widgets: IndexMap<String, Vec<String>>,
    /// Status-line entries (`setStatus`).
    pub statuses: IndexMap<String, String>,
    /// `ptc` operations started and not ended (at most 32).
    pub operations: Vec<RunningOperation>,
}

/// `{base, content}`: `content` by `contentIndex` (a JSON object with
/// numeric keys, in ascending order as JS lists them).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PartialMessage {
    /// `message_start`'s message (`null` when an update came first).
    pub base: Value,
    pub content: BTreeMap<u32, PartialContent>,
}

/// One block of a partial message (`PartialContent`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialContent {
    /// `text`, `thinking` or `toolCall`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub steering: Vec<Value>,
    pub follow_up: Vec<Value>,
}

/// `RunningOperation`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningOperation {
    pub tool_call_id: String,
    pub parent_tool_call_id: String,
    pub tool_name: String,
    /// Bounded for display (`boundedArgs`).
    pub args: Value,
}

impl ReducedState {
    /// `reducePiEvent(state, event)`.
    pub fn reduce(&mut self, event: &Map<String, Value>) {
        let _ = event;
        todo!("runner: port reducePiEvent")
    }
}
