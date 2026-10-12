//! uid 0 and `CAP_SETFCAP`: why a node running as root may be unable to
//! sandbox anything, said before bubblewrap fails on every start.
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/linux-sandbox-utils.js`
//! (`CAP_SETFCAP`, `processHasBoundingCapability`,
//! `boundingCapabilitiesFromStatus`, `capabilityArgs`,
//! `CAP_SETFCAP_MISSING_MESSAGE`, `uid0SandboxError`,
//! `probeUid0UserNamespace`) (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! pirc runs without srt's seccomp helper (`allowAllUnixSockets`), so
//! `capabilityArgs`' `--cap-add CAP_SETFCAP` branch never applies: the
//! agent always runs in bubblewrap's own namespaces with `--cap-drop ALL`,
//! which is what stops a command running as uid 0 there from unmounting a
//! denial.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::AsyncReadExt;

/// `CAP_SETFCAP`'s number.
pub const CAP_SETFCAP: u32 = 31;

/// `CAP_SETFCAP_MISSING_MESSAGE`.
pub const CAP_SETFCAP_MISSING_MESSAGE: &str = "running as uid 0 without CAP_SETFCAP in this process's capability bounding set - on kernels that enforce the CAP_SETFCAP requirement for mapping uid 0 into a user namespace (Linux 5.12 and distribution backports) every sandboxed command fails while writing a uid map (\"Operation not permitted\"). Grant CAP_SETFCAP to this process, or run as a non-root user";

/// How long the uid-0 probe may take (srt's `spawnSync` timeout).
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// `boundingCapabilitiesFromStatus`: `CapBnd` unioned with `CapInh` of a
/// `/proc/<pid>/status`, the set an execve gives a euid-0 caller's child
/// (`CapPrm`/`CapEff` do not decide what bubblewrap holds). `None` when
/// either line is missing.
pub fn bounding_capabilities_from_status(status: &str) -> Option<u64> {
    let field = |name: &str| {
        status.lines().find_map(|line| {
            let value = line.strip_prefix(name)?.strip_prefix(':')?.trim();
            (!value.is_empty() && value.chars().all(|c| c.is_ascii_hexdigit()))
                .then(|| u64::from_str_radix(value, 16).ok())
                .flatten()
        })
    };
    Some(field("CapBnd")? | field("CapInh")?)
}

/// Read once; only a successful read is kept (srt's memo).
static BOUNDING: Mutex<Option<u64>> = Mutex::new(None);

/// `processHasBoundingCapability`: whether this process holds `cap` in its
/// bounding or inheritable set. An unreadable status counts as none.
pub fn process_has_bounding_capability(cap: u32) -> bool {
    let mut memo = BOUNDING.lock().unwrap_or_else(|p| p.into_inner());
    if memo.is_none() {
        *memo = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| bounding_capabilities_from_status(&status));
        if memo.is_none() {
            crate::log::warn(
                "/proc/self/status has no readable CapBnd or CapInh line - assuming this process holds no capabilities",
            );
        }
    }
    memo.is_some_and(|bits| (bits >> cap) & 1 == 1)
}

/// `capabilityArgs` without the seccomp helper: always `--cap-drop ALL`
/// (bubblewrap's default for a non-root caller anyway).
pub fn capability_args() -> [&'static str; 2] {
    ["--cap-drop", "ALL"]
}

/// The effective uid (`process.geteuid()`).
pub fn euid() -> u32 {
    nix::unistd::geteuid().as_raw()
}

/// One answer per bubblewrap executable: whether a uid-0 map is refused is
/// a property of the kernel and the binary.
static PROBES: Mutex<Option<HashMap<PathBuf, Option<String>>>> = Mutex::new(None);

/// `probeUid0UserNamespace`: run `bwrap --unshare-user --dev-bind / /
/// true` once. `None` when the kernel maps uid 0 after all; otherwise
/// bubblewrap's first stderr line (at most 200 characters), or the empty
/// string when the probe could not be run.
pub async fn probe_uid0_user_namespace(bwrap: &Path) -> Option<String> {
    if let Some(cached) = PROBES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|probes| probes.get(bwrap))
    {
        return cached.clone();
    }
    let refusal = run_probe(bwrap).await;
    PROBES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(bwrap.to_path_buf(), refusal.clone());
    refusal
}

