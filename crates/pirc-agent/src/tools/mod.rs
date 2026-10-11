//! Capabilities the agent runs (`agent/tools/types.ts`, `tools/index.ts`):
//! the core file and shell tools here, feature tools in M5.

pub mod bash;
pub mod files;
mod glob;
pub mod js;
pub mod prompts;
pub mod result_schema;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

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
    /// The tool set `isError` itself, so a `false` is shown too (TS
    /// `{ isError: cond }` rather than an absent flag).
    pub is_error_set: bool,
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
        if self.is_error || self.is_error_set {
            out.insert("isError".to_owned(), Value::Bool(self.is_error));
        }
        if let Some(data) = &self.data {
            out.insert("data".to_owned(), Value::Object(data.clone()));
        }
        Value::Object(out)
    }
}

/// Take the node's write lease for the root containing an absolute path.
pub type AcquireWrite = Rc<dyn Fn(String) -> LocalBoxFuture<'static, Result<(), String>>>;

/// A wait for a human, counted while alive (`humanWait`): a running `ptc`
/// script's active-time budget pauses meanwhile.
pub struct HumanWait(Option<Rc<dyn Fn(isize)>>);

impl HumanWait {
    /// Count one more wait through `change` (+1 now, -1 when dropped).
    pub fn new(change: Rc<dyn Fn(isize)>) -> Self {
        change(1);
        Self(Some(change))
    }

    /// Counts nothing.
    pub fn none() -> Self {
        Self(None)
    }
}

impl Drop for HumanWait {
    fn drop(&mut self) {
        if let Some(change) = self.0.take() {
            change(-1);
        }
    }
}

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
    /// Start waiting for a human (`humanWait`): hold the guard until the
    /// answer is in.
    pub human_wait: Rc<dyn Fn() -> HumanWait>,
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
    vec![
        Rc::new(files::ReadTool::new()),
        Rc::new(files::WriteTool::new()),
        Rc::new(files::EditTool::new()),
        Rc::new(bash::BashTool::new()),
        Rc::new(files::LsTool::new()),
        Rc::new(files::FindTool::new()),
        Rc::new(files::GrepTool::new()),
    ]
}

/// `impl Tool` for a struct with a `spec: ToolSpec` field and an
/// `async fn run(&self, args, ctx) -> Result<ToolResult, String>`.
macro_rules! spec_tool {
    ($ty:ty, ptc: $ptc:expr) => {
        impl $crate::tools::Tool for $ty {
            fn name(&self) -> &str {
                self.spec.name
            }
            fn description(&self) -> &str {
                &self.spec.description
            }
            fn parameters(&self) -> &serde_json::Map<String, serde_json::Value> {
                &self.spec.parameters
            }
            fn ptc(&self) -> bool {
                $ptc
            }
            fn result_schema(&self) -> Option<&serde_json::Value> {
                self.spec.result_schema.as_ref()
            }
            fn execute<'a>(
                &'a self,
                args: serde_json::Map<String, serde_json::Value>,
                ctx: $crate::tools::ToolContext,
            ) -> $crate::LocalBoxFuture<'a, Result<$crate::tools::ToolResult, String>> {
                Box::pin(self.run(args, ctx))
            }
        }
    };
}
pub(crate) use spec_tool;

/// A tool's fixed definition: what the model and `ptc_docs` see.
pub struct ToolSpec {
    pub name: &'static str,
    pub description: String,
    pub parameters: Map<String, Value>,
    pub result_schema: Option<Value>,
}

impl ToolSpec {
    /// A spec whose description is `prompts/tools/<name>.md`; `parameters`
    /// and `result_schema` are JSON objects.
    pub fn new(name: &'static str, parameters: Value, result_schema: Option<Value>) -> Self {
        let Value::Object(parameters) = parameters else {
            panic!("the parameters of {name} are an object");
        };
        Self {
            name,
            description: prompts::fixed_prompt(name),
            parameters,
            result_schema,
        }
    }
}

/// `typed(value, data, {details, isError})`: a text result with `data`.
pub fn typed(
    value: impl Into<String>,
    data: Value,
    details: Option<Value>,
    is_error: bool,
) -> ToolResult {
    ToolResult {
        details,
        is_error,
        data: match data {
            Value::Object(map) => Some(map),
            _ => None,
        },
        ..ToolResult::text(value)
    }
}

/// `requireString(args, key)`.
pub fn require_string<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    match args.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(format!("{key} must be a non-empty string")),
    }
}

/// `optionalNumber(args, key)`.
pub fn optional_number(args: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(_) => Err(format!("{key} must be a number")),
    }
}

/// A non-empty string argument, else the default (`typeof v === 'string' && v ? v : d`).
pub fn string_or<'a>(args: &'a Map<String, Value>, key: &str, default: &'a str) -> &'a str {
    match args.get(key) {
        Some(Value::String(value)) if !value.is_empty() => value,
        _ => default,
    }
}

/// Run blocking file-system work off the event loop.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(work)
        .await
        .expect("blocking file-system work")
}
