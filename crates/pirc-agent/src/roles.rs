//! Roles (`agent/roles.ts`): role files, presets and model patterns.

use indexmap::IndexMap;
use pirc_protocol::Models;

/// `RolePreset`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RolePreset {
    pub instructions: Option<String>,
    pub models: Option<Vec<String>>,
    pub thinking: Option<String>,
    pub tools: Option<Vec<String>>,
    pub source: Option<String>,
}

/// `AgentRole`: the role an agent runs in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentRole {
    pub name: String,
    pub instructions: Option<String>,
    pub models: Option<Vec<String>>,
}

/// `RoleDir`.
#[derive(Clone, Debug, PartialEq)]
pub struct RoleDir {
    pub dir: String,
    pub source: String,
}

/// `roleDirs(configDir, workspace)`.
pub fn role_dirs(config_dir: &str, workspace: &str) -> Vec<RoleDir> {
    let _ = (config_dir, workspace);
    todo!("M4 store: roleDirs")
}

/// `readRoles(dirs)`: the defaults, then each directory's role files.
pub fn read_roles(dirs: &[RoleDir]) -> Result<IndexMap<String, RolePreset>, String> {
    let _ = dirs;
    todo!("M4 store: readRoles")
}

/// `expandModels(patterns, providers)`: catalog models matching the
/// patterns, in pattern order.
pub fn expand_models(patterns: &[String], models: &Models) -> Vec<(String, String)> {
    let _ = (patterns, models);
    todo!("M4 store: expandModels")
}