async fn run_probe(bwrap: &Path) -> Option<String> {
    let mut command = tokio::process::Command::new(bwrap);
    command
        .args(["--unshare-user", "--dev-bind", "/", "/", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return Some(String::new());
    };
    let mut stderr = child.stderr.take();
    let run = async {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text).await;
        }
        (child.wait().await, text)
    };
    match tokio::time::timeout(PROBE_TIMEOUT, run).await {
        Ok((Ok(status), _)) if status.success() => None,
        Ok((_, text)) => Some(
            text.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| line.chars().take(200).collect())
                .unwrap_or_default(),
        ),
        Err(_) => Some(String::new()),
    }
}

/// `uid0SandboxError`: predict (uid 0 without `CAP_SETFCAP` to hand to
/// bubblewrap), then confirm with [`probe_uid0_user_namespace`]. `None`
/// when there is nothing to report; without bubblewrap the missing binary
/// is its own error.
pub async fn uid0_sandbox_error(
    euid: u32,
    has_setfcap: bool,
    bwrap: Option<&Path>,
) -> Option<String> {
    let bwrap = bwrap.filter(|_| euid == 0 && !has_setfcap)?;
    let refusal = probe_uid0_user_namespace(bwrap).await?;
    Some(if refusal.is_empty() {
        CAP_SETFCAP_MISSING_MESSAGE.to_owned()
    } else {
        format!("{CAP_SETFCAP_MISSING_MESSAGE} (bubblewrap: {refusal})")
    })
}

/// Logs [`CAP_SETFCAP_MISSING_MESSAGE`] once per process when the prediction
/// holds (srt's `setfcapMissingLogged`).
pub fn warn_if_setfcap_missing() {
    static LOGGED: std::sync::Once = std::sync::Once::new();
    if euid() == 0 && !process_has_bounding_capability(CAP_SETFCAP) {
        LOGGED.call_once(|| crate::log::warn(CAP_SETFCAP_MISSING_MESSAGE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_bounding_and_inheritable_sets() {
        let status = "Name:\tx\nCapInh:\t0000000000000000\nCapPrm:\t000001ffffffffff\nCapEff:\t000001ffffffffff\nCapBnd:\t000001ff7fffffff\n";
        let bits = bounding_capabilities_from_status(status).unwrap();
        assert_eq!(bits >> CAP_SETFCAP & 1, 0, "CAP_SETFCAP dropped");
        assert_eq!(bits >> 21 & 1, 1);
        // The inheritable set counts too.
        let inherited = status.replace("CapInh:\t0000000000000000", "CapInh:\t0000000080000000");
        assert_eq!(
            bounding_capabilities_from_status(&inherited).unwrap() >> CAP_SETFCAP & 1,
            1
        );
        assert_eq!(bounding_capabilities_from_status("CapBnd:\tff\n"), None);
        assert_eq!(
            bounding_capabilities_from_status("CapBnd: zz\nCapInh: 0\n"),
            None
        );
    }

    #[test]
    fn always_drops_every_capability() {
        assert_eq!(capability_args(), ["--cap-drop", "ALL"]);
    }

    /// An executable shell script, run once until it is no longer "text
    /// file busy" (another test thread's fork may hold it open for writing).
    fn script(path: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        for _ in 0..100 {
            match std::process::Command::new(path)
                .stderr(Stdio::null())
                .status()
            {
                Err(error) if error.raw_os_error() == Some(nix::libc::ETXTBSY) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => break,
            }
        }
        path.to_path_buf()
    }

    #[tokio::test]
    async fn only_a_root_caller_without_setfcap_is_probed() {
        let missing = Path::new("/nonexistent/bwrap");
        assert_eq!(uid0_sandbox_error(1000, false, Some(missing)).await, None);
        assert_eq!(uid0_sandbox_error(0, true, Some(missing)).await, None);
        assert_eq!(uid0_sandbox_error(0, false, None).await, None);
        // The probe cannot run: the prediction stands unaided.
        assert_eq!(
            uid0_sandbox_error(0, false, Some(missing)).await.as_deref(),
            Some(CAP_SETFCAP_MISSING_MESSAGE)
        );
        // A bubblewrap that refuses, with its first stderr line.
        let dir = tempfile::tempdir().unwrap();
        let fake = script(
            &dir.path().join("bwrap"),
            "echo >&2\necho 'bwrap: setting up uid map: Operation not permitted' >&2\nexit 1",
        );
        assert_eq!(
            uid0_sandbox_error(0, false, Some(&fake)).await.unwrap(),
            format!(
                "{CAP_SETFCAP_MISSING_MESSAGE} (bubblewrap: bwrap: setting up uid map: Operation not permitted)"
            )
        );
        // A kernel that maps uid 0 anyway: nothing to report.
        let ok = script(&dir.path().join("bwrap-ok"), "exit 0");
        assert_eq!(uid0_sandbox_error(0, false, Some(&ok)).await, None);
    }
}
