//! The PTC surface the model sees in every request (`agent/ptc/{registry,
//! signatures,schema,contracts,index}.ts`): the capability registry, the
//! system prompt's capability index, the `ptc` and `ptc_docs` tools and
//! argument validation. The script runtime is M5's.

pub use pirc_ptc::contracts;
pub mod registry;
pub mod schema;
pub mod signatures;

use std::cell::OnceCell;
use std::rc::{Rc, Weak};

use serde_json::{Map, Value, json};

use crate::host::AgentHost;
use crate::tools::{Tool, ToolContext, ToolResult, ToolSpec, js, spec_tool};
use contracts::{PtcError, budgets};
use signatures::{
    Block, CORE_CAPABILITIES, SIGNATURE_BUDGET_CHARS, compact_signature_of, fit_signatures,
    signature_of,
};

pub use registry::CapabilityRegistry;
pub use schema::validate_schema;

/// `DIRECT_CAPABILITIES` (= `CORE_CAPABILITIES`): the core capabilities the
/// model may call directly as well as from `ptc`, when available.
pub const DIRECT_CAPABILITIES: [&str; 9] = CORE_CAPABILITIES;
/// `WRAPPER_NAMES`: never capabilities themselves.
pub const WRAPPER_NAMES: [&str; 3] = contracts::WRAPPER_NAMES;

/// The text `ptc` returns until the script runtime exists (M5).
pub const PTC_UNAVAILABLE: &str = "PTC scripts are not available yet (M5)";

/// `errorResult(error)`: the error as JSON text, also in `details`.
fn error_result(error: &PtcError) -> ToolResult {
    let body = json!({ "error": error.to_json(None) });
    ToolResult {
        details: Some(body.clone()),
        ..ToolResult::error(js::stringify(&body))
    }
}

/// `ptc`: same name, description and parameters as the TS tool; running
/// scripts is M5's, so every call fails for now.
pub struct PtcTool {
    spec: ToolSpec,
}

impl Default for PtcTool {
    fn default() -> Self {
        Self::new()
    }
}

impl PtcTool {
    pub fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "ptc",
                json!({
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Body of an async TypeScript function, e.g. `const { text } = await tools.read({ path: \"README.md\" }); return text.split(\"\\n\").length;`",
                        },
                        "timeout": {
                            "type": "number",
                            "exclusiveMinimum": 0,
                            "maximum": budgets::MAX_ACTIVE_TIMEOUT_MS / 1000,
                            "description": "Active-time budget in seconds (default 120)",
                        },
                    },
                    "required": ["code"],
                    "additionalProperties": false,
                }),
                None,
            ),
        }
    }

    async fn run(
        &self,
        _args: Map<String, Value>,
        _ctx: ToolContext,
    ) -> Result<ToolResult, String> {
        Ok(ToolResult::error(PTC_UNAVAILABLE))
    }
}

spec_tool!(PtcTool, ptc: false);

/// `ptc_docs`: looks capabilities up in the registry.
pub struct PtcDocsTool {
    spec: ToolSpec,
    host: Weak<dyn AgentHost>,
    /// Made on first use: the host may not exist yet when the tool does.
    registry: OnceCell<CapabilityRegistry>,
}

impl PtcDocsTool {
    pub fn new(host: Weak<dyn AgentHost>) -> Self {
        Self {
            spec: ToolSpec::new(
                "ptc_docs",
                json!({
                    "type": "object",
                    "properties": {
                        "names": {
                            "type": "array",
                            "items": { "type": "string" },
                            "minItems": 1,
                            "maxItems": budgets::DOCS_NAMES,
                            "description": "Capabilities to document in full",
                        },
                        "category": { "type": "string", "description": "A category from the index" },
                        "cursor": { "type": "string", "description": "nextCursor of the previous page (with category)" },
                        "registryVersion": {
                            "type": "string",
                            "description": "registryVersion you already have; a mismatch fails with StaleContract",
                        },
                    },
                    "additionalProperties": false,
                }),
                None,
            ),
            host,
            registry: OnceCell::new(),
        }
    }

    async fn run(&self, args: Map<String, Value>, _ctx: ToolContext) -> Result<ToolResult, String> {
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| "The agent is shutting down".to_owned())?;
        let registry = self
            .registry
            .get_or_init(|| CapabilityRegistry::new(host.session_id()));
        match registry.docs(&args, &host.tool_list()) {
            Ok(docs) => Ok(ToolResult::text(js::stringify(&docs))),
            Err(error) => Ok(error_result(&error)),
        }
    }
}

