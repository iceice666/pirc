//! The per-session sandbox policy a node builds for each agent, ported from
//! `apps/gateway/src/sandbox-policy.ts` (`sessionPolicy`, `denyWriteAround`,
//! `sandboxConfigSchema`, `DEFAULT_ALLOWED_DOMAINS`, `LINUX_HOST_SOCKETS`,
//! `DOMAIN_PATTERN`) and `node/sandbox.ts` (`readAgentConfig`).
//!
//! Owner: **sandbox** (M6). Pure logic: `sandbox-policy.test.ts` is its
//! golden cases. Enforcement (srt's filesystem argument generation, macOS)
//! is M7. The types below are the interface the node's sandbox backends and
//! runner code against. srt's settings (`srtSettings`) are rendered by the
//! node's srt backend (`pirc_node::sandbox::srt`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    CACHE_HOME_PATHS, PathPolicy, SENSITIVE_HOME_PATHS, expand_home_path, is_inside, real_resolve,
    resolve_path,
};

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
    /// Shared write roots; one inside `private_dirs` (the session's own
    /// temp dir in the node's private parent) is read back as well.
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
    /// Not TS's, and never serialized (not in srt's settings, not in
    /// `PIRC_SANDBOX_POLICY`): the deny entries `paths` lists by their
    /// symlink-resolved target, with the symlinks crossed on the way.
    ///
    /// `paths` names a protected path by where it leads (`~/.ssh` linking
    /// to `/elsewhere/ssh` is denied as `/elsewhere/ssh`), so a sandbox
    /// enforcing only `paths` leaves the link itself replaceable when a
    /// writable root holds it (`~` in `allowedPaths`): the agent removes the
    /// link and puts a directory of its own in its place. Each backend keeps
    /// these links in place (macOS: move-blocking denies on each link and
    /// its ancestors) or refuses to start. Only entries that cross at least
    /// one link are listed; see [`session_policy`] for which entries.
    #[serde(skip)]
    pub linked_denies: Vec<LinkedPath>,
}

/// A deny entry spelled through symlinks ([`SessionPolicy::linked_denies`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkedPath {
    /// The entry as given: absolute, `~` expanded, symlinks unresolved.
    pub spelled: String,
    /// What the policy lists for it (`real_resolve`).
    pub target: String,
    /// [`LinkWalk::links`] of `spelled`: every symlink crossed, in order.
    pub links: Vec<String>,
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

/// Package registries and code hosts most builds need (`DEFAULT_ALLOWED_DOMAINS`).
pub const DEFAULT_ALLOWED_DOMAINS: [&str; 30] = [
    // Git hosting
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "ghcr.io",
    "gitlab.com",
    "codeberg.org",
    // JavaScript
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "bun.sh",
    "jsr.io",
    "npm.jsr.io",
    // Python
    "pypi.org",
    "files.pythonhosted.org",
    // Rust
    "crates.io",
    "*.crates.io",
    "static.rust-lang.org",
    // Go
    "proxy.golang.org",
    "sum.golang.org",
    // Nix
    "cache.nixos.org",
    "channels.nixos.org",
    "releases.nixos.org",
    "tarballs.nixos.org",
    "*.cachix.org",
    // JVM and Android
    "repo.maven.apache.org",
    "repo1.maven.org",
    "plugins.gradle.org",
    "services.gradle.org",
    "dl.google.com",
    // Ruby
    "rubygems.org",
    "index.rubygems.org",
];

/// Linux: sockets that hand out the host (container engines, the system
/// and session buses, systemd), hidden from the sandbox because Unix
/// sockets cannot be filtered by path there (`LINUX_HOST_SOCKETS`). `$UID`
/// is the node account's.
pub const LINUX_HOST_SOCKETS: [&str; 23] = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/docker",
    "/run/containerd",
    "/run/podman",
    "/run/crio",
    "/var/run/libvirt",
    "/run/libvirt",
    "/run/lxd",
    "/var/snap/lxd/common/lxd",
    "/run/incus",
    "/var/lib/incus/unix.socket",
    "/run/dbus/system_bus_socket",
    "/var/run/dbus/system_bus_socket",
    "/run/systemd/private",
    "/run/systemd/io.systemd.Machine",
    "/run/systemd/userdb",
    "/run/user/$UID/docker.sock",
    "/run/user/$UID/podman",
    "/run/user/$UID/bus",
    "/run/user/$UID/systemd",
    "/run/user/$UID/gnupg",
    "/run/user/$UID/keyring",
];

/// The Linux host sockets [`session_policy`] hides (those that exist, as
/// spelled): [`LINUX_HOST_SOCKETS`] for `uid`, and the ssh-agent socket.
/// Not TS's name (TS built the list inline).
pub fn linux_host_sockets(uid: u32, ssh_auth_sock: Option<&str>) -> Vec<String> {
    let uid = uid.to_string();
    LINUX_HOST_SOCKETS
        .iter()
        .map(|item| item.replacen("$UID", &uid, 1))
        .chain(
            ssh_auth_sock
                .filter(|socket| !socket.is_empty())
                .map(str::to_owned),
        )
        .collect()
}

/// `DOMAIN_PATTERN` (case-insensitive): a host with an optional `*.` prefix,
/// `localhost`, or an IPv4 address, then an optional `:port`.
///
/// The regular expression, matched by hand:
/// `^((\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(\*\.)?localhost|(\d{1,3}\.){3}\d{1,3})(:\d{1,5})?$/i`.
/// No alternative contains `:` or backtracks across a `.`, so splitting on
/// them is exact. Without the `u` flag, JS's `i` folds ASCII letters only
/// (no `ſ` for `s`, no Kelvin sign for `k`), and `\d` is ASCII.
pub fn valid_domain(domain: &str) -> bool {
    let (host, port) = match domain.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (domain, None),
    };
    if let Some(port) = port
        && (!(1..=5).contains(&port.len()) || !port.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let digits =
        |part: &str| (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|part| digits(part)) {
        return true;
    }
    let host = host.strip_prefix("*.").unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let Some((top, rest)) = labels.split_last() else {
        return false;
    };
    let label = |part: &str| {
        let bytes = part.as_bytes();
        (1..=63).contains(&bytes.len())
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
            && bytes[0] != b'-'
            && bytes[bytes.len() - 1] != b'-'
    };
    !rest.is_empty()
        && rest.iter().all(|part| label(part))
        && (2..=63).contains(&top.len())
        && top.bytes().all(|b| b.is_ascii_alphabetic())
}

/// zod 3's name for a JSON value's type in "Expected X, received Y".
fn received(value: &serde_json::Value) -> &'static str {
    use serde_json::Value;
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// The keys of a JSON object in the order JS enumerates them: array-index
/// keys (`"0"`, `"17"`) ascending first, then the others as inserted.
fn js_key_order(object: &serde_json::Map<String, serde_json::Value>) -> Vec<&str> {
    let index = |key: &str| -> Option<u32> {
        let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
        let value: u32 = key
            .parse()
            .ok()
            .filter(|_| canonical && key.bytes().all(|b| b.is_ascii_digit()))?;
        (value < u32::MAX).then_some(value)
    };
    let mut indices: Vec<(u32, &str)> = object
        .keys()
        .filter_map(|key| index(key).map(|value| (value, key.as_str())))
        .collect();
    indices.sort_unstable();
    indices
        .into_iter()
        .map(|(_, key)| key)
        .chain(
            object
                .keys()
                .filter(|key| index(key).is_none())
                .map(String::as_str),
        )
        .collect()
}

