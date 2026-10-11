//! The external srt-compatible wrapper (`PIRC_SANDBOX_SRT`), the
//! development stand-in: `node/sandbox.ts` with an external srt, and
//! `srtSettings`. Owner: **sandbox**.
//!
//! Probe: `<srt> --settings <state>/sandbox/probe.json -- /bin/sh -c 'exit
//! 0'`. Prepare: `<srt> --settings <state>/sandbox/<basename(session)>.json
//! --control-fd 3 -- <agent command> <agent args...>`; the settings
//! (`srtSettings`: network allow/deny lists, local binding,
//! `allowAllUnixSockets` on Linux, filesystem rules, `allowGitConfig`,
//! `allowPty`; no seccomp entry) written 0600; a [`super::NetworkControl`]
//! that maps a pipe to the agent's fd 3 (the `command-fds` crate) and
//! writes `JSON(settings(approved)) + "\n"` on approval; `CLAUDE_CODE_TMPDIR`
//! a fresh `pirc-XXXX` under the system temp directory.
//!
//! TS also ran a built-in srt (`pirc-node srt`, with its seccomp helper);
//! the Rust node has none, so the settings never carry `seccomp`.

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};

use command_fds::{CommandFdExt, FdMapping};
use pirc_config::{Env, NodeConfig};
use pirc_policy::session::{Platform, SessionPolicy};
use serde_json::{Value, json};

use super::common::{self, ProbeCache, Session};
use super::{BoxFuture, NetworkControl, PrepareInput, Prepared, Sandbox, SandboxStatus};
use crate::error::{ApiError, ApiResult};

/// srt's settings (`--settings` and each control-fd line) for a session
/// policy, with the domains approved since (`srtSettings`).
pub fn srt_settings(policy: &SessionPolicy, extra_domains: &[String], platform: Platform) -> Value {
    let mut allowed: Vec<&String> = Vec::new();
    for domain in policy.network.allowed_domains.iter().chain(extra_domains) {
        if !allowed.contains(&domain) {
            allowed.push(domain);
        }
    }
    let mut network = json!({
        "allowedDomains": allowed,
        "deniedDomains": policy.network.denied_domains,
        "allowLocalBinding": policy.network.allow_local_binding,
    });
    // Linux filters Unix sockets with seccomp, which cannot tell paths
    // apart, and the agent must reach the node's inference socket. The read
    // rules still hide sockets in denied directories.
    if platform == Platform::Linux {
        network["allowAllUnixSockets"] = json!(true);
    } else {
        network["allowUnixSockets"] = json!(policy.network.allow_unix_sockets);
    }
    json!({
        "network": network,
        "filesystem": {
            "denyRead": policy.paths.deny_read,
            "allowRead": policy.paths.allow_read,
            "allowWrite": policy.paths.allow_write,
            "denyWrite": policy.paths.deny_write,
            "allowGitConfig": policy.allow_git_config,
        },
        // background_task tty:true and PTY-driven tools.
        "allowPty": true,
    })
}

/// The probe's settings: nothing allowed, nothing denied.
const PROBE_SETTINGS: &str = r#"{"network":{"allowedDomains":[],"deniedDomains":[]},"filesystem":{"denyRead":[],"allowWrite":[],"denyWrite":[]}}"#;

/// Write `contents` to `path`, created 0600 (TS: `writeFileSync` with
/// `mode`, then `chmod` for an existing file).
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
}

/// `NodeSandbox` with an external srt.
pub struct SrtSandbox {
    srt: String,
    config: NodeConfig,
    env: Env,
    probe: ProbeCache,
}

impl SrtSandbox {
    pub fn new(srt: String, config: NodeConfig, env: Env) -> Self {
        Self {
            srt,
            config,
            env,
            probe: ProbeCache::default(),
        }
    }

    async fn probe(&self) -> SandboxStatus {
        let settings = match common::sandbox_state_dir(&self.config).and_then(|dir| {
            let file = dir.join("probe.json");
            write_private(&file, PROBE_SETTINGS.as_bytes())?;
            Ok(file)
        }) {
            Ok(file) => file,
            Err(error) => {
                return SandboxStatus::Unavailable {
                    reason: format!("srt: {error}"),
                };
            }
        };
        let mut command = tokio::process::Command::new(&self.srt);
        command
            .arg("--settings")
            .arg(&settings)
            .args(["--", "/bin/sh", "-c", "exit 0"]);
        common::run_probe("srt", command, format!("srt: {}", self.srt)).await
    }
}

