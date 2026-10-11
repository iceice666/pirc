//! The per-session sandbox policy a node builds for each agent, ported from
//! `apps/gateway/src/sandbox-policy.ts` (`sessionPolicy`, `denyWriteAround`,
//! `sandboxConfigSchema`, `DEFAULT_ALLOWED_DOMAINS`, `LINUX_HOST_SOCKETS`,
//! `DOMAIN_PATTERN`) and `node/sandbox.ts` (`readAgentConfig`).
//!
//! Owner: **sandbox** (M6). Pure logic: `sandbox-policy.test.ts` is its
//! golden cases. Enforcement (srt's filesystem argument generation, macOS)
//! is M7. The types below are the interface the node's sandbox backends and
//! runner code against; add the constants (`DEFAULT_ALLOWED_DOMAINS`,
//! `LINUX_HOST_SOCKETS`) next to them.

use serde::{Deserialize, Serialize};

use crate::PathPolicy;

/// `sandbox` in the node's agent `config.json` (never the project's),
/// `sandboxConfigSchema`: strict objects, every field defaulted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxConfig {
    #[serde(default)]
    pub network: NetworkConfig,
    #[serde(default)]
    pub filesystem: FilesystemConfig,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    /// Include `DEFAULT_ALLOWED_DOMAINS` (default true).
    #[serde(default = "yes")]
    pub default_domains: bool,
    /// Each matches [`valid_domain`].
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    #[serde(default)]
    pub denied_domains: Vec<String>,
    /// Let dev servers listen on localhost (default true).
    #[serde(default = "yes")]
    pub allow_local_binding: bool,
    /// macOS: extra Unix sockets (an ssh-agent, the nix daemon).
    #[serde(default)]
    pub allow_unix_sockets: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesystemConfig {
    #[serde(default)]
    pub deny_read: Vec<String>,
    #[serde(default)]
    pub allow_read: Vec<String>,
    #[serde(default)]
    pub allow_write: Vec<String>,
    #[serde(default)]
    pub deny_write: Vec<String>,
    /// Let git write `.git/config`; off keeps hooks and fsmonitor out of reach.
    #[serde(default)]
    pub allow_git_config: bool,
}

fn yes() -> bool {
    true
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            default_domains: true,
            allowed_domains: Vec::new(),
            denied_domains: Vec::new(),
            allow_local_binding: true,
            allow_unix_sockets: Vec::new(),
        }
    }
}

/// The platform a policy is built for (`process.platform`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Macos,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Other
        }
    }
}

/// `SessionPolicyInput`. Paths are absolute strings, as in [`PathPolicy`];
/// the TS defaults (`os.homedir()`, `process.platform`, `process.getuid()`,
/// `$SSH_AUTH_SOCK`) are the caller's to fill in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionPolicyInput {
    pub config: SandboxConfig,
    /// Base for relative paths in `config` (the agent config directory).
    pub config_dir: String,
    pub home: String,
    /// pirc state no agent reads: the node's state dir and what it keeps elsewhere.
    pub private_dirs: Vec<String>,
    /// Where the agent works (the workspace, or a chat session's directory).
    pub workspace_root: String,
    /// Other paths the agent config allows writing (global `allowedPaths`).
    pub allowed_paths: Vec<String>,
    /// The session's own state (JSONL, team dir), inside `private_dirs`.
    pub session_dir: String,
    pub workspace_memory_dir: String,
    pub inference_socket: Option<String>,
    pub tmp_dirs: Vec<String>,
    /// Files next to the session that no agent may write (a project's instructions).
    pub protected_paths: Vec<String>,
    /// Directories inside `private_dirs` the session may read but never write.
    pub read_only_dirs: Vec<String>,
    /// Linux adds `LINUX_HOST_SOCKETS` to `deny_read`.
    pub platform: Platform,
    /// For `LINUX_HOST_SOCKETS`' `$UID`.
    pub uid: u32,
    /// For the agent's ssh-agent socket.
    pub ssh_auth_sock: Option<String>,
}

/// `SessionPolicy`. The agent gets `paths` as `PIRC_SANDBOX_POLICY` (JSON).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPolicy {
    pub paths: PathPolicy,
    pub network: NetworkPolicy,
    pub allow_git_config: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    pub allowed_domains: Vec<String>,
    pub denied_domains: Vec<String>,
    pub allow_local_binding: bool,
    pub allow_unix_sockets: Vec<String>,
}

/// The node's agent `config.json` as the sandbox reads it (`AgentConfigView`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentConfigView {
    pub config_dir: String,
    /// `allowedPaths`, resolved against `config_dir` with `~` expanded.
    pub allowed_paths: Vec<String>,
    pub sandbox: SandboxConfig,
    /// Set when `config.json` is unreadable or its `sandbox` invalid (the
    /// defaults apply), or when it still has `sandbox.enabled: false`.
    pub problem: Option<String>,
}

/// `DOMAIN_PATTERN` (case-insensitive): a host with an optional `*.` prefix,
/// `localhost`, or an IPv4 address, then an optional `:port`.
pub fn valid_domain(domain: &str) -> bool {
    let _ = domain;
    todo!("sandbox: port DOMAIN_PATTERN")
}

/// `sandboxConfigSchema.safeParse(value)`: `None` (absent) gives the
/// defaults; `Err` lists the issues as TS words them
/// (`<path>: <message>; ...`).
pub fn parse_sandbox_config(value: Option<&serde_json::Value>) -> Result<SandboxConfig, String> {
    let _ = value;
    todo!("sandbox: port sandboxConfigSchema")
}

/// `readAgentConfig`: `<config_dir>/config.json`'s `allowedPaths` and
/// `sandbox`, with the legacy `sandbox.enabled` dropped. Never fails:
/// problems are reported in [`AgentConfigView::problem`].
pub fn read_agent_config(config_dir: &str, home: &str) -> AgentConfigView {
    let _ = (config_dir, home);
    todo!("sandbox: port readAgentConfig")
}

/// `denyWriteAround`: `denyWrite` entries that close `dir` except `keep`.
pub fn deny_write_around(dir: &str, keep: &[String]) -> Vec<String> {
    let _ = (dir, keep);
    todo!("sandbox: port denyWriteAround")
}

/// `sessionPolicy`: what one session's agent may read, write and reach.
pub fn session_policy(input: &SessionPolicyInput) -> SessionPolicy {
    let _ = input;
    todo!("sandbox: port sessionPolicy")
}