/// What zod 3 reports while it parses `sandboxConfigSchema`: issues in
/// the order zod finds them (each object's shape keys in schema order, then
/// its unrecognized keys), as `<path>: <message>`.
struct Issues(Vec<String>);

impl Issues {
    fn push(&mut self, path: &[String], message: impl std::fmt::Display) {
        self.0.push(format!("{}: {message}", path.join(".")));
    }

    /// A strict object: `Some` with its fields when `value` is an object.
    fn object<'a>(
        &mut self,
        path: &[String],
        value: &'a serde_json::Value,
    ) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
        let Some(object) = value.as_object() else {
            self.push(
                path,
                format_args!("Expected object, received {}", received(value)),
            );
            return None;
        };
        Some(object)
    }

    /// The strict object's unrecognized-keys issue, after its fields'.
    fn unrecognized(
        &mut self,
        path: &[String],
        object: &serde_json::Map<String, serde_json::Value>,
        shape: &[&str],
    ) {
        let extra: Vec<String> = js_key_order(object)
            .into_iter()
            .filter(|key| !shape.contains(key))
            .map(|key| format!("'{key}'"))
            .collect();
        if !extra.is_empty() {
            self.push(
                path,
                format_args!("Unrecognized key(s) in object: {}", extra.join(", ")),
            );
        }
    }

    fn boolean(
        &mut self,
        path: &[String],
        value: Option<&serde_json::Value>,
        fallback: bool,
    ) -> bool {
        match value {
            None => fallback,
            Some(serde_json::Value::Bool(value)) => *value,
            Some(other) => {
                self.push(
                    path,
                    format_args!("Expected boolean, received {}", received(other)),
                );
                fallback
            }
        }
    }

    /// `z.array(z.string()...).default([])`; `check` is the string's own
    /// refinement (its message when it fails).
    fn strings(
        &mut self,
        path: &[String],
        value: Option<&serde_json::Value>,
        check: fn(&str) -> Option<&'static str>,
    ) -> Vec<String> {
        let Some(value) = value else {
            return Vec::new();
        };
        let Some(items) = value.as_array() else {
            self.push(
                path,
                format_args!("Expected array, received {}", received(value)),
            );
            return Vec::new();
        };
        let mut out = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let mut at = path.to_vec();
            at.push(index.to_string());
            match item.as_str() {
                None => self.push(
                    &at,
                    format_args!("Expected string, received {}", received(item)),
                ),
                Some(text) => match check(text) {
                    Some(message) => self.push(&at, message),
                    None => out.push(text.to_owned()),
                },
            }
        }
        out
    }
}

fn domain_check(text: &str) -> Option<&'static str> {
    (!valid_domain(text)).then_some("Invalid")
}

fn path_check(text: &str) -> Option<&'static str> {
    text.is_empty()
        .then_some("String must contain at least 1 character(s)")
}

const SANDBOX_SHAPE: [&str; 2] = ["network", "filesystem"];
const NETWORK_SHAPE: [&str; 5] = [
    "defaultDomains",
    "allowedDomains",
    "deniedDomains",
    "allowLocalBinding",
    "allowUnixSockets",
];
const FILESYSTEM_SHAPE: [&str; 5] = [
    "denyRead",
    "allowRead",
    "allowWrite",
    "denyWrite",
    "allowGitConfig",
];

/// `sandboxConfigSchema.safeParse(value)`: `None` (absent) gives the
/// defaults; `Err` lists the issues as TS words them
/// (`<path>: <message>; ...`, zod 3's messages).
pub fn parse_sandbox_config(value: Option<&serde_json::Value>) -> Result<SandboxConfig, String> {
    let mut issues = Issues(Vec::new());
    let mut config = SandboxConfig::default();
    if let Some(value) = value
        && let Some(root) = issues.object(&[], value)
    {
        let at = |key: &str| vec![key.to_owned()];
        if let Some(network) = root.get("network") {
            let path = at("network");
            if let Some(object) = issues.object(&path, network) {
                let field = |key: &str| {
                    let mut path = path.clone();
                    path.push(key.to_owned());
                    path
                };
                config.network = NetworkConfig {
                    default_domains: issues.boolean(
                        &field("defaultDomains"),
                        object.get("defaultDomains"),
                        true,
                    ),
                    allowed_domains: issues.strings(
                        &field("allowedDomains"),
                        object.get("allowedDomains"),
                        domain_check,
                    ),
                    denied_domains: issues.strings(
                        &field("deniedDomains"),
                        object.get("deniedDomains"),
                        domain_check,
                    ),
                    allow_local_binding: issues.boolean(
                        &field("allowLocalBinding"),
                        object.get("allowLocalBinding"),
                        true,
                    ),
                    allow_unix_sockets: issues.strings(
                        &field("allowUnixSockets"),
                        object.get("allowUnixSockets"),
                        path_check,
                    ),
                };
                issues.unrecognized(&path, object, &NETWORK_SHAPE);
            }
        }
        if let Some(filesystem) = root.get("filesystem") {
            let path = at("filesystem");
            if let Some(object) = issues.object(&path, filesystem) {
                let field = |key: &str| {
                    let mut path = path.clone();
                    path.push(key.to_owned());
                    path
                };
                config.filesystem = FilesystemConfig {
                    deny_read: issues.strings(
                        &field("denyRead"),
                        object.get("denyRead"),
                        path_check,
                    ),
                    allow_read: issues.strings(
                        &field("allowRead"),
                        object.get("allowRead"),
                        path_check,
                    ),
                    allow_write: issues.strings(
                        &field("allowWrite"),
                        object.get("allowWrite"),
                        path_check,
                    ),
                    deny_write: issues.strings(
                        &field("denyWrite"),
                        object.get("denyWrite"),
                        path_check,
                    ),
                    allow_git_config: issues.boolean(
                        &field("allowGitConfig"),
                        object.get("allowGitConfig"),
                        false,
                    ),
                };
                issues.unrecognized(&path, object, &FILESYSTEM_SHAPE);
            }
        }
        issues.unrecognized(&[], root, &SANDBOX_SHAPE);
    }
    if issues.0.is_empty() {
        Ok(config)
    } else {
        Err(issues.0.join("; "))
    }
}

/// `path.resolve(p)`: absolute against the process's working directory.
fn absolute(path: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "/".to_owned());
    resolve_path(&cwd, path)
}

/// `path.join(dir, name)`: normalized, relative when `dir` is.
fn join(dir: &str, name: &str) -> String {
    if dir.starts_with('/') {
        resolve_path(dir, name)
    } else {
        Path::new(dir).join(name).display().to_string()
    }
}

