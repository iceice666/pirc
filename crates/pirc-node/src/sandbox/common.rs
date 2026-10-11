//! What the srt and native backends share (`node/sandbox.ts`): the cached
//! probe, a session's policy with its warnings, and its temporary
//! directory. Owner: **sandbox**.

use std::future::Future;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pirc_config::{Env, NodeConfig};
use pirc_policy::session::{
    Platform, SessionPolicy, SessionPolicyInput, read_agent_config, session_policy,
};
use pirc_policy::{is_inside, real_resolve};
use tokio::io::AsyncReadExt;

use super::{PrepareInput, SandboxStatus};
use crate::error::{ApiError, ApiResult};

/// How long a probe may take before it counts as failed.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a failed probe stands before the next agent start probes again
/// (`PROBE_RETRY_MS`).
pub const PROBE_RETRY: Duration = Duration::from_secs(30);

/// `NodeSandbox.check`'s cache: a success holds for the node's life, a
/// failure for [`PROBE_RETRY`]. Concurrent checks share one probe (TS
/// shared the promise).
#[derive(Default)]
pub struct ProbeCache {
    state: tokio::sync::Mutex<Option<(SandboxStatus, Option<Instant>)>>,
}

impl ProbeCache {
    pub async fn get<F, Fut>(&self, probe: F) -> SandboxStatus
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = SandboxStatus>,
    {
        let mut state = self.state.lock().await;
        if let Some((status, failed_at)) = &*state
            && failed_at.is_none_or(|at| at.elapsed() <= PROBE_RETRY)
        {
            return status.clone();
        }
        let status = probe().await;
        let failed_at = matches!(status, SandboxStatus::Unavailable { .. }).then(Instant::now);
        *state = Some((status.clone(), failed_at));
        status
    }
}

/// Run a probe command (`<name>` in the reasons) and judge it as TS's
/// `probe` did: exit 0 within [`PROBE_TIMEOUT`] is a working sandbox;
/// otherwise the last three lines of its output say why.
///
/// Reasons keep TS's words; a spawn failure carries Rust's error text.
pub async fn run_probe(
    name: &str,
    mut command: tokio::process::Command,
    description: String,
) -> SandboxStatus {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return SandboxStatus::Unavailable {
                reason: format!("{name}: {error}"),
            };
        }
    };
    // Both streams into one buffer, the last 2,000 characters kept.
    let output = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    let streams: [Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>; 2] = [
        child.stdout.take().map(|s| Box::new(s) as _),
        child.stderr.take().map(|s| Box::new(s) as _),
    ];
    for mut stream in streams.into_iter().flatten() {
        let output = output.clone();
        readers.push(tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let mut text = output.lock().unwrap_or_else(|p| p.into_inner());
                text.push_str(&String::from_utf8_lossy(&buffer[..read]));
                let count = text.chars().count();
                if count > 2000 {
                    let cut = text
                        .char_indices()
                        .nth(count - 2000)
                        .map_or(0, |(at, _)| at);
                    text.drain(..cut);
                }
            }
        }));
    }
    let status = match tokio::time::timeout(PROBE_TIMEOUT, child.wait()).await {
        Err(_) => {
            let _ = child.start_kill();
            for reader in readers {
                reader.abort();
            }
            return SandboxStatus::Unavailable {
                reason: format!("{name} did not answer within 30 seconds"),
            };
        }
        Ok(Err(error)) => {
            return SandboxStatus::Unavailable {
                reason: format!("{name}: {error}"),
            };
        }
        Ok(Ok(status)) => status,
    };
    // TS judged on `exit` with what had arrived; give the pipes a moment
    // to drain, without waiting on a grandchild that keeps them open.
    for reader in readers {
        let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
    }
    if status.success() {
        return SandboxStatus::Active { description };
    }
    let text = output.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let lines: Vec<&str> = text.trim().split('\n').collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    let code = status
        .code()
        .map_or_else(|| "null".to_owned(), |code| code.to_string());
    SandboxStatus::Unavailable {
        reason: format!(
            "{name} cannot sandbox on this host (exit {code}): {}",
            if tail.is_empty() { "no output" } else { &tail }
        ),
    }
}

