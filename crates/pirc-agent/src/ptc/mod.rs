//! The PTC surface the model sees in every request (`agent/ptc/{registry,
//! signatures,schema,contracts,index}.ts`): the capability registry, the
//! system prompt's capability index, the `ptc` and `ptc_docs` tools and
//! argument validation. The script runtime is M5's.

use std::rc::{Rc, Weak};

use serde_json::{Map, Value};

use crate::host::AgentHost;
use crate::tools::Tool;

/// `CORE_CAPABILITIES`, also the direct tools (`DIRECT_CAPABILITIES`).
pub const DIRECT_CAPABILITIES: [&str; 7] = ["read", "write", "edit", "ls", "grep", "find", "bash"];
/// `WRAPPER_NAMES`: never capabilities themselves.
pub const WRAPPER_NAMES: [&str; 3] = ["code", "ptc", "ptc_docs"];

/// `CapabilityRegistry`.
pub struct CapabilityRegistry {
    pub session_id: String,
}

impl CapabilityRegistry {
    pub fn new(session_id: String) -> Self {
        Self { session_id }
    }

    /// `summaries()`: what the context snapshot lists.
    pub fn summaries(&self, tools: &[Rc<dyn Tool>]) -> Value {
        let _ = tools;
        todo!("M4 tools: CapabilityRegistry::summaries")
    }
}

/// `capabilityIndexPrompt(agent)`.
pub fn capability_index_prompt(host: &dyn AgentHost) -> Option<String> {
    let _ = host;
    todo!("M4 tools: capabilityIndexPrompt")
}

/// `modelTools(agent)`: `ptc` and `ptc_docs`.
pub fn model_tools(host: Weak<dyn AgentHost>) -> Vec<Rc<dyn Tool>> {
    let _ = host;
    todo!("M4 tools: modelTools")
}

/// `validateSchema(value, schema)`: the problems, empty when valid.
pub fn validate_schema(value: &Value, schema: &Map<String, Value>) -> Vec<String> {
    let _ = (value, schema);
    todo!("M4 tools: validateSchema")
}