/// `readAgentConfig`: `<config_dir>/config.json`'s `allowedPaths` and
/// `sandbox`, with the legacy `sandbox.enabled` dropped. Never fails:
/// problems are reported in [`AgentConfigView::problem`].
///
/// Error texts for an unreadable or malformed file are Rust's, not Bun's.
/// A `config.json` of `null` made TS throw (`raw.allowedPaths` of null);
/// here it counts as an empty object, like any other non-object.
pub fn read_agent_config(config_dir: &str, home: &str) -> AgentConfigView {
    let file = join(config_dir, "config.json");
    let defaults = |problem: Option<String>| AgentConfigView {
        config_dir: config_dir.to_owned(),
        allowed_paths: Vec::new(),
        sandbox: SandboxConfig::default(),
        problem,
    };
    let mut raw = serde_json::Map::new();
    if Path::new(&file).exists() {
        let parsed = std::fs::read_to_string(&file)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<serde_json::Value>(&text).map_err(|error| error.to_string())
            });
        match parsed {
            Ok(serde_json::Value::Object(object)) => raw = object,
            Ok(_) => {}
            Err(message) => return defaults(Some(format!("{file}: {message}"))),
        }
    }
    let base = absolute(config_dir);
    let allowed_paths = raw
        .get("allowedPaths")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(|item| resolve_path(&base, &expand_home_path(item, home)))
                .collect()
        })
        .unwrap_or_default();
    // `enabled` turned the sandbox off before it became mandatory: drop it,
    // and say so when it asked for that.
    let mut sandbox = raw.get("sandbox").cloned();
    let mut legacy = None;
    if let Some(serde_json::Value::Object(object)) = &mut sandbox
        && let Some(enabled) = object.shift_remove("enabled")
        && enabled == serde_json::Value::Bool(false)
    {
        legacy = Some(format!(
            "{file}: \"sandbox.enabled\" is no longer supported; agents always run sandboxed"
        ));
    }
    match parse_sandbox_config(sandbox.as_ref()) {
        Ok(sandbox) => AgentConfigView {
            config_dir: config_dir.to_owned(),
            allowed_paths,
            sandbox,
            problem: legacy,
        },
        // Invalid settings must not loosen anything: keep the defaults.
        Err(issues) => AgentConfigView {
            config_dir: config_dir.to_owned(),
            allowed_paths,
            sandbox: SandboxConfig::default(),
            problem: Some(format!("{file}: invalid \"sandbox\": {issues}")),
        },
    }
}

/// `denyWriteAround`: `denyWrite` entries that close `dir` except `keep`
/// (paths inside it): every entry on the way to a kept path that does not
/// lead to one. srt has no "deny except", and its `denyWrite` always wins.
/// Entries are listed in directory order, as Bun's `readdirSync` gives them.
pub fn deny_write_around(dir: &str, keep: &[String]) -> Vec<String> {
    let inner: Vec<String> = keep
        .iter()
        .filter(|item| is_inside(item, dir))
        .cloned()
        .collect();
    if inner.iter().any(|item| item == dir) {
        return Vec::new();
    }
    if inner.is_empty() {
        return vec![dir.to_owned()];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .flat_map(|entry| {
            let name = entry.file_name();
            deny_write_around(&join(dir, &name.to_string_lossy()), &inner)
        })
        .collect()
}

const PROMPT_LINKS_ERROR: &str = "Cannot safely resolve prompt configuration symlinks";

/// `promptWritePaths`: `file` and, through every symlink on its way (even
/// a dangling one), where writes to it would land, so those stay
/// protected. Errors other than a missing component fail the policy, as
/// TS threw them (with Rust's texts).
fn prompt_write_paths(file: &str, seen: &mut Vec<String>) -> Result<Vec<String>, String> {
    let absolute = absolute(file);
    if seen.contains(&absolute) || seen.len() >= 40 {
        return Err(PROMPT_LINKS_ERROR.to_owned());
    }
    seen.push(absolute.clone());
    let parts: Vec<&str> = absolute
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let mut cursor = PathBuf::from("/");
    for (index, part) in parts.iter().enumerate() {
        cursor.push(part);
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = std::fs::read_link(&cursor).map_err(|error| error.to_string())?;
                let parent = cursor
                    .parent()
                    .map_or_else(|| "/".to_owned(), |p| p.display().to_string());
                let target = resolve_path(
                    &resolve_path(&parent, &link.to_string_lossy()),
                    &parts[index + 1..].join("/"),
                );
                let mut out = vec![absolute];
                out.extend(prompt_write_paths(&target, seen)?);
                return Ok(out);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(vec![absolute])
}

/// What resolving a path crosses ([`walk_links`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkWalk {
    /// Every symlink the kernel crosses resolving the path, in order and
    /// without repeats, each named with its parent directory resolved (the
    /// path that removing or renaming the link names), a dangling one
    /// included; and every directory a link's target leaves through `..`
    /// (replacing it moves where the target leads too).
    pub links: Vec<String>,
    /// The path with every symlink resolved as far as it exists, the rest
    /// appended (what the kernel resolves the path to now).
    pub target: Result<String, WalkError>,
}

/// Why [`walk_links`] stopped before the end of the path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalkError {
    /// More than 40 links (a loop).
    TooManyLinks,
    /// This link's target is not UTF-8.
    NotUtf8(String),
    /// This component cannot be examined (or its link not read).
    Unreadable(String),
}

/// Resolve absolute `path` one component at a time, as the kernel does:
/// a symlink's target is walked in its place (relative to the link's
/// directory), `..` leaves the directory reached so far. Stops at the
/// first component that does not exist (or is not a directory). Not TS's.
pub fn walk_links(path: &str) -> LinkWalk {
    let mut links: Vec<String> = Vec::new();
    let note = |links: &mut Vec<String>, path: &str| {
        if !links.iter().any(|link| link == path) {
            links.push(path.to_owned());
        }
    };
    let child = |dir: &str, name: &str| {
        if dir == "/" {
            format!("/{name}")
        } else {
            format!("{dir}/{name}")
        }
    };
    let parent = |dir: &str| match dir.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(at) => dir[..at].to_owned(),
    };
    // The components still to walk, the next one last.
    let mut pending: Vec<String> = absolute(path).split('/').rev().map(str::to_owned).collect();
    let mut cursor = String::from("/");
    let mut count = 0;
    while let Some(part) = pending.pop() {
        match part.as_str() {
            "" | "." => continue,
            ".." => {
                if cursor != "/" {
                    note(&mut links, &cursor);
                }
                cursor = parent(&cursor);
                continue;
            }
            _ => {}
        }
        let next = child(&cursor, &part);
        match std::fs::symlink_metadata(&next) {
            Ok(meta) if meta.file_type().is_symlink() => {
                note(&mut links, &next);
                count += 1;
                if count > 40 {
                    return LinkWalk {
                        links,
                        target: Err(WalkError::TooManyLinks),
                    };
                }
                let target = match std::fs::read_link(&next) {
                    Ok(target) => target,
                    Err(_) => {
                        return LinkWalk {
                            links,
                            target: Err(WalkError::Unreadable(next)),
                        };
                    }
                };
                let Some(target) = target.to_str() else {
                    return LinkWalk {
                        links,
                        target: Err(WalkError::NotUtf8(next)),
                    };
                };
                if target.starts_with('/') {
                    cursor = "/".to_owned();
                }
                pending.extend(target.split('/').rev().map(str::to_owned));
            }
            Ok(_) => cursor = next,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                let rest: Vec<String> = std::iter::once(part)
                    .chain(pending.into_iter().rev())
                    .collect();
                return LinkWalk {
                    links,
                    target: Ok(resolve_path(&cursor, &rest.join("/"))),
                };
            }
            Err(_) => {
                return LinkWalk {
                    links,
                    target: Err(WalkError::Unreadable(next)),
                };
            }
        }
    }
    LinkWalk {
        links,
        target: Ok(cursor),
    }
}

