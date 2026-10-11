//! Capabilities the agent runs (`agent/tools/types.ts`, `tools/index.ts`):
//! the core file and shell tools here, feature tools in M5.

pub mod bash;
pub mod files;

use std::rc::Rc;

use pirc_policy::PathGuard;
use pirc_protocol::UserBlock;
use serde_json::{Map, Value};

use crate::LocalBoxFuture;
use crate::config::AgentConfig;
use crate::signal::AbortSignal;
use crate::ui::Ui;

/// `ToolResult`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolResult {
    pub content: Vec<UserBlock>,
    pub details: Option<Value>,
    pub is_error: bool,
    /// Typed fields for `ptc` scripts (`resultSchema`); never shown to the
    /// model or stored by itself.
    pub data: Option<Map<String, Value>>,
}

impl ToolResult {
    /// `text(value, details, isError)`.
    pub fn text(value: impl Into<String>) -> Self {
        Self {
            content: vec![UserBlock::Text {
                text: value.into(),
                text_signature: None,
            }],
            ..Self::default()
        }
    }

    /// An error result with this text.
    pub fn error(value: impl Into<String>) -> Self {
        Self {
            is_error: true,
            ..Self::text(value)
        }
    }

    /// The result as observers and the session see it (`observed`):
    /// without `data`.
    pub fn observed(&self) -> Self {
        Self {
            data: None,
            ..self.clone()
        }
    }

    /// The wire form (`{content, details?, isError?}`), as events carry it.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "content".to_owned(),
            serde_json::to_value(&self.content).unwrap_or_default(),
        );
        if let Some(details) = &self.details {
            out.insert("details".to_owned(), details.clone());
        }
        if self.is_error {
            out.insert("isError".to_owned(), Value::Bool(true));
        }
        if let Some(data) = &self.data {
            out.insert("data".to_owned(), Value::Object(data.clone()));
        }
        Value::Object(out)
    }
}

/// Take the node's write lease for the root containing an absolute path.
pub type AcquireWrite = Rc<dyn Fn(String) -> LocalBoxFuture<'static, Result<(), String>>>;

/// `ToolContext`.
#[derive(Clone)]
pub struct ToolContext {
    pub cwd: String,
    pub config: Rc<AgentConfig>,
    pub guard: Rc<PathGuard>,
    pub signal: AbortSignal,
    pub tool_call_id: String,
    pub ui: Rc<dyn Ui>,
    /// Whether a human can answer dialogs.
    pub has_ui: bool,
    pub env: Vec<(String, String)>,
    /// Call right before modifying `file` (an absolute path from
    /// `guard.resolve(…, write)`); `Err` when another session writes there.
    pub acquire_write: AcquireWrite,
    /// Partial output for observers (`tool_execution_update`).
    pub update: Rc<dyn Fn(ToolResult)>,
}

/// `Tool`.
pub trait Tool {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON schema of the arguments.
    fn parameters(&self) -> &Map<String, Value>;
    /// Callable from `ptc` scripts (`tools.<name>(args)`).
    fn ptc(&self) -> bool {
        false
    }
    /// JSON schema of the typed `data` a result carries.
    fn result_schema(&self) -> Option<&Value> {
        None
    }
    /// Run the tool; `Err` is a thrown error (its text reaches the model).
    fn execute<'a>(
        &'a self,
        args: Map<String, Value>,
        ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>>;
}

/// `builtinTools()`: read, write, edit, bash, ls, find, grep.
pub fn builtin_tools() -> Vec<Rc<dyn Tool>> {
    todo!("M4 tools: builtinTools")
}