spec_tool!(PtcDocsTool, ptc: false);

/// `modelTools(agent)`: `ptc` and `ptc_docs`.
pub fn model_tools(host: Weak<dyn AgentHost>) -> Vec<Rc<dyn Tool>> {
    vec![Rc::new(PtcTool::new()), Rc::new(PtcDocsTool::new(host))]
}

/// `capabilityIndexPrompt(agent)`: which core capabilities are also direct
/// tools and when to use a script instead, the approval convention, the
/// complete list by category, full signatures of the core capabilities and
/// one-line call signatures of the others within a 10,000-character budget;
/// any that do not fit are named for `ptc_docs`.
pub fn capability_index_prompt(host: &dyn AgentHost) -> Option<String> {
    let available = registry::available(&host.tool_list());
    let index = registry::index(&available);
    if index.is_empty() {
        return None;
    }
    let direct: Vec<String> = host
        .direct_tool_list()
        .iter()
        .map(|tool| format!("`{}`", tool.name()))
        .collect();
    let routing = if direct.is_empty() {
        "Everything you do goes through `ptc` scripts calling these capabilities (`tools.<name>(args)`).".to_owned()
    } else {
        format!(
            "Call {} directly as tools for a single operation, and for any operation that may need approval. Use one `ptc` script (`tools.<name>(args)`) when several operations can run together, produce output to filter, or follow from each other's results in a way code can work out: for example, run the tests and then read each file the output reports as failing, in one script rather than one call per step. Writing or editing a file and then checking it (running its tests, a build or a linter) is such a sequence too: do both in one script and return the check's output. Every other capability is reachable only from `ptc`.",
            direct.join(", ")
        )
    };
    let listed = index
        .iter()
        .map(|(category, names)| format!("- {category}: {}", names.join(", ")))
        .collect::<Vec<_>>()
        .join("\n");
    let mut sections = vec![format!(
        "## Capabilities\n\n{routing}\n\nWhen an operation needs the host's approval, the host asks the user as it runs. To request that approval, run the operation; do not ask for permission separately (for example with `ask_user_question`).\n\nThese are all the capabilities of this session: anything not listed here does not exist, so do not look for it.\n\n{listed}"
    )];
    let core: Vec<Block> = CORE_CAPABILITIES
        .iter()
        .filter_map(|name| available.get(*name))
        .map(|capability| Block {
            name: capability.name.clone(),
            block: signature_of(capability.tool.as_ref()),
        })
        .collect();
    let mut others: Vec<Block> = available
        .values()
        .filter(|capability| !CORE_CAPABILITIES.contains(&capability.name.as_str()))
        .map(|capability| Block {
            name: capability.name.clone(),
            block: compact_signature_of(capability.tool.as_ref()),
        })
        .collect();
    // Shortest first, then by name: deterministic for a set of capabilities.
    others.sort_by(|a, b| {
        js::len16(&a.block)
            .cmp(&js::len16(&b.block))
            .then_with(|| js::compare16(&a.name, &b.name))
    });
    let fitted = fit_signatures(&core, &others, SIGNATURE_BUDGET_CHARS);
    if !fitted.core_listed.is_empty() {
        sections.push(format!(
            "### Signatures in scripts\n\nComplete, so scripts need no `ptc_docs` lookup for these. Every result also has `text` (the formatted output), and `images` when there are any; a failure throws a `PtcError`.\n\n{}",
            fitted.core_listed.join("\n")
        ));
    }
    if !fitted.other_listed.is_empty() {
        sections.push(format!(
            "### Other capabilities\n\nCall these with the arguments shown. Each result has `text`; `ptc_docs({{ names: [...] }})` documents its typed fields if a script needs more.\n\n{}",
            fitted.other_listed.join("\n")
        ));
    }
    if !fitted.unlisted.is_empty() {
        let names: Vec<String> = fitted
            .unlisted
            .iter()
            .map(|name| format!("`{name}`"))
            .collect();
        sections.push(format!(
            "Look up {} with `ptc_docs({{ names: [...] }})` before first use.",
            names.join(", ")
        ));
    }
    Some(sections.join("\n\n"))
}

#[cfg(test)]
mod tests;
