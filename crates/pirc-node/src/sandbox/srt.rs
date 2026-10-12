//! The external srt-compatible wrapper (`PIRC_SANDBOX_SRT`), the
//! development stand-in: `node/sandbox.ts` with an external srt, and
//! `srtSettings`. Owner: **hardening** (M7).
//!
//! Probe: `<srt> --settings <state>/sandbox/probe.json -- /bin/sh -c 'exit
//! 0'`. Prepare: `<srt> --settings <state>/sandbox/<basename(session)>.json
//! --control-fd 3 -- <agent command> <agent args...>`; the settings
//! (`srtSettings`: network allow/deny lists, local binding,
//! `allowAllUnixSockets` on Linux, filesystem rules, `allowGitConfig`,
//! `allowPty`; no seccomp entry) written 0600; a [`super::NetworkControl`]
//! that maps a pipe to the agent's fd 3 (the `command-fds` crate) and
//! writes `JSON(settings(approved)) + "\n"` on approval; `CLAUDE_CODE_TMPDIR`
//! a fresh `pirc-XXXX` under the system temp directory. Read-only (M7,
//! the Git panel): `<srt> --settings <state>/sandbox/readonly-pirc-XXXXXX.json
//! -- <command...>` with `common::readonly_session`'s policy and no
//! control fd.
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
use super::{
    BoxFuture, NetworkControl, PrepareInput, Prepared, ReadonlyInput, Sandbox, SandboxStatus,
};
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
    /// The private parent of the sessions' temporary directories.
    node_tmp: common::NodeTmp,
}

impl SrtSandbox {
    pub fn new(srt: String, config: NodeConfig, env: Env) -> Self {
        let node_tmp = common::NodeTmp::new(&env);
        Self {
            srt,
            config,
            env,
            probe: ProbeCache::default(),
            node_tmp,
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
            } = common::session(&self.config, &self.env, &self.node_tmp, &input)?;
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

    /// `<srt> --settings <state>/sandbox/readonly-<tmp name>.json --
    /// <command...>` with [`common::readonly_session`]'s policy rendered by
    /// [`srt_settings`] (so `allowAllUnixSockets` on Linux, as for agents:
    /// the node ships no seccomp helper), no control fd, and
    /// `CLAUDE_CODE_TMPDIR` the fresh temp directory (srt points `TMPDIR`
    /// there). Rust-only: TS ran panel git on the host (S8).
    fn prepare_readonly(&self, input: ReadonlyInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        Box::pin(async move {
            if let SandboxStatus::Unavailable { reason } = self.check().await {
                return Err(super::unavailable_error(&reason));
            }
            let Session {
                tmp,
                policy,
                warnings,
            } = common::readonly_session(&self.config, &self.env, &self.node_tmp, &input)?;
            let mut file_name = OsString::from("readonly-");
            file_name.push(tmp.file_name().unwrap_or_default());
            file_name.push(".json");
            let settings_file = match common::sandbox_state_dir(&self.config).and_then(|dir| {
                let file = dir.join(&file_name);
                let settings = srt_settings(&policy, &[], Platform::current()).to_string();
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
                "--".into(),
            ];
            args.extend(input.command);
            let env = vec![("CLAUDE_CODE_TMPDIR".to_owned(), tmp.display().to_string())];
            Ok(Prepared::new(
                PathBuf::from(&self.srt),
                args,
                env,
                policy,
                warnings,
                None,
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

    /// The conformance harness's fake srt (`pirc-conformance`'s
    /// `cluster.rs`), verbatim: it must accept what `prepare_readonly`
    /// passes.
    const FAKE_SRT: &str = r#"#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --settings|--control-fd) shift 2 ;;
    *) shift ;;
  esac
done
if [ -e /dev/fd/3 ]; then
  cat <&3 >> "$(dirname "$0")/fake-srt-control.log" &
fi
exec "$@"
"#;

    fn script(path: &Path, text: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    #[tokio::test]
    async fn readonly_commands_run_under_the_readonly_policy_without_a_control_fd() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let srt = script(&root.join("fake-srt.sh"), FAKE_SRT);
        let (config, env) = common::test_support::node(&root, &[]);
        let sandbox = SrtSandbox::new(srt.clone(), config, env);
        let workspace = root.join("workspace");
        let prepared = sandbox
            .prepare_readonly(ReadonlyInput {
                workspace_root: workspace.clone(),
                command: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "read -r line < README.md; echo \"$line\"; echo \"$CLAUDE_CODE_TMPDIR\"".into(),
                ],
            })
            .await
            .unwrap();
        assert_eq!(prepared.program, PathBuf::from(&srt));
        assert!(!prepared.has_control());
        let args: Vec<String> = prepared
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "--settings");
        assert_eq!(&args[2..4], ["--", "/bin/sh"]);
        let settings_file = PathBuf::from(&args[1]);
        assert!(settings_file.starts_with(root.join("state/sandbox")));
        let name = settings_file
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            name.starts_with("readonly-pirc-") && name.ends_with(".json"),
            "{name}"
        );
        let tmp = PathBuf::from(&prepared.env[0].1);
        assert_eq!(prepared.env[0].0, "CLAUDE_CODE_TMPDIR");
        assert!(tmp.is_dir());
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_file).unwrap()).unwrap();
        assert_eq!(
            settings["filesystem"]["allowWrite"],
            json!([tmp.display().to_string()])
        );
        assert_eq!(settings["filesystem"]["denyWrite"], json!([]));
        assert_eq!(settings["network"]["allowedDomains"], json!([]));
        assert_eq!(settings["network"]["allowLocalBinding"], json!(false));
        assert!(
            settings["filesystem"]["allowRead"]
                .as_array()
                .unwrap()
                .contains(&json!(workspace.display().to_string()))
        );

        // The caller sets cwd and environment; the fake srt runs it.
        let mut command = prepared.command().unwrap();
        command
            .current_dir(&workspace)
            .env_clear()
            .envs(prepared.env.iter().cloned())
            .stdin(std::process::Stdio::null());
        let output = command.output().await.unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("hi\n{}\n", tmp.display())
        );
        assert!(!root.join(FAKE_SRT_LOG).exists(), "no control fd");

        prepared.cleanup();
        assert!(!tmp.exists() && !settings_file.exists());
    }

    const FAKE_SRT_LOG: &str = "fake-srt-control.log";

    #[tokio::test]
    async fn readonly_commands_need_a_working_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let srt = script(
            &root.join("broken-srt.sh"),
            "#!/bin/sh\necho 'no namespaces' >&2\nexit 1\n",
        );
        let (config, env) = common::test_support::node(&root, &[]);
        let sandbox = SrtSandbox::new(srt, config, env);
        let error = sandbox
            .prepare_readonly(ReadonlyInput {
                workspace_root: root.join("workspace"),
                command: vec!["git".into()],
            })
            .await
            .err()
            .unwrap();
        assert_eq!(
            (error.status, error.code.as_ref()),
            (503, "runner_unavailable")
        );
        assert!(
            error.message.ends_with("(exit 1): no namespaces"),
            "{}",
            error.message
        );
        // Nothing was left behind.
        assert_eq!(std::fs::read_dir(root.join("tmp")).unwrap().count(), 0);
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