impl Sandbox for SrtSandbox {
    fn check(&self) -> BoxFuture<'_, SandboxStatus> {
        Box::pin(self.probe.get(|| self.probe()))
    }

    fn prepare(&self, input: PrepareInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        Box::pin(async move {
            let Session {
                tmp,
                policy,
                warnings,
            } = common::session(&self.config, &self.env, &input)?;
            if let SandboxStatus::Unavailable { reason } = self.check().await {
                Session::remove_tmp(&tmp);
                return Err(super::unavailable_error(&reason));
            }
            let platform = Platform::current();
            let name = Path::new(&input.session_id)
                .file_name()
                .map_or_else(|| input.session_id.clone().into(), |name| name.to_owned());
            let mut file_name = name;
            file_name.push(".json");
            let settings_file = match common::sandbox_state_dir(&self.config).and_then(|dir| {
                let file = dir.join(&file_name);
                let settings = srt_settings(&policy, &[], platform).to_string();
                write_private(&file, settings.as_bytes())?;
                Ok(file)
            }) {
                Ok(file) => file,
                Err(error) => {
                    Session::remove_tmp(&tmp);
                    crate::log::error(&format!("cannot write the srt settings: {error}"));
                    return Err(ApiError::internal());
                }
            };
            let mut args: Vec<OsString> = vec![
                "--settings".into(),
                settings_file.clone().into(),
                // fd 3 carries network allowlist updates (runtime approvals).
                "--control-fd".into(),
                "3".into(),
                "--".into(),
                self.config.agent_command.clone().into(),
            ];
            args.extend(self.config.agent_args.iter().map(OsString::from));
            let env = vec![("CLAUDE_CODE_TMPDIR".to_owned(), tmp.display().to_string())];
            let control = SrtControl {
                policy: policy.clone(),
                platform,
                lines: Mutex::new(None),
            };
            Ok(Prepared::new(
                PathBuf::from(&self.srt),
                args,
                env,
                policy,
                warnings,
                Some(Box::new(control)),
                move || {
                    let _ = std::fs::remove_file(&settings_file);
                    Session::remove_tmp(&tmp);
                },
            ))
        })
    }
}

/// srt's control channel: a pipe on the agent's fd 3, written by a thread
/// of its own so an approval never blocks on a full pipe (TS's stream
/// buffered the same way). Write errors are ignored, as TS's `on('error')`
/// did.
struct SrtControl {
    policy: SessionPolicy,
    platform: Platform,
    lines: Mutex<Option<mpsc::Sender<String>>>,
}

impl NetworkControl for SrtControl {
    fn prepare_command(&self, command: &mut tokio::process::Command) -> std::io::Result<()> {
        let (reader, mut writer) = std::io::pipe()?;
        command
            .fd_mappings(vec![FdMapping {
                parent_fd: reader.into(),
                child_fd: 3,
            }])
            .map_err(std::io::Error::other)?;
        let (lines, receive) = mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("srt-control".to_owned())
            .spawn(move || {
                for line in receive {
                    if writer.write_all(line.as_bytes()).is_err() {
                        break;
                    }
                }
            })?;
        *self.lines.lock().unwrap_or_else(|p| p.into_inner()) = Some(lines);
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.lines
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    fn approve(&self, approved: &[String]) -> Result<(), String> {
        let line = format!("{}\n", srt_settings(&self.policy, approved, self.platform));
        if let Some(lines) = &*self.lines.lock().unwrap_or_else(|p| p.into_inner()) {
            let _ = lines.send(line);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use pirc_policy::PathPolicy;
    use pirc_policy::session::NetworkPolicy;

    use super::*;

    fn policy() -> SessionPolicy {
        SessionPolicy {
            paths: PathPolicy {
                deny_read: vec!["/state".into()],
                allow_read: vec!["/ws".into()],
                allow_write: vec!["/ws".into()],
                deny_write: vec!["/ws/.pirc".into()],
                shared_write: Some(vec!["/tmp".into()]),
            },
            network: NetworkPolicy {
                allowed_domains: vec!["github.com".into()],
                denied_domains: vec!["evil.example".into()],
                allow_local_binding: true,
                allow_unix_sockets: vec!["/state/i-1/socket".into()],
            },
            allow_git_config: false,
        }
    }

    /// `renders srt settings for the platform` (sandbox-policy.test.ts).
    #[test]
    fn renders_srt_settings_for_the_platform() {
        let extra = ["extra.example.com".to_owned(), "github.com".to_owned()];
        let linux = srt_settings(&policy(), &extra, Platform::Linux);
        assert_eq!(
            linux.to_string(),
            r#"{"network":{"allowedDomains":["github.com","extra.example.com"],"deniedDomains":["evil.example"],"allowLocalBinding":true,"allowAllUnixSockets":true},"filesystem":{"denyRead":["/state"],"allowRead":["/ws"],"allowWrite":["/ws"],"denyWrite":["/ws/.pirc"],"allowGitConfig":false},"allowPty":true}"#
        );
        let mac = srt_settings(&policy(), &[], Platform::Macos);
        assert_eq!(
            mac["network"]["allowUnixSockets"],
            json!(["/state/i-1/socket"])
        );
        assert!(mac["network"].get("allowAllUnixSockets").is_none());
        assert!(mac.get("seccomp").is_none());
    }

    #[tokio::test]
    async fn the_control_fd_carries_whole_settings_lines() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("control.log");
        let control = SrtControl {
            policy: policy(),
            platform: Platform::Linux,
            lines: Mutex::new(None),
        };
        assert!(!control.is_open());
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("cat <&3 > {}", log.display()));
        control.prepare_command(&mut command).unwrap();
        assert!(control.is_open());
        let mut child = command.spawn().unwrap();
        drop(command);
        control.approve(&["a.example".into()]).unwrap();
        control
            .approve(&["a.example".into(), "b.example".into()])
            .unwrap();
        // Closing the channel ends the writer thread, closing the pipe.
        *control.lines.lock().unwrap() = None;
        child.wait().await.unwrap();
        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(text.ends_with('\n'));
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[1]["network"]["allowedDomains"],
            json!(["github.com", "a.example", "b.example"])
        );
    }
}