/// `os.tmpdir()`: `$TMPDIR`, `$TMP`, `$TEMP` or `/tmp`, without a trailing
/// slash.
pub fn tmpdir(env: &Env) -> PathBuf {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|name| env.get(name).filter(|value| !value.is_empty()))
        .unwrap_or("/tmp");
    let trimmed = if dir.len() > 1 {
        dir.trim_end_matches('/')
    } else {
        dir
    };
    PathBuf::from(if trimmed.is_empty() { "/" } else { trimmed })
}

/// `mkdtempSync(<base>/<prefix>)`: a new 0700 directory with six random
/// characters after `prefix`.
pub fn make_temp_dir(base: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    loop {
        let random = crate::util::random_bytes::<6>();
        let suffix: String = random
            .iter()
            .map(|byte| CHARS[usize::from(*byte) % CHARS.len()] as char)
            .collect();
        let dir = base.join(format!("{prefix}{suffix}"));
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

/// `<state>/sandbox`, made 0700 when missing.
pub fn sandbox_state_dir(config: &NodeConfig) -> std::io::Result<PathBuf> {
    let dir = config.state_dir.join("sandbox");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    Ok(dir)
}

/// `sandboxBinDir`: where TS's built-in srt kept its seccomp helper. The
/// Rust node has none, but the directory stays in the policy as a
/// read-only directory, so the policy (and the srt settings the
/// conformance scenarios record) keeps TS's shape.
pub fn sandbox_bin_dir(config: &NodeConfig) -> PathBuf {
    config.state_dir.join("sandbox").join("bin")
}

/// A session's policy and what goes with it, before the backend wraps it.
pub struct Session {
    /// The session's own temporary directory (`CLAUDE_CODE_TMPDIR`).
    pub tmp: PathBuf,
    pub policy: SessionPolicy,
    pub warnings: Vec<String>,
}

impl Session {
    /// Remove the temporary directory (a failed start, or the cleanup).
    pub fn remove_tmp(tmp: &Path) {
        let _ = std::fs::remove_dir_all(tmp);
    }
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

/// The first half of `NodeSandbox.prepare`: read the agent config, make
/// the session's temporary directory, build the policy and the warnings.
pub fn session(config: &NodeConfig, env: &Env, input: &PrepareInput) -> ApiResult<Session> {
    let home = text(&env.home());
    let agent_config = read_agent_config(&text(&config.config_dir), &home);
    // The session's own temporary directory: TMPDIR inside the sandbox,
    // and the only temp dir it may write besides /tmp. Kept short: srt may
    // put Unix sockets there, and macOS caps their paths at 104 bytes.
    let tmp = make_temp_dir(&tmpdir(env), "pirc-").map_err(|error| {
        crate::log::error(&format!(
            "cannot make the session's temp directory: {error}"
        ));
        ApiError::internal()
    })?;
    let mut warnings = Vec::new();
    if let Some(problem) = &agent_config.problem {
        warnings.push(format!("Sandbox settings ignored: {problem}"));
    }
    let database_dir = config
        .database_path
        .parent()
        .map_or_else(|| PathBuf::from("/"), Path::to_path_buf);
    let private_dirs: Vec<String> = [
        config.state_dir.clone(),
        config.sessions_dir.clone(),
        config.uploads_dir.clone(),
        database_dir,
        config.browser.profiles_dir.clone(),
    ]
    .into_iter()
    // systemd credentials (the NixOS module hands the node its token there).
    .chain(
        env.get("CREDENTIALS_DIRECTORY")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from),
    )
    .map(|dir| real_resolve(&text(&dir)))
    .collect();
    let policy_input = SessionPolicyInput {
        config: agent_config.sandbox,
        config_dir: agent_config.config_dir,
        home,
        private_dirs: private_dirs.clone(),
        workspace_root: text(&input.workspace_root),
        allowed_paths: agent_config.allowed_paths,
        session_dir: text(&input.session_dir),
        workspace_memory_dir: text(&config.workspace_memory_dir),
        inference_socket: input.inference_socket.as_deref().map(text),
        tmp_dirs: vec![text(&tmp), "/tmp".to_owned()],
        protected_paths: input.protected_paths.iter().map(|p| text(p)).collect(),
        read_only_dirs: vec![text(&sandbox_bin_dir(config))],
        platform: Platform::current(),
        uid: nix::unistd::getuid().as_raw(),
        ssh_auth_sock: env.get("SSH_AUTH_SOCK").map(str::to_owned),
    };
    let policy = match session_policy(&policy_input) {
        Ok(policy) => policy,
        Err(error) => {
            // TS threw here (and left the temp directory behind).
            Session::remove_tmp(&tmp);
            crate::log::error(&format!(
                "cannot build the session's sandbox policy: {error}"
            ));
            return Err(ApiError::internal());
        }
    };
    let exposed: Vec<&str> = policy
        .paths
        .allow_write
        .iter()
        .filter(|root| {
            let root = real_resolve(root);
            private_dirs
                .iter()
                .any(|dir| is_inside(dir, &root) && *dir != root)
        })
        .map(String::as_str)
        .collect();
    if !exposed.is_empty() {
        warnings.push(format!(
            "pirc's state lies inside a writable path of this session ({}). What exists now is protected, but anything the node creates there later (other sessions) is not: move PIRC_STATE_DIR out of it.",
            exposed.join(", ")
        ));
    }
    Ok(Session {
        tmp,
        policy,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmpdir_follows_node() {
        let env = |vars: &[(&str, &str)]| Env::new(vars.iter().copied(), "/");
        assert_eq!(tmpdir(&env(&[])), PathBuf::from("/tmp"));
        assert_eq!(tmpdir(&env(&[("TMPDIR", "/x/")])), PathBuf::from("/x"));
        assert_eq!(
            tmpdir(&env(&[("TMP", "/y"), ("TEMP", "/z")])),
            PathBuf::from("/y")
        );
        assert_eq!(tmpdir(&env(&[("TMPDIR", "/")])), PathBuf::from("/"));
    }

    #[test]
    fn temp_dirs_are_private_and_distinct() {
        use std::os::unix::fs::PermissionsExt;
        let base = tempfile::tempdir().unwrap();
        let a = make_temp_dir(base.path(), "pirc-").unwrap();
        let b = make_temp_dir(base.path(), "pirc-").unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("pirc-") && name.len() == 11, "{name}");
        let mode = std::fs::metadata(&a).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[tokio::test]
    async fn probes_are_cached_and_failures_retried_after_30_seconds() {
        let cache = ProbeCache::default();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let failing = || async {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxStatus::Unavailable {
                reason: "no".into(),
            }
        };
        cache.get(failing).await;
        cache.get(failing).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        // `Instant` is the std one: the paused tokio clock does not move
        // it, so the retry is checked through the cache's own state.
        *cache.state.lock().await = Some((
            SandboxStatus::Unavailable {
                reason: "no".into(),
            },
            Instant::now().checked_sub(PROBE_RETRY + Duration::from_millis(1)),
        ));
        let ok = || async {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxStatus::Active {
                description: "yes".into(),
            }
        };
        assert!(matches!(cache.get(ok).await, SandboxStatus::Active { .. }));
        assert!(matches!(
            cache.get(failing).await,
            SandboxStatus::Active { .. }
        ));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn probe_reasons_read_as_in_typescript() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args([
            "-c",
            "echo one; echo two >&2; echo three; echo four; exit 3",
        ]);
        let status = run_probe("srt", command, "x".into()).await;
        let SandboxStatus::Unavailable { reason } = status else {
            panic!("{status:?}");
        };
        // The streams interleave; the last three lines are joined.
        assert!(
            reason.starts_with("srt cannot sandbox on this host (exit 3): "),
            "{reason}"
        );
        assert_eq!(reason.matches(' ').count(), 10, "{reason}");
        let mut quiet = tokio::process::Command::new("/bin/sh");
        quiet.args(["-c", "exit 1"]);
        assert_eq!(
            run_probe("srt", quiet, "x".into()).await,
            SandboxStatus::Unavailable {
                reason: "srt cannot sandbox on this host (exit 1): no output".into()
            }
        );
        let mut ok = tokio::process::Command::new("/bin/sh");
        ok.args(["-c", "exit 0"]);
        assert_eq!(
            run_probe("srt", ok, "ready".into()).await,
            SandboxStatus::Active {
                description: "ready".into()
            }
        );
        let missing = tokio::process::Command::new("/nonexistent/srt");
        let SandboxStatus::Unavailable { reason } = run_probe("srt", missing, "x".into()).await
        else {
            panic!()
        };
        assert!(reason.starts_with("srt: "), "{reason}");
    }
}
