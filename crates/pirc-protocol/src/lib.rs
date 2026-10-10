//! Wire types shared by the gateway, the node and the agent, ported from
//! `apps/gateway/src/protocol.ts`, `protocol-schema.ts`, `inference-wire.ts`
//! and `models.ts`.
//!
//! These are shapes only. Size and length limits (`.max()` in the zod
//! schemas) are the receiving endpoint's to enforce. Payloads the TS schemas
//! keep opaque (`z.unknown()`) stay [`serde_json::Value`] here, and an opaque
//! field that is present but `null` stays distinct from an absent one.
//! Numbers are typed narrower than zod's `number` (HTTP statuses as `u16`,
//! token counts and timestamps as `u64`): a receiver treats a frame that does
//! not parse as invalid, as TS does one that fails its schema.

mod inference;
mod link;
mod models;

pub use inference::{
    AssistantContent, AssistantDelta, AssistantMessage, InferenceErrorCode, InferenceRequest,
    Message, StopReason, ToolChoice, ToolSpec, Usage, UserBlock, UserContent,
};
pub use link::{
    GatewayMessage, HttpMethod, NodeHttpRequest, NodeHttpResponse, NodeMessage, NodeRole,
    RegisteredWorkspace, Registration, SessionActivity, SessionRun, TerminalKind, WorkspaceKind,
    WorkspaceRole,
};
pub use models::{InferenceConfig, Model, ModelApi, ModelRef, Models, Provider, ThinkingLevel};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Both sides must speak the same version; the gateway closes a node that
/// registers with another one with [`PROTOCOL_MISMATCH_CLOSE`].
pub const NODE_PROTOCOL_VERSION: u32 = 9;
/// Close code for a node that speaks another protocol version.
pub const PROTOCOL_MISMATCH_CLOSE: u16 = 4426;
/// Largest WebSocket frame on the node link.
pub const NODE_FRAME_MAX_BYTES: usize = 16_777_216;

/// Parse `value` as `T` and serialize it back; `Err` shows both when they
/// differ. Used to check these types against frames real executables send.
/// The comparison ignores key order: a struct's field order means nothing,
/// and the order of the free-form maps (providers, tool schemas, arguments)
/// is kept by `IndexMap` and `serde_json`'s `preserve_order`, which unit tests
/// check.
pub fn round_trip<T: Serialize + DeserializeOwned>(value: &Value) -> Result<T, String> {
    let parsed: T = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    let back = serde_json::to_value(&parsed).map_err(|error| error.to_string())?;
    if &back == value {
        Ok(parsed)
    } else {
        Err(format!("re-serialized as {back}\nexpected {value}"))
    }
}

/// `#[serde(deserialize_with)]` for opaque optional fields: a present `null`
/// is `Some(Value::Null)`, an absent field (with `default`) is `None`.
pub(crate) mod opaque {
    use serde::{Deserialize, Deserializer};
    use serde_json::Value;

    pub fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
        Value::deserialize(deserializer).map(Some)
    }
}