/// [`LinkedPath`] for `spelled` when resolving it crosses a link.
pub fn linked_path(spelled: &str) -> Option<LinkedPath> {
    let walk = walk_links(spelled);
    (!walk.links.is_empty()).then(|| LinkedPath {
        spelled: absolute(spelled),
        target: real_resolve(spelled),
        links: walk.links,
    })
}

/// Items in first-seen order without repeats (`[...new Set(items)]`).
fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// `existsSync` (follows symlinks).
fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// `sessionPolicy`: what one session's agent may read, write and reach.
///
/// `Err` where TS threw: a prompt configuration file behind too many (or
/// looping) symlinks, or a component of its path that cannot be examined.
///
/// [`SessionPolicy::linked_denies`] (not TS's) covers every deny entry the
/// policy resolves: the sensitive home paths, the private dirs, the
/// read-only dirs, the protected paths, the agent config dir and the
/// configured `denyRead` / `denyWrite` entries.
pub fn session_policy(input: &SessionPolicyInput) -> Result<SessionPolicy, String> {
    let home = input.home.as_str();
    let config_dir = absolute(&input.config_dir);
    let configured = |items: &[String]| -> Vec<String> {
        items
            .iter()
            .map(|item| real_resolve(&resolve_path(&config_dir, &expand_home_path(item, home))))
            .collect()
    };
    let resolve_all =
        |items: &[String]| -> Vec<String> { items.iter().map(|item| real_resolve(item)).collect() };
    let workspace = real_resolve(&input.workspace_root);
    let session_dir = real_resolve(&input.session_dir);
    let memory_dir = real_resolve(&input.workspace_memory_dir);
    let inference_socket = input
        .inference_socket
        .as_deref()
        .filter(|socket| !socket.is_empty());
    let socket_dir = inference_socket.map(|socket| {
        let parent = Path::new(&absolute(socket))
            .parent()
            .map_or_else(|| "/".to_owned(), |p| p.display().to_string());
        real_resolve(&parent)
    });
    let tmp_dirs = resolve_all(&input.tmp_dirs);
    let read_only_dirs = resolve_all(&input.read_only_dirs);
    let private_dirs = resolve_all(&input.private_dirs);
    let sensitive_spelled: Vec<String> = SENSITIVE_HOME_PATHS
        .iter()
        .map(|item| resolve_path(home, item))
        .filter(|item| exists(item))
        .collect();
    let sensitive: Vec<String> = sensitive_spelled
        .iter()
        .map(|item| real_resolve(item))
        .collect();
    let host_sockets: Vec<String> = if input.platform == Platform::Linux {
        linux_host_sockets(input.uid, input.ssh_auth_sock.as_deref())
            .into_iter()
            .filter(|item| exists(item))
            .collect()
    } else {
        Vec::new()
    };
    let SandboxConfig {
        filesystem,
        network,
    } = &input.config;
    let shared_write = unique(
        tmp_dirs.iter().cloned().chain(
            CACHE_HOME_PATHS
                .iter()
                .map(|item| real_resolve(&resolve_path(home, item)))
                .filter(|item| exists(item)),
        ),
    );
    let allow_write = unique(
        [workspace.clone()]
            .into_iter()
            .chain(resolve_all(&input.allowed_paths))
            .chain([session_dir.clone(), memory_dir.clone()])
            .chain(shared_write.iter().cloned())
            .chain(configured(&filesystem.allow_write)),
    );
    // What a session may write inside the node's private dirs: its own
    // state, and its own temp dir (the node keeps every session's temp dir
    // in a private parent, so sessions cannot reach each other's).
    // Not in TS, whose temp dirs sat beside each other.
    let private_tmp_dirs: Vec<String> = tmp_dirs
        .iter()
        .filter(|tmp| private_dirs.iter().any(|dir| is_inside(tmp, dir)))
        .cloned()
        .collect();
    let own_state: Vec<String> = [workspace.clone(), session_dir.clone(), memory_dir.clone()]
        .into_iter()
        .chain(private_tmp_dirs.iter().cloned())
        .collect();
    let mut prompt_paths = Vec::new();
    for name in ["SOUL.md", "CHAT.md"] {
        prompt_paths.extend(prompt_write_paths(
            &join(&input.config_dir, name),
            &mut Vec::new(),
        )?);
    }
    let paths = PathPolicy {
        deny_read: unique(
            private_dirs
                .iter()
                .cloned()
                .chain(sensitive.iter().cloned())
                .chain(host_sockets)
                .chain(configured(&filesystem.deny_read)),
        ),
        // What the session needs back from inside the private dirs. A chat
        // session's directory lives in the node's state.
        allow_read: unique(
            [workspace.clone(), session_dir.clone(), memory_dir.clone()]
                .into_iter()
                .chain(socket_dir)
                .chain(private_tmp_dirs)
                .chain(read_only_dirs.iter().cloned())
                .chain(configured(&filesystem.allow_read)),
        ),
        allow_write: allow_write.clone(),
        // The project's agent config; pirc keeps uploads and recordings
        // there itself, from outside the sandbox. Credential stores and the
        // node's private state stay closed even when a writable root
        // contains them (a workspace holding the state dir, `~` in
        // allowedPaths).
        deny_write: unique(
            [
                resolve_path(&workspace, ".pirc"),
                // srt keeps these read-only too; listed so the file tools
                // refuse them alike.
                resolve_path(&workspace, ".git/hooks"),
            ]
            .into_iter()
            .chain((!filesystem.allow_git_config).then(|| resolve_path(&workspace, ".git/config")))
            // User-managed global configuration stays read-only even under
            // an allowed root.
            .chain([real_resolve(&input.config_dir)])
            .chain(prompt_paths)
            .chain(resolve_all(&input.protected_paths))
            .chain(sensitive)
            .chain(read_only_dirs)
            .chain(
                private_dirs
                    .iter()
                    .filter(|dir| allow_write.iter().any(|root| is_inside(dir, root)))
                    .flat_map(|dir| deny_write_around(dir, &own_state)),
            )
            .chain(configured(&filesystem.deny_write)),
        ),
        shared_write: Some(shared_write),
    };
    let configured_spelled = |items: &[String]| -> Vec<String> {
        items
            .iter()
            .map(|item| resolve_path(&config_dir, &expand_home_path(item, home)))
            .collect()
    };
    let linked_denies: Vec<LinkedPath> = unique(
        sensitive_spelled
            .into_iter()
            .chain(input.private_dirs.iter().map(|dir| absolute(dir)))
            .chain(input.read_only_dirs.iter().map(|dir| absolute(dir)))
            .chain(input.protected_paths.iter().map(|path| absolute(path)))
            .chain([config_dir.clone()])
            .chain(configured_spelled(&filesystem.deny_read))
            .chain(configured_spelled(&filesystem.deny_write)),
    )
    .iter()
    .filter_map(|spelled| linked_path(spelled))
    .collect();
    Ok(SessionPolicy {
        paths,
        linked_denies,
        network: NetworkPolicy {
            allowed_domains: unique(
                DEFAULT_ALLOWED_DOMAINS
                    .iter()
                    .filter(|_| network.default_domains)
                    .map(|item| (*item).to_owned())
                    .chain(network.allowed_domains.iter().cloned()),
            ),
            denied_domains: unique(network.denied_domains.iter().cloned()),
            allow_local_binding: network.allow_local_binding,
            allow_unix_sockets: unique(
                inference_socket
                    .iter()
                    .map(|socket| real_resolve(socket))
                    .chain(configured(&network.allow_unix_sockets)),
            ),
        },
        allow_git_config: filesystem.allow_git_config,
    })
}

