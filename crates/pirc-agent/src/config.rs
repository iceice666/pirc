//! The agent's configuration (`agent/config.ts`): the node's `config.json`,
//! the workspace's `.pirc/config.json` (trust-gated), the system prompt's
//! files, path policy and limits. Providers come from the gateway.

use pirc_policy::PathPolicy;
use pirc_protocol::{ModelRef, Models, ThinkingLevel};
use serde_json::{Map, Value};

use crate::context::PromptSection;
use crate::roles::RoleDir;
use crate::session_store::SessionEntry;

/// One hook (`hookSchema`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookConfig {
    pub command: String,
    pub matcher: Option<String>,
    pub timeout_ms: u64,
}

/// `hooksSchema`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HooksConfig {
    pub session_start: Vec<HookConfig>,
    pub before_prompt: Vec<HookConfig>,
    pub before_tool: Vec<HookConfig>,
    pub after_tool: Vec<HookConfig>,
    pub agent_settled: Vec<HookConfig>,
}

/// `limitsSchema`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub bash_timeout_ms: u64,
    pub ptc_timeout_ms: u64,
    pub tool_output_bytes: u64,
    pub max_turns: u64,
    pub completion_wait_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            bash_timeout_ms: 120_000,
            ptc_timeout_ms: 120_000,
            tool_output_bytes: 51_200,
            max_turns: 200,
            completion_wait_ms: 60_000,
        }
    }
}

/// `WorkspaceKind`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WorkspaceKind {
    #[default]
    Directory,
    Chat,
}

/// `AgentConfig`.
#[derive(Clone, Debug)]
pub struct AgentConfig {
    pub config_dir: String,
    pub workspace: String,
    /// Providers and default model exactly as the gateway sent them.
    pub models: Models,
    /// The project's default model, else the gateway's.
    pub default_model: Option<ModelRef>,
    /// Canonical absolute paths the file tools may write, workspace first.
    pub allowed_paths: Vec<String>,
    /// Paths the agent may read but never write.
    pub protected_paths: Vec<String>,
    pub project_root: String,
    /// Problems shown when the session starts.
    pub warnings: Vec<String>,
    pub path_policy: PathPolicy,
    /// Inside the node's OS sandbox (`PIRC_SANDBOX=srt`).
    pub sandboxed: bool,
    pub env: Vec<(String, String)>,
    pub hooks: HooksConfig,
    pub limits: Limits,
    /// `features`: per-feature settings, as written.
    pub features: Map<String, Value>,
    pub role_dirs: Vec<RoleDir>,
    pub system_prompt: Vec<PromptSection>,
    pub workspace_kind: WorkspaceKind,
}

/// `loadAgentConfig(workspace, models, env)`.
pub fn load_agent_config(
    workspace: &str,
    models: Models,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<AgentConfig, String> {
    let _ = (workspace, models, env);
    todo!("M4 store: loadAgentConfig")
}

/// `sessionSettings(branch, config)`: the latest recorded model and
/// thinking level, else the defaults.
pub fn session_settings(
    branch: &[SessionEntry],
    default_model: Option<&ModelRef>,
    models: &Models,
) -> (Option<(String, String)>, ThinkingLevel) {
    let _ = (branch, default_model, models);
    todo!("M4 store: sessionSettings")
}
