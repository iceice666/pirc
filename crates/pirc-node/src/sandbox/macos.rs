//! The native macOS backend: `sandbox-exec -p <profile> <agent...>` with
//! srt's Seatbelt profile built from the session policy ([`profile`]), and
//! the shared filtering proxy ([`super::proxy`]) on a loopback TCP port,
//! the only outbound address the profile allows besides the policy's Unix
//! sockets (the inference socket). An approval widens the proxy's
//! allowlist in place. Owner: **macos** (M7).
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/macos-sandbox-utils.js`
//! (`wrapCommandWithSandboxMacOS`; Apache-2.0, see `crates/pirc-node/NOTICE`).
//! Profile generation is plain text and compiles everywhere, so its golden
//! tests run on Linux CI too; only [`super::create`] picks this backend,
//! on macOS.
//!
//! What differs from srt:
//!
//! - The agent is spawned as `sandbox-exec -p <profile> <program> <args>`
//!   with the environment set on the process; srt ran
//!   `env <vars> /usr/bin/sandbox-exec -p <profile> bash -c <quoted command>`.
//! - [`extra_denies`]: every deny (and srt's protected names in the
//!   workspace) also under its symlink-resolved spelling, and a deny
//!   spelled with glob characters also as the literal path. srt keeps a
//!   symlinked spelling when it leaves the path's tree, but Seatbelt
//!   matches the path the kernel resolved, so `<ws>/.git/config` with `.git`
//!   linking to the repository elsewhere stayed writable; and it reads
//!   `[`, `*`, `?` in a pirc path (a workspace named `notes [draft]`) as a
//!   pattern that no longer matches the path. Both only add denies. For
//!   the same reason an allow spelled with glob characters that names an
//!   existing path is that path (`literal_existing_allows`), so such a
//!   workspace stays readable and writable.
//! - No log monitor (srt's `log stream` of violations) and no JVM proxy
//!   agent jar (`-Djava.net.preferIPv4Stack=true` is still set).
//! - The log tag's command is the agent's arguments joined by spaces
//!   (srt shell-quoted them); it only labels violations in the system log.

pub mod paths;
pub mod profile;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pirc_config::{Env, NodeConfig};
use pirc_policy::session::SessionPolicy;

use self::paths::{Context, contains_glob_chars, normalize_path_for_sandbox, resolve_existing};
use self::profile::ProfileInput;
use super::common::{self, ProbeCache, Session};
use super::proxy;
use super::{
    BoxFuture, NetworkControl, PrepareInput, Prepared, ReadonlyInput, Sandbox, SandboxStatus,
};
use crate::error::{ApiError, ApiResult};
use proxy::{Allowlist, EnvPlatform, ProxyAuth, ProxyListener};

/// srt runs this one, not whatever `sandbox-exec` is on `PATH`.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// What a profile is built from besides the policy.
struct Settings<'a> {
    cwd: &'a str,
    home: &'a str,
    proxy_port: Option<u16>,
    allow_pty: bool,
    log_tag: &'a str,
}

/// Not srt's (see the module documentation): the literal read and write
/// denies [`profile::generate`] adds, so that a deny holds whatever
/// spelling reaches the kernel. For each entry of `deny_read` and
/// `deny_write`, and for srt's protected names in `cwd`: its spelling with
/// every symlink resolved (as far as it exists) when that differs from
/// the one srt uses, and an entry with glob characters as the literal path.
pub fn extra_denies(
    deny_read: &[String],
    deny_write: &[String],
    allow_git_config: bool,
    cwd: &str,
    home: &str,
) -> (Vec<String>, Vec<String>) {
    let ctx = Context { cwd, home };
    let extras = |entries: &mut dyn Iterator<Item = String>| {
        let mut out: Vec<String> = Vec::new();
        let mut push = |path: String| {
            if !out.contains(&path) {
                out.push(path);
            }
        };
        for entry in entries {
            let entry = paths::remove_trailing_glob_suffix(&entry);
            let literal = normalize_path_for_sandbox(&entry, true, ctx);
            if contains_glob_chars(&entry) {
                push(literal.clone());
            }
            if let Some(resolved) = resolve_existing(&literal)
                && resolved != literal
            {
                push(resolved);
            }
        }
        out
    };
    let cwd_real = normalize_path_for_sandbox(cwd, true, ctx);
    let read = extras(&mut deny_read.iter().cloned());
    let write = extras(
        &mut deny_write.iter().cloned().chain(
            profile::mandatory_names(allow_git_config)
                .into_iter()
                .map(|name| paths::resolve(&cwd_real, name)),
        ),
    );
    (read, write)
}

/// The profile for `policy` (as `srtSettings` passes it on macOS).
fn policy_profile(policy: &SessionPolicy, settings: &Settings<'_>) -> Result<String, String> {
    let paths = &policy.paths;
    let (extra_read, extra_write) = extra_denies(
        &paths.deny_read,
        &paths.deny_write,
        policy.allow_git_config,
        settings.cwd,
        settings.home,
    );
    profile::generate(&ProfileInput {
        deny_read: &paths.deny_read,
        allow_read: &paths.allow_read,
        allow_write: &paths.allow_write,
        deny_write: &paths.deny_write,
        allow_git_config: policy.allow_git_config,
        allow_unix_sockets: &policy.network.allow_unix_sockets,
        allow_local_binding: policy.network.allow_local_binding,
        proxy_port: settings.proxy_port,
        allow_pty: settings.allow_pty,
        cwd: settings.cwd,
        home: settings.home,
        log_tag: settings.log_tag,
        extra_read_denies: &extra_read,
        extra_write_denies: &extra_write,
        literal_existing_allows: true,
    })
}

/// srt's environment for the sandboxed command (`generateProxyEnvVars`
/// and `JAVA_TOOL_OPTIONS`), after `CLAUDE_CODE_TMPDIR`.
fn sandbox_env(
    tmp: &str,
    proxy: Option<(u16, &ProxyAuth)>,
    allow_local_binding: bool,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("CLAUDE_CODE_TMPDIR".to_owned(), tmp.to_owned()),
        ("SANDBOX_RUNTIME".to_owned(), "1".to_owned()),
        ("TMPDIR".to_owned(), tmp.to_owned()),
    ];
    if let Some((port, auth)) = proxy {
        env.extend(proxy::env_vars(EnvPlatform::MacOs, port, port, auth));
    }
    // Seatbelt's `localhost` filters miss IPv4-mapped IPv6, which JVMs use.
    if proxy.is_some() || allow_local_binding {
        env.push((
            "JAVA_TOOL_OPTIONS".to_owned(),
            "-Djava.net.preferIPv4Stack=true".to_owned(),
        ));
    }
    // Not srt's: says which kind of sandbox this is.
    env.push(("PIRC_SANDBOX_BACKEND".to_owned(), "native".to_owned()));
    env
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

/// `-p <profile>` and the command.
fn exec_args(profile: String, command: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-p".into(), profile.into()];
    args.extend(command);
    args
}

/// The Seatbelt backend.
pub struct MacSandbox {
    config: NodeConfig,
    env: Env,
    probe: ProbeCache,
    /// The private parent of the sessions' temporary directories.
    node_tmp: common::NodeTmp,
    /// srt's `sessionSuffix`: one per node, as one per srt process.
    session_suffix: String,
    /// Connections every session's proxy may still open together.
    connections: Arc<tokio::sync::Semaphore>,
}

impl MacSandbox {
    pub fn new(config: NodeConfig, env: Env) -> Self {
        let node_tmp = common::NodeTmp::new(&env);
        Self {
            config,
            env,
            probe: ProbeCache::default(),
            node_tmp,
            session_suffix: profile::session_suffix(),
            connections: Arc::new(tokio::sync::Semaphore::new(proxy::MAX_NODE_CONNECTIONS)),
        }
    }

    fn home(&self) -> String {
        text(&self.env.home())
    }

    fn log_tag(&self, command: &[OsString]) -> String {
        let command: Vec<String> = command
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        profile::log_tag(&command.join(" "), &self.session_suffix)
    }

    /// `/bin/sh -c 'exit 0'` under the profile of an empty policy (srt's
    /// probe settings), in a temporary directory of its own.
    async fn probe(&self) -> SandboxStatus {
        if !Path::new(SANDBOX_EXEC).is_file() {
            return SandboxStatus::Unavailable {
                reason: format!("sandbox-exec ({SANDBOX_EXEC}) was not found"),
            };
        }
        let tmp = match common::make_temp_dir(&common::tmpdir(&self.env), "pirc-") {
            Ok(tmp) => tmp,
            Err(error) => {
                return SandboxStatus::Unavailable {
                    reason: format!("sandbox-exec: {error}"),
                };
            }
        };
        let command: Vec<OsString> = vec!["/bin/sh".into(), "-c".into(), "exit 0".into()];
        let tmp_text = text(&tmp);
        let home = self.home();
        let tag = self.log_tag(&command);
        // A port nothing listens on: the probe makes no connection.
        let profile = policy_profile(
            &SessionPolicy::default(),
            &Settings {
                cwd: &tmp_text,
                home: &home,
                proxy_port: Some(9),
                allow_pty: false,
                log_tag: &tag,
            },
        );
        let status = match profile {
            Err(error) => SandboxStatus::Unavailable {
                reason: format!("sandbox-exec: {error}"),
            },
            Ok(profile) => {
                let mut probe = tokio::process::Command::new(SANDBOX_EXEC);
                probe
                    .args(exec_args(profile, command))
                    .env_clear()
                    .envs(sandbox_env(&tmp_text, None, false))
                    .current_dir(&tmp);
                common::run_probe(
                    "sandbox-exec",
                    probe,
                    format!("sandbox-exec: {SANDBOX_EXEC}"),
                )
                .await
            }
        };
        Session::remove_tmp(&tmp);
        status
    }

    /// The probe's verdict, or 503 (removing `tmp`).
    async fn require(&self, tmp: &Path) -> ApiResult<()> {
        match self.check().await {
            SandboxStatus::Unavailable { reason } => {
                Session::remove_tmp(tmp);
                Err(super::unavailable_error(&reason))
            }
            SandboxStatus::Active { .. } => Ok(()),
        }
    }
}

/// Logged, then 500, as the other backends' internal failures.
fn internal(what: &str, error: impl std::fmt::Display) -> ApiError {
    crate::log::error(&format!("{what}: {error}"));
    ApiError::internal()
}

impl Sandbox for MacSandbox {
    fn check(&self) -> BoxFuture<'_, SandboxStatus> {
        Box::pin(self.probe.get(|| self.probe()))
    }

    fn prepare(&self, input: PrepareInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        Box::pin(async move {
            let Session {
                tmp,
                policy,
                warnings,
            } = common::spawn_session(&self.config, &self.env, &self.node_tmp, &input).await?;
            self.require(&tmp).await?;
            let (listener, port) = match ProxyListener::loopback().await {
                Ok(bound) => bound,
                Err(error) => {
                    Session::remove_tmp(&tmp);
                    return Err(internal("cannot start the sandbox proxy", error));
                }
            };
            let mut agent: Vec<OsString> = vec![self.config.agent_command.clone().into()];
            agent.extend(self.config.agent_args.iter().map(OsString::from));
            let (tmp_text, home) = (text(&tmp), self.home());
            let tag = self.log_tag(&agent);
            let profile = match policy_profile(
                &policy,
                &Settings {
                    cwd: &text(&input.workspace_root),
                    home: &home,
                    proxy_port: Some(port),
                    allow_pty: true,
                    log_tag: &tag,
                },
            ) {
                Ok(profile) => profile,
                Err(error) => {
                    Session::remove_tmp(&tmp);
                    return Err(internal(
                        "cannot build the session's Seatbelt profile",
                        error,
                    ));
                }
            };
            let allowlist = Arc::new(Allowlist::new(
                policy.network.allowed_domains.clone(),
                policy.network.denied_domains.clone(),
            ));
            let auth = Arc::new(ProxyAuth::generate());
            let env = sandbox_env(
                &tmp_text,
                Some((port, &auth)),
                policy.network.allow_local_binding,
            );
            let proxy = tokio::spawn(proxy::serve(
                listener,
                allowlist.clone(),
                auth,
                self.connections.clone(),
            ));
            Ok(Prepared::new(
                PathBuf::from(SANDBOX_EXEC),
                exec_args(profile, agent),
                env,
                policy,
                warnings,
                Some(Box::new(MacControl { allowlist })),
                move || {
                    proxy.abort();
                    Session::remove_tmp(&tmp);
                },
            ))
        })
    }

    fn prepare_readonly(&self, input: ReadonlyInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        Box::pin(async move {
            let Session {
                tmp,
                policy,
                warnings,
            } = common::spawn_readonly_session(&self.config, &self.env, &self.node_tmp, &input)
                .await?;
            self.require(&tmp).await?;
            let (tmp_text, home) = (text(&tmp), self.home());
            let tag = self.log_tag(&input.command);
            // No proxy port: the profile allows no network at all.
            let profile = match policy_profile(
                &policy,
                &Settings {
                    cwd: &text(&input.workspace_root),
                    home: &home,
                    proxy_port: None,
                    allow_pty: false,
                    log_tag: &tag,
                },
            ) {
                Ok(profile) => profile,
                Err(error) => {
                    Session::remove_tmp(&tmp);
                    return Err(internal(
                        "cannot build the read-only Seatbelt profile",
                        error,
                    ));
                }
            };
            let env = sandbox_env(&tmp_text, None, false);
            Ok(Prepared::new(
                PathBuf::from(SANDBOX_EXEC),
                exec_args(profile, input.command),
                env,
                policy,
                warnings,
                None,
                move || Session::remove_tmp(&tmp),
            ))
        })
    }
}

/// Approvals widen the proxy's allowlist directly.
struct MacControl {
    allowlist: Arc<Allowlist>,
}

impl NetworkControl for MacControl {
    fn prepare_command(&self, command: &mut tokio::process::Command) -> std::io::Result<()> {
        let _ = command;
        Ok(())
    }

    fn is_open(&self) -> bool {
        true
    }

    fn approve(&self, approved: &[String]) -> Result<(), String> {
        self.allowlist.set_approved(approved);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn extra_denies_name_what_the_kernel_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("repo/hooks")).unwrap();
        fs::create_dir_all(p("ws")).unwrap();
        fs::create_dir_all(p("dot")).unwrap();
        fs::write(p("repo/config"), "").unwrap();
        std::os::unix::fs::symlink(p("repo"), p("ws/.git")).unwrap();
        std::os::unix::fs::symlink(p("dot/bashrc"), p("ws/.bashrc")).unwrap();
        fs::create_dir_all(p("w[1]")).unwrap();
        let (read, write) = extra_denies(
            &[p("ws/.git/config")],
            &[
                p("ws/.git/config"),
                p("ws/.git/hooks"),
                p("w[1]/.pirc"),
                p("ws/x"),
            ],
            false,
            &p("ws"),
            &p("home"),
        );
        assert_eq!(read, [p("repo/config")]);
        assert_eq!(
            write,
            [
                p("repo/config"),
                p("repo/hooks"),
                p("w[1]/.pirc"),
                // srt's protected names in the cwd: a dangling link's target too.
                p("dot/bashrc"),
            ]
        );
        let (read, write) = extra_denies(&[], &[], true, &p("dot"), &p("home"));
        assert!(read.is_empty() && write.is_empty(), "{write:?}");
    }

    /// What the backend sets, against the environment srt set in the
    /// recorded cases (`tests/fixtures/sbpl/<case>.env`): every variable
    /// we set is srt's, in srt's order, with the same value once the proxy
    /// URLs' credentials are left out (they differ by design). Variables
    /// only srt has are the proxy's (`proxy::env_vars`, M7 network).
    #[test]
    fn the_environment_matches_srts_recordings() {
        let strip = |value: &str| match (value.find("://"), value.find('@')) {
            (Some(scheme), Some(at)) if at > scheme => {
                format!("{}{}", &value[..scheme + 3], &value[at + 1..])
            }
            _ => value.to_owned(),
        };
        let tmp = "/t/pirc-x";
        let auth = ProxyAuth::generate();
        for (case, proxy, local_binding) in [
            ("session", true, false),
            ("local-binding", true, true),
            ("readonly", false, false),
        ] {
            let file = format!(
                "{}/tests/fixtures/sbpl/{case}.env",
                env!("CARGO_MANIFEST_DIR")
            );
            let srt: Vec<(String, String)> = fs::read_to_string(file)
                .unwrap()
                .lines()
                .map(|line| {
                    let line = line
                        .replace("{ROOT}/tmp/pirc-Ab12Cd", tmp)
                        .replace("{PORT}", "40000");
                    let (name, value) = line.split_once('=').unwrap();
                    (name.to_owned(), strip(value))
                })
                .filter(|(name, _)| !name.starts_with("CLOUDSDK_PROXY_USERNAME"))
                .filter(|(name, _)| !name.starts_with("CLOUDSDK_PROXY_PASSWORD"))
                .collect();
            let ours: Vec<(String, String)> =
                sandbox_env(tmp, proxy.then_some((40000, &auth)), local_binding)
                    .into_iter()
                    .filter(|(name, _)| {
                        name != "CLAUDE_CODE_TMPDIR"
                            && name != "PIRC_SANDBOX_BACKEND"
                            && !name.starts_with("CLOUDSDK_PROXY_USERNAME")
                            && !name.starts_with("CLOUDSDK_PROXY_PASSWORD")
                    })
                    .map(|(name, value)| (name, strip(&value)))
                    .collect();
            let shared: Vec<(String, String)> = srt
                .iter()
                .filter(|(name, _)| ours.iter().any(|(other, _)| other == name))
                .cloned()
                .collect();
            assert_eq!(ours, shared, "{case}");
            for name in ["SANDBOX_RUNTIME", "TMPDIR", "JAVA_TOOL_OPTIONS"] {
                assert_eq!(
                    ours.iter().any(|(other, _)| other == name),
                    srt.iter().any(|(other, _)| other == name),
                    "{case}: {name}"
                );
            }
        }
    }

    #[test]
    fn the_environment_follows_srt() {
        let auth = ProxyAuth::generate();
        let env = sandbox_env("/t/pirc-x", Some((4242, &auth)), false);
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(env[0], ("CLAUDE_CODE_TMPDIR".into(), "/t/pirc-x".into()));
        assert_eq!(get("TMPDIR"), Some("/t/pirc-x"));
        assert_eq!(get("SANDBOX_RUNTIME"), Some("1"));
        assert_eq!(
            get("JAVA_TOOL_OPTIONS"),
            Some("-Djava.net.preferIPv4Stack=true")
        );
        assert!(get("HTTPS_PROXY").is_some_and(|url| url.ends_with("localhost:4242")));
        let none = sandbox_env("/t/pirc-x", None, false);
        assert!(
            none.iter()
                .all(|(key, _)| key != "JAVA_TOOL_OPTIONS" && key != "HTTP_PROXY")
        );
        let local = sandbox_env("/t/pirc-x", None, true);
        assert!(local.iter().any(|(key, _)| key == "JAVA_TOOL_OPTIONS"));
    }
}