/// Golden cases: `apps/gateway/test/sandbox-policy.test.ts` (the srt
/// settings case is with the node's srt backend), plus zod 3's reports
/// and `DOMAIN_PATTERN` verdicts recorded from the TS sources.
#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use serde_json::json;

    use super::*;
    use crate::{PathGuard, read_allowed, write_allowed};

    struct Layout {
        _dir: tempfile::TempDir,
        root: String,
        home: String,
        state: String,
        session: String,
        memory: String,
        socket: String,
        workspace: String,
        chat: String,
        tmp: String,
    }

    fn p(base: &str, rest: &str) -> String {
        format!("{base}/{rest}")
    }

    fn layout() -> Layout {
        let dir = tempfile::Builder::new()
            .prefix("pirc-policy-")
            .tempdir()
            .unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        let home = p(&root, "home");
        let state = p(&root, "state");
        let d = Layout {
            session: p(&state, "sessions/pi_1"),
            memory: p(&state, "workspace-memory"),
            socket: p(&state, "i-abc/socket"),
            workspace: p(&root, "ws"),
            chat: p(&state, "chat/chats/sessions/s1"),
            tmp: p(&root, "tmp"),
            _dir: dir,
            root,
            home,
            state,
        };
        for dir in [
            &d.session,
            &d.memory,
            &p(&d.state, "i-abc"),
            &d.workspace,
            &d.chat,
            &d.tmp,
            &p(&d.home, ".ssh"),
            &p(&d.home, ".cache"),
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        d
    }

    fn config(value: serde_json::Value) -> SandboxConfig {
        parse_sandbox_config(Some(&value)).unwrap()
    }

    fn input(
        d: &Layout,
        workspace_root: &str,
        config_value: serde_json::Value,
    ) -> SessionPolicyInput {
        SessionPolicyInput {
            config: config(config_value),
            config_dir: p(&d.root, "config"),
            home: d.home.clone(),
            private_dirs: vec![d.state.clone()],
            workspace_root: workspace_root.to_owned(),
            allowed_paths: Vec::new(),
            session_dir: d.session.clone(),
            workspace_memory_dir: d.memory.clone(),
            inference_socket: Some(d.socket.clone()),
            tmp_dirs: vec![d.tmp.clone()],
            protected_paths: Vec::new(),
            read_only_dirs: Vec::new(),
            platform: Platform::current(),
            uid: 1000,
            ssh_auth_sock: None,
        }
    }

    fn policy_for(
        d: &Layout,
        workspace_root: &str,
        config_value: serde_json::Value,
    ) -> SessionPolicy {
        session_policy(&input(d, workspace_root, config_value)).unwrap()
    }

    #[test]
    fn hides_pirc_state_and_credentials_but_gives_the_session_its_own_directories_back() {
        let d = layout();
        let SessionPolicy { paths, network, .. } = policy_for(&d, &d.workspace, json!({}));
        assert!(!read_allowed(&paths, &p(&d.state, "node.sqlite")));
        assert!(!read_allowed(&paths, &p(&d.state, "sessions/pi_2/x.jsonl")));
        assert!(read_allowed(&paths, &p(&d.session, "session.jsonl")));
        assert!(read_allowed(&paths, &p(&d.memory, "k.jsonl")));
        assert!(read_allowed(&paths, &d.socket));
        assert!(!read_allowed(&paths, &p(&d.home, ".ssh/id_ed25519")));
        assert!(read_allowed(&paths, &p(&d.home, "notes.md")));
        assert!(write_allowed(&paths, &p(&d.workspace, "src/a.ts")));
        assert!(!write_allowed(
            &paths,
            &p(&d.workspace, ".pirc/config.json")
        ));
        assert!(!write_allowed(
            &paths,
            &p(&d.workspace, ".git/hooks/pre-commit")
        ));
        assert!(!write_allowed(&paths, &p(&d.workspace, ".git/config")));
        assert!(write_allowed(&paths, &p(&d.workspace, ".git/index")));
        let git_config = policy_for(
            &d,
            &d.workspace,
            json!({ "filesystem": { "allowGitConfig": true } }),
        );
        assert!(write_allowed(
            &git_config.paths,
            &p(&d.workspace, ".git/config")
        ));
        assert!(write_allowed(&paths, &p(&d.home, ".cache/bun/x")));
        assert!(!write_allowed(&paths, &p(&d.home, ".bashrc")));
        assert!(write_allowed(&paths, &p(&d.tmp, "x")));
        assert!(!write_allowed(&paths, &p(&d.state, "node.sqlite")));
        // Temp dirs and build caches are shared by every session: no write lease.
        assert_eq!(
            paths.shared_write.as_deref().unwrap(),
            [d.tmp.clone(), p(&d.home, ".cache")]
        );
        for domain in DEFAULT_ALLOWED_DOMAINS {
            assert!(network.allowed_domains.iter().any(|d| d == domain));
        }
        assert_eq!(network.allow_unix_sockets, std::slice::from_ref(&d.socket));
    }

    #[test]
    fn a_temp_dir_in_a_private_parent_is_the_sessions_own() {
        let d = layout();
        // The node's private parent of every session's temp dir, inside a
        // shared write root (`/tmp`).
        let parent = p(&d.tmp, "pirc-n-abc");
        let (own, other) = (p(&parent, "pirc-1"), p(&parent, "pirc-2"));
        fs::create_dir_all(&own).unwrap();
        fs::create_dir_all(&other).unwrap();
        let mut input = input(&d, &d.workspace, json!({}));
        input.private_dirs.push(parent.clone());
        input.tmp_dirs = vec![own.clone(), d.tmp.clone()];
        let paths = session_policy(&input).unwrap().paths;
        assert!(read_allowed(&paths, &p(&own, "proxy.sock")));
        assert!(write_allowed(&paths, &p(&own, "x")));
        assert!(!read_allowed(&paths, &p(&other, "proxy.sock")));
        assert!(!write_allowed(&paths, &p(&other, "proxy.sock")));
        // As for the sessions directory: closed to reads (the sandboxes
        // mount an empty directory there), siblings closed to writes.
        assert!(!read_allowed(&paths, &p(&parent, "pirc-3")));
        assert!(write_allowed(&paths, &p(&d.tmp, "x")));
        // The shared root itself is not reopened.
        assert!(!paths.allow_read.contains(&d.tmp));
    }

    #[test]
    fn takes_no_write_lease_for_shared_roots_the_innermost_root_otherwise() {
        let d = layout();
        let guard = PathGuard::with_home(
            &d.workspace,
            &policy_for(&d, &d.workspace, json!({})).paths,
            &[],
            &d.home,
        );
        assert_eq!(guard.lease_root(&p(&d.tmp, "x/y")), None);
        assert_eq!(guard.lease_root(&p(&d.home, ".cache/bun/x")), None);
        assert_eq!(
            guard.lease_root(&p(&d.workspace, "src/a.ts")).as_deref(),
            Some(d.workspace.as_str())
        );
        // A workspace inside a shared root is still leased.
        let nested = p(&d.tmp, "ws");
        fs::create_dir(&nested).unwrap();
        let in_tmp = PathGuard::with_home(
            &nested,
            &policy_for(&d, &nested, json!({})).paths,
            &[],
            &d.home,
        );
        assert_eq!(
            in_tmp.lease_root(&p(&nested, "a.ts")).as_deref(),
            Some(nested.as_str())
        );
        assert_eq!(in_tmp.lease_root(&p(&d.tmp, "other")), None);
    }

    #[test]
    fn lets_a_chat_session_work_in_its_directory_inside_the_nodes_state() {
        let d = layout();
        let paths = policy_for(&d, &d.chat, json!({})).paths;
        assert!(read_allowed(&paths, &p(&d.chat, "notes.md")));
        assert!(write_allowed(&paths, &p(&d.chat, "notes.md")));
        assert!(!read_allowed(
            &paths,
            &p(&d.state, "chat/chats/sessions/s2/x")
        ));
    }

    #[test]
    fn never_lets_a_chat_session_touch_its_projects_instructions() {
        let d = layout();
        let instructions = p(&d.state, "chat/chats/instructions.md");
        let mut input = input(
            &d,
            &d.chat,
            json!({ "filesystem": { "allowWrite": [d.state] } }),
        );
        input.inference_socket = None;
        input.protected_paths = vec![instructions.clone()];
        let paths = session_policy(&input).unwrap().paths;
        assert!(!read_allowed(&paths, &instructions));
        assert!(!write_allowed(&paths, &instructions));
        assert!(write_allowed(&paths, &p(&d.chat, "notes.md")));
    }

    #[test]
    fn protects_global_prompt_configuration_inside_writable_roots_including_absent_files() {
        let d = layout();
        let config_dir = p(&d.tmp, "config");
        fs::create_dir(&config_dir).unwrap();
        let mut input = input(&d, &d.workspace, json!({}));
        input.config_dir = config_dir.clone();
        input.allowed_paths = vec![d.root.clone()];
        input.inference_socket = None;
        let paths = session_policy(&input).unwrap().paths;
        for name in ["SOUL.md", "CHAT.md", "config.json"] {
            assert!(read_allowed(&paths, &p(&config_dir, name)));
            assert!(!write_allowed(&paths, &p(&config_dir, name)));
        }
        assert!(write_allowed(&paths, &p(&d.tmp, "ordinary.txt")));
    }

    #[test]
    fn protects_the_prospective_targets_of_dangling_managed_prompt_symlinks() {
        let d = layout();
        let config_dir = p(&d.tmp, "config");
        fs::create_dir(&config_dir).unwrap();
        for name in ["SOUL.md", "CHAT.md"] {
            symlink(p(&d.workspace, name), p(&config_dir, name)).unwrap();
        }
        let mut input = input(&d, &d.workspace, json!({}));
        input.config_dir = config_dir;
        input.inference_socket = None;
        let paths = session_policy(&input).unwrap().paths;
        for name in ["SOUL.md", "CHAT.md"] {
            assert!(!write_allowed(&paths, &p(&d.workspace, name)));
        }
    }

    #[test]
    fn walks_links_as_the_kernel_does() {
        let d = layout();
        let r = |rest: &str| p(&d.root, rest);
        fs::create_dir_all(r("real/sub")).unwrap();
        fs::create_dir_all(r("other")).unwrap();
        symlink(r("real"), r("abs")).unwrap();
        symlink("hop", r("rel")).unwrap();
        symlink("real/sub", r("hop")).unwrap();
        // `..` from the link's target, not from the link's spelling.
        symlink("real/sub/../../other", r("up")).unwrap();
        symlink("nowhere/x", r("dangling")).unwrap();
        symlink("loop", r("loop")).unwrap();
        let walk = walk_links(&r("abs/sub/missing/file"));
        assert_eq!(walk.links, [r("abs")]);
        assert_eq!(walk.target, Ok(r("real/sub/missing/file")));
        let walk = walk_links(&r("rel/f"));
        assert_eq!(walk.links, [r("rel"), r("hop")]);
        assert_eq!(walk.target, Ok(r("real/sub/f")));
        let walk = walk_links(&r("up"));
        assert_eq!(walk.links, [r("up"), r("real/sub"), r("real")]);
        assert_eq!(walk.target, Ok(r("other")));
        let walk = walk_links(&r("dangling"));
        assert_eq!(walk.links, [r("dangling")]);
        assert_eq!(walk.target, Ok(r("nowhere/x")));
        let walk = walk_links(&r("loop/x"));
        assert_eq!(walk.links, [r("loop")]);
        assert_eq!(walk.target, Err(WalkError::TooManyLinks));
        let walk = walk_links(&r("real/sub"));
        assert!(walk.links.is_empty());
        assert_eq!(walk.target, Ok(r("real/sub")));
        assert_eq!(linked_path(&r("real")), None);
    }

    /// `~/.ssh` linking out of the home directory is denied by its target,
    /// which leaves the link replaceable under a writable `~`: the policy
    /// lists it (and every other linked deny spelling) without changing
    /// what it passes to srt or to the agent.
    #[test]
    fn lists_the_links_of_linked_deny_entries_without_serializing_them() {
        let d = layout();
        let r = |rest: &str| p(&d.root, rest);
        fs::create_dir_all(r("outside/ssh")).unwrap();
        fs::create_dir_all(r("outside/secrets")).unwrap();
        fs::create_dir_all(r("outside/bin")).unwrap();
        fs::remove_dir(p(&d.home, ".ssh")).unwrap();
        symlink(r("outside/ssh"), p(&d.home, ".ssh")).unwrap();
        // A chain: ~/.aws -> ~/hop -> outside/aws (relative hop).
        fs::create_dir_all(r("outside/aws")).unwrap();
        symlink(r("outside/aws"), p(&d.home, "hop")).unwrap();
        symlink("hop", p(&d.home, ".aws")).unwrap();
        symlink(r("state"), r("state-link")).unwrap();
        symlink(r("outside/bin"), r("bin-link")).unwrap();
        symlink(r("outside/secrets"), p(&d.home, "secrets")).unwrap();
        let notes = p(&d.workspace, "AGENTS.md");
        fs::write(r("outside/AGENTS.md"), "").unwrap();
        symlink(r("outside/AGENTS.md"), &notes).unwrap();
        let mut input = input(
            &d,
            &d.workspace,
            json!({ "filesystem": { "denyRead": ["~/secrets"] } }),
        );
        input.allowed_paths = vec![d.home.clone()];
        input.private_dirs = vec![r("state-link")];
        input.read_only_dirs = vec![r("bin-link")];
        input.protected_paths = vec![notes.clone()];
        let policy = session_policy(&input).unwrap();
        let linked = |spelled: &str| {
            policy
                .linked_denies
                .iter()
                .find(|entry| entry.spelled == spelled)
                .unwrap_or_else(|| panic!("{spelled}: {:#?}", policy.linked_denies))
                .clone()
        };
        let ssh = linked(&p(&d.home, ".ssh"));
        assert_eq!(ssh.links, [p(&d.home, ".ssh")]);
        assert_eq!(ssh.target, r("outside/ssh"));
        let aws = linked(&p(&d.home, ".aws"));
        assert_eq!(aws.links, [p(&d.home, ".aws"), p(&d.home, "hop")]);
        assert_eq!(aws.target, r("outside/aws"));
        assert_eq!(linked(&r("state-link")).links, [r("state-link")]);
        assert_eq!(linked(&r("bin-link")).links, [r("bin-link")]);
        assert_eq!(linked(&notes).links, std::slice::from_ref(&notes));
        assert_eq!(linked(&p(&d.home, "secrets")).target, r("outside/secrets"));
        assert!(
            policy
                .linked_denies
                .iter()
                .all(|entry| entry.spelled != d.workspace),
            "allows are not listed"
        );
        // The lists srt and the agent get name targets only, as before.
        assert!(policy.paths.deny_read.contains(&r("outside/ssh")));
        assert!(!policy.paths.deny_read.contains(&p(&d.home, ".ssh")));
        let json = serde_json::to_value(&policy).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["allowGitConfig", "network", "paths"]);
        assert!(!json.to_string().contains("hop"));
        let back: SessionPolicy = serde_json::from_value(json).unwrap();
        assert!(back.linked_denies.is_empty());
        // Nothing linked, nothing listed.
        let plain = layout();
        assert_eq!(
            policy_for(&plain, &plain.workspace, json!({})).linked_denies,
            []
        );
    }

    #[test]
    fn refuses_prompt_symlink_loops() {
        let d = layout();
        let config_dir = p(&d.tmp, "config");
        fs::create_dir(&config_dir).unwrap();
        symlink(p(&config_dir, "CHAT.md"), p(&config_dir, "SOUL.md")).unwrap();
        symlink(p(&config_dir, "SOUL.md"), p(&config_dir, "CHAT.md")).unwrap();
        let mut input = input(&d, &d.workspace, json!({}));
        input.config_dir = config_dir;
        assert_eq!(session_policy(&input).unwrap_err(), PROMPT_LINKS_ERROR);
    }

    #[test]
    fn keeps_a_deny_inside_an_allowed_region_and_takes_configured_additions() {
        let d = layout();
        let SessionPolicy {
            paths,
            network,
            allow_git_config,
            ..
        } = policy_for(
            &d,
            &d.workspace,
            json!({
                "network": { "defaultDomains": false, "allowedDomains": ["api.example.com", "127.0.0.1:8080"] },
                "filesystem": { "denyRead": ["~/private"], "allowWrite": ["~/out"], "allowGitConfig": true },
            }),
        );
        assert!(!read_allowed(&paths, &p(&d.home, "private/x")));
        assert!(write_allowed(&paths, &p(&d.home, "out/x")));
        assert_eq!(
            network.allowed_domains,
            ["api.example.com", "127.0.0.1:8080"]
        );
        assert!(allow_git_config);
        // A workspace inside $HOME does not re-open credentials under it.
        let in_home = policy_for(&d, &d.home, json!({})).paths;
        assert!(!read_allowed(&in_home, &p(&d.home, ".ssh/id_ed25519")));
    }

    #[test]
    fn keeps_the_nodes_state_and_credentials_unwritable_even_inside_a_writable_root() {
        let d = layout();
        // Development layout: the node's state lives inside the workspace.
        let workspace = d.root.clone();
        fs::write(p(&d.state, "node.sqlite"), "").unwrap();
        fs::create_dir_all(p(&d.state, "sandbox/bin")).unwrap();
        // Only what exists now: the node warns that later entries are open.
        fs::create_dir_all(p(&d.state, "sessions/pi_2")).unwrap();
        let mut input = input(&d, &workspace, json!({}));
        input.allowed_paths = vec![d.home.clone()];
        input.inference_socket = None;
        input.read_only_dirs = vec![p(&d.state, "sandbox/bin")];
        let paths = session_policy(&input).unwrap().paths;
        assert!(write_allowed(&paths, &p(&workspace, "src/a.ts")));
        assert!(!write_allowed(&paths, &p(&d.state, "node.sqlite")));
        assert!(!write_allowed(
            &paths,
            &p(&d.state, "sessions/pi_2/x.jsonl")
        ));
        assert!(write_allowed(&paths, &p(&d.session, "session.jsonl")));
        assert!(write_allowed(&paths, &p(&d.memory, "k.jsonl")));
        assert!(!write_allowed(
            &paths,
            &p(&d.state, "sandbox/bin/apply-seccomp")
        ));
        assert!(read_allowed(
            &paths,
            &p(&d.state, "sandbox/bin/apply-seccomp")
        ));
        assert!(!read_allowed(&paths, &p(&d.state, "sandbox/other.json")));
        // `~` in allowedPaths does not open credential stores.
        assert!(!write_allowed(&paths, &p(&d.home, ".ssh/authorized_keys")));
        assert!(write_allowed(&paths, &p(&d.home, "notes.md")));
    }

    #[test]
    fn deny_write_around_closes_everything_but_the_way_to_kept_paths() {
        let d = layout();
        fs::write(p(&d.state, "node.sqlite"), "").unwrap();
        let mut denied = deny_write_around(&d.state, &[d.session.clone(), d.memory.clone()]);
        denied.sort();
        let mut expected = vec![
            p(&d.state, "chat"),
            p(&d.state, "i-abc"),
            p(&d.state, "node.sqlite"),
        ];
        expected.sort();
        assert_eq!(denied, expected);
        assert_eq!(
            deny_write_around(&d.state, std::slice::from_ref(&d.state)),
            Vec::<String>::new()
        );
        assert_eq!(
            deny_write_around(&d.state, std::slice::from_ref(&d.workspace)),
            std::slice::from_ref(&d.state)
        );
    }

    #[test]
    fn hides_host_sockets_from_linux_sandboxes() {
        let d = layout();
        let agent_socket = p(&d.root, "ssh-agent.sock");
        fs::write(&agent_socket, "").unwrap();
        let mut linux = input(&d, &d.workspace, json!({}));
        linux.inference_socket = None;
        linux.ssh_auth_sock = Some(agent_socket.clone());
        linux.platform = Platform::Linux;
        let mut mac = linux.clone();
        mac.platform = Platform::Macos;
        assert!(!read_allowed(
            &session_policy(&linux).unwrap().paths,
            &agent_socket
        ));
        assert!(read_allowed(
            &session_policy(&mac).unwrap().paths,
            &agent_socket
        ));
    }

    #[test]
    fn accepts_hosts_wildcards_ports_and_ipv4_addresses_only() {
        for ok in [
            "github.com",
            "*.github.com",
            "api.example.com:443",
            "localhost:3000",
            "127.0.0.1:8080",
        ] {
            assert!(valid_domain(ok), "{ok}");
        }
        for bad in [
            "*",
            "http://github.com",
            "github.com/path",
            "*.com.",
            "a b.com",
            "",
        ] {
            assert!(!valid_domain(bad), "{bad}");
        }
        // Recorded from DOMAIN_PATTERN.test in the TS build.
        let long = |n: usize| format!("a.{}.com", "b".repeat(n));
        for (domain, expected) in [
            ("API.Example.COM:443", true),
            ("localhost", true),
            ("*.localhost:1", true),
            ("1.2.3.4", true),
            ("999.1.1.1:99999", true),
            ("a.b", false),
            ("a.co", true),
            ("a-.com", false),
            ("-a.com", false),
            ("x.c0m", false),
            ("xn--abc.com", true),
            ("a..com", false),
            ("*.*.com", false),
            ("localhost.com", true),
            (&long(63), true),
            (&long(64), false),
            ("a.com:123456", false),
            ("a.com:", false),
            ("1.2.3.4.5", false),
            ("*.1.2.3.4", false),
            ("café.com", false),
            ("a_b.com", false),
            ("a.com\n", false),
            ("\u{17f}.com", false),
        ] {
            assert_eq!(valid_domain(domain), expected, "{domain:?}");
        }
    }

    /// zod 3.25's reports for `sandboxConfigSchema`, recorded from the TS
    /// sources (`<path>: <message>` joined with "; ", as `readAgentConfig`
    /// words them).
    #[test]
    fn reports_schema_issues_as_zod_does() {
        let defaults = SandboxConfig::default();
        assert_eq!(parse_sandbox_config(None).unwrap(), defaults);
        assert_eq!(parse_sandbox_config(Some(&json!({}))).unwrap(), defaults);
        assert!(defaults.network.default_domains && defaults.network.allow_local_binding);
        for (value, expected) in [
            (json!(null), ": Expected object, received null"),
            (json!("x"), ": Expected object, received string"),
            (json!([]), ": Expected object, received array"),
            (json!(5), ": Expected object, received number"),
            (
                json!({ "network": { "allowedDomains": ["not a host"] } }),
                "network.allowedDomains.0: Invalid",
            ),
            (
                json!({ "network": { "allowedDomains": ["ok.com", 5, ""] } }),
                "network.allowedDomains.1: Expected string, received number; network.allowedDomains.2: Invalid",
            ),
            (
                json!({ "network": { "allowedDomains": "github.com" } }),
                "network.allowedDomains: Expected array, received string",
            ),
            (
                json!({ "network": { "defaultDomains": "yes", "allowLocalBinding": null } }),
                "network.defaultDomains: Expected boolean, received string; network.allowLocalBinding: Expected boolean, received null",
            ),
            (
                json!({ "network": { "allowUnixSockets": [""] } }),
                "network.allowUnixSockets.0: String must contain at least 1 character(s)",
            ),
            (
                json!({ "network": null }),
                "network: Expected object, received null",
            ),
            (
                json!({ "network": [] }),
                "network: Expected object, received array",
            ),
            (
                json!({ "filesystem": { "denyRead": [1], "allowGitConfig": 1 } }),
                "filesystem.denyRead.0: Expected string, received number; filesystem.allowGitConfig: Expected boolean, received number",
            ),
            (
                json!({ "extra": 1, "network": { "bogus": true, "also": 2, "allowedDomains": ["x"] }, "more": 2 }),
                "network.allowedDomains.0: Invalid; network: Unrecognized key(s) in object: 'bogus', 'also'; : Unrecognized key(s) in object: 'extra', 'more'",
            ),
            (
                json!({ "filesystem": { "denyWrite": [""], "nope": 1 }, "network": { "deniedDomains": ["a b"] } }),
                "network.deniedDomains.0: Invalid; filesystem.denyWrite.0: String must contain at least 1 character(s); filesystem: Unrecognized key(s) in object: 'nope'",
            ),
            (
                json!({ "network": { "allowedDomains": [{}, true] } }),
                "network.allowedDomains.0: Expected string, received object; network.allowedDomains.1: Expected string, received boolean",
            ),
            (
                json!({ "enabled": true }),
                ": Unrecognized key(s) in object: 'enabled'",
            ),
            // JS lists array-index keys first.
            (
                json!({ "b": 1, "10": 1, "2": 1, "01": 1 }),
                ": Unrecognized key(s) in object: '2', '10', 'b', '01'",
            ),
        ] {
            assert_eq!(
                parse_sandbox_config(Some(&value)).unwrap_err(),
                expected,
                "{value}"
            );
        }
    }

    #[test]
    fn keeps_the_defaults_and_reports_a_mistake_instead_of_loosening_anything() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().display().to_string();
        fs::write(
            p(&config_dir, "config.json"),
            json!({ "allowedPaths": ["~/extra", 5, "rel"], "sandbox": { "network": { "allowedDomains": ["not a host"] } } })
                .to_string(),
        )
        .unwrap();
        let view = read_agent_config(&config_dir, "/home/u");
        let problem = view.problem.unwrap();
        assert!(problem.contains("network.allowedDomains"), "{problem}");
        assert!(problem.starts_with(&format!("{config_dir}/config.json: invalid \"sandbox\": ")));
        assert!(view.sandbox.network.default_domains);
        assert!(view.sandbox.network.allowed_domains.is_empty());
        assert_eq!(
            view.allowed_paths,
            ["/home/u/extra".to_owned(), p(&config_dir, "rel")]
        );
    }

    #[test]
    fn drops_the_removed_sandbox_enabled_switch_and_says_so_when_it_was_off() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().display().to_string();
        let file = p(&config_dir, "config.json");
        fs::write(
            &file,
            json!({ "sandbox": { "enabled": false, "network": { "allowedDomains": ["api.example.com"] } } })
                .to_string(),
        )
        .unwrap();
        let view = read_agent_config(&config_dir, "/home/u");
        assert!(view.problem.unwrap().contains("sandbox.enabled"));
        assert_eq!(view.sandbox.network.allowed_domains, ["api.example.com"]);
        fs::write(&file, json!({ "sandbox": { "enabled": true } }).to_string()).unwrap();
        assert_eq!(read_agent_config(&config_dir, "/home/u").problem, None);
        // Missing, unreadable and malformed files.
        fs::remove_file(&file).unwrap();
        let missing = read_agent_config(&config_dir, "/home/u");
        assert_eq!(missing.problem, None);
        assert_eq!(missing.sandbox, SandboxConfig::default());
        fs::write(&file, "{nope").unwrap();
        let malformed = read_agent_config(&config_dir, "/home/u");
        assert!(malformed.problem.unwrap().starts_with(&format!("{file}: ")));
        fs::write(&file, "[1]").unwrap();
        assert_eq!(read_agent_config(&config_dir, "/home/u").problem, None);
    }
}
