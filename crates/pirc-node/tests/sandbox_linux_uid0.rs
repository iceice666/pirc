//! The native sandbox as uid 0 (srt's `uid0SandboxError`, ported in
//! `sandbox/linux/caps.rs`): inside `unshare -r` user namespaces (uid 0
//! there, with and without `CAP_SETFCAP` in the bounding set) and in
//! rootless podman containers (container root with podman's default
//! capabilities and with `--cap-drop SETFCAP`, bubblewrap nested). Each
//! case runs this test binary again as the "node" there ([`uid0_child`],
//! which does nothing unless `PIRC_UID0_CHILD` is set) and reads what it
//! reports. Cases are skipped, with a message, where `bwrap`, `unshare`,
//! `setpriv`/`capsh` or `podman` are missing or user namespaces are off.
//! The real-root cases are `#[ignore]`d: run them with `sudo` (see each).

#![cfg(target_os = "linux")]

mod sandbox_linux_support;

use std::path::{Path, PathBuf};
use std::process::Command;

use pirc_node::sandbox::linux::caps::{self, CAP_SETFCAP, CAP_SETFCAP_MISSING_MESSAGE};
use pirc_node::sandbox::{Sandbox, SandboxStatus};
use sandbox_linux_support::{fixture_in, have_bwrap, path};

const CHILD: &str = "PIRC_UID0_CHILD";
const BASE: &str = "PIRC_UID0_BASE";
const NAME: &str = "PIRC_UID0_NAME";

/// Inside the namespace or container: report euid, `CAP_SETFCAP`, the
/// sandbox's status and, when it works, whether denials hold against a
/// command running as uid 0 (`@@ name: value` lines).
#[tokio::test]
async fn uid0_child() {
    if std::env::var(CHILD).is_err() {
        return;
    }
    let base = std::env::var(BASE).map(PathBuf::from).ok();
    let report = |name: &str, value: &str| println!("@@ {name}: {value}");
    report("euid", &caps::euid().to_string());
    report(
        "setfcap",
        &caps::process_has_bounding_capability(CAP_SETFCAP).to_string(),
    );
    let name = std::env::var(NAME).unwrap_or_else(|_| "uid0".to_owned());
    let Some(f) = fixture_in(
        base.as_deref(),
        &name,
        r#"{"sandbox":{"network":{"defaultDomains":false}}}"#,
    ) else {
        report("status", "no bwrap");
        std::process::exit(0);
    };
    match f.sandbox.check().await {
        SandboxStatus::Unavailable { reason } => {
            report("status", &format!("unavailable: {reason}"))
        }
        SandboxStatus::Active { .. } => {
            report("status", "active");
            let w = path(&f.root, "workspace");
            let checks = [
                ("id", "test \"$(id -u)\" = 0".to_owned()),
                ("write-workspace", format!("echo x > {w}/new")),
                ("write-git-config", format!("echo x >> {w}/.git/config")),
                ("umount-git-config", format!("umount {w}/.git/config")),
                (
                    "remount-rw",
                    format!("mount -o remount,rw,bind {w}/.git/config"),
                ),
                ("create-pirc", format!("mkdir {w}/.pirc")),
                (
                    "read-ssh",
                    format!("cat {}/.ssh/id_ed25519", path(&f.root, "home")),
                ),
                (
                    "read-state",
                    format!("cat {}/secret", path(&f.root, "state")),
                ),
            ];
            for (name, script) in checks {
                let code = f.sh(&script).await;
                report(name, if code == 0 { "allowed" } else { "refused" });
            }
        }
    }
    std::process::exit(0);
}

/// What a child run reported, by name; `None` when the run failed to
/// start at all (namespaces off), with the reason printed.
fn reports(name: &str, mut command: Command) -> Option<Vec<(String, String)>> {
    let exe = std::env::current_exe().unwrap();
    command
        .arg(&exe)
        .args(["--exact", "uid0_child", "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .env(NAME, name);
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<(String, String)> = stdout
        .lines()
        .filter_map(|line| line.split_once("@@ ")?.1.split_once(": "))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    if lines.is_empty() {
        eprintln!(
            "skipped: the child did not run ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    Some(lines)
}

fn get<'a>(reports: &'a [(String, String)], name: &str) -> &'a str {
    reports
        .iter()
        .find(|(n, _)| n == name)
        .map_or("", |(_, v)| v.as_str())
}

/// A working sandbox as uid 0: the command inside is uid 0 too, and still
/// cannot write, unmount or remount a denial (`--cap-drop ALL`).
fn assert_confined(reports: &[(String, String)]) {
    assert_eq!(get(reports, "status"), "active", "{reports:?}");
    let expect = [
        ("id", "allowed"),
        ("write-workspace", "allowed"),
        ("write-git-config", "refused"),
        ("umount-git-config", "refused"),
        ("remount-rw", "refused"),
        ("create-pirc", "refused"),
        ("read-ssh", "refused"),
        ("read-state", "refused"),
    ];
    for (name, value) in expect {
        assert_eq!(get(reports, name), value, "{name}: {reports:?}");
    }
}

fn on_path(program: &str) -> Option<PathBuf> {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|file| file.is_file())
}

/// `unshare -r` (uid 0 mapped to this user, a full capability set in the
/// namespace).
fn unshare() -> Option<Command> {
    if !have_bwrap() {
        return None;
    }
    let Some(unshare) = on_path("unshare") else {
        eprintln!("skipped: unshare is not on PATH");
        return None;
    };
    let mut command = Command::new(unshare);
    command.arg("-r");
    Some(command)
}

#[test]
fn uid0_in_a_user_namespace_sandboxes() {
    let Some(command) = unshare() else {
        return;
    };
    let Some(reports) = reports("ns", command) else {
        return;
    };
    assert_eq!(get(&reports, "euid"), "0");
    assert_eq!(get(&reports, "setfcap"), "true");
    assert_confined(&reports);
}

#[test]
fn uid0_without_setfcap_is_refused_with_srts_reason() {
    let Some(mut command) = unshare() else {
        return;
    };
    // Drop CAP_SETFCAP from the bounding set before the child starts.
    if let Some(setpriv) = on_path("setpriv") {
        command.args([
            setpriv.as_os_str(),
            "--bounding-set".as_ref(),
            "-setfcap".as_ref(),
        ]);
    } else if let Some(capsh) = on_path("capsh") {
        command.args([
            capsh.as_os_str(),
            "--drop=cap_setfcap".as_ref(),
            "--".as_ref(),
            "-c".as_ref(),
            "exec \"$0\" \"$@\"".as_ref(),
        ]);
    } else {
        eprintln!("skipped: neither setpriv nor capsh is on PATH to drop CAP_SETFCAP");
        return;
    }
    let Some(reports) = reports("ns-nocap", command) else {
        return;
    };
    assert_eq!(get(&reports, "euid"), "0");
    assert_eq!(get(&reports, "setfcap"), "false");
    let status = get(&reports, "status");
    assert!(
        status.starts_with(&format!("unavailable: {CAP_SETFCAP_MISSING_MESSAGE}")),
        "{status}"
    );
}

/// The image the podman cases use: `PIRC_PODMAN_IMAGE`, else one built
/// from `tests/fixtures/bwrap.Containerfile` (Ubuntu with bubblewrap).
fn podman_image(podman: &Path) -> Option<String> {
    if let Ok(image) = std::env::var("PIRC_PODMAN_IMAGE") {
        return Some(image);
    }
    let image = "localhost/pirc-bwrap-test:latest";
    let exists = Command::new(podman)
        .args(["image", "exists", image])
        .status()
        .is_ok_and(|status| status.success());
    if !exists {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bwrap.Containerfile");
        let built = Command::new(podman)
            .args(["build", "-t", image, "-f"])
            .arg(&file)
            .arg(file.parent().unwrap())
            .status();
        if !built.is_ok_and(|status| status.success()) {
            eprintln!("skipped: cannot build {image} with podman");
            return None;
        }
    }
    Some(image.to_owned())
}

/// `podman run` of this test binary as container root, with the target
/// directory (the binaries) mounted where it is on the host.
fn podman(extra: &[&str]) -> Option<Command> {
    let Some(podman) = on_path("podman") else {
        eprintln!("skipped: podman is not on PATH (the CI job `sandbox-podman` runs these)");
        return None;
    };
    let image = podman_image(&podman)?;
    let target = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let mut command = Command::new(podman);
    command.args([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--env",
        &format!("{CHILD}=1"),
        "--env",
        &format!("{BASE}=/work"),
    ]);
    command.args(["--tmpfs", "/work:rw,exec"]);
    let volume = format!("{0}:{0}:ro", target.display());
    command.args(["--volume", &volume]);
    if Path::new("/nix/store").is_dir() {
        command.args(["--volume", "/nix/store:/nix/store:ro"]);
    }
    command.args(extra);
    command.arg(image);
    Some(command)
}

/// What nested bubblewrap needs from podman: no seccomp filter or AppArmor
/// profile refusing its namespaces and mounts, and an unmasked `/proc`
/// (the kernel refuses a fresh `proc` mount while parts of the current one
/// are covered).
const NESTING: [&str; 6] = [
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "apparmor=unconfined",
    "--security-opt",
    "unmask=ALL",
];

#[test]
fn container_root_with_default_capabilities_sandboxes() {
    let Some(command) = podman(&NESTING) else {
        return;
    };
    let reports = reports("pd", command).expect("the container ran nothing");
    assert_eq!(get(&reports, "euid"), "0");
    assert_eq!(get(&reports, "setfcap"), "true");
    assert_confined(&reports);
}

#[test]
fn container_root_without_setfcap_is_refused_with_srts_reason() {
    let mut extra = NESTING.to_vec();
    extra.extend(["--cap-drop", "SETFCAP"]);
    let Some(command) = podman(&extra) else {
        return;
    };
    let reports = reports("pd-nocap", command).expect("the container ran nothing");
    assert_eq!(get(&reports, "euid"), "0");
    assert_eq!(get(&reports, "setfcap"), "false");
    let status = get(&reports, "status");
    assert!(
        status.starts_with(&format!("unavailable: {CAP_SETFCAP_MISSING_MESSAGE}")),
        "{status}"
    );
}

/// Podman's defaults alone (seccomp, masked `/proc`): bubblewrap may not
/// nest, but then the sandbox says so; it never runs agents unconfined.
#[test]
fn container_root_with_podman_defaults_never_runs_unconfined() {
    let Some(command) = podman(&[]) else {
        return;
    };
    let reports = reports("pd-default", command).expect("the container ran nothing");
    let status = get(&reports, "status");
    if status == "active" {
        assert_confined(&reports);
    } else {
        assert!(status.starts_with("unavailable: "), "{reports:?}");
        eprintln!("podman defaults: {status}");
    }
}

/// Real root on the host. Run with:
/// `sudo -E env "PATH=$PATH" cargo test -p pirc-node --test sandbox_linux_uid0 -- --ignored host_root`
#[test]
#[ignore = "needs real root: see the doc comment"]
fn host_root_sandboxes() {
    assert_eq!(caps::euid(), 0, "run this test as root");
    let Some(reports) = reports("root", Command::new("env")) else {
        panic!("the child did not run");
    };
    assert_eq!(get(&reports, "euid"), "0");
    assert_confined(&reports);
}

/// Real root without `CAP_SETFCAP`. Run with:
/// `sudo -E env "PATH=$PATH" capsh --drop=cap_setfcap -- -c 'cargo test -p pirc-node --test sandbox_linux_uid0 -- --ignored host_root_without'`
#[test]
#[ignore = "needs real root: see the doc comment"]
fn host_root_without_setfcap_is_refused() {
    assert_eq!(caps::euid(), 0, "run this test as root");
    let Some(reports) = reports("root-nocap", Command::new("env")) else {
        panic!("the child did not run");
    };
    assert_eq!(get(&reports, "setfcap"), "false", "drop CAP_SETFCAP first");
    assert!(
        get(&reports, "status").starts_with(&format!("unavailable: {CAP_SETFCAP_MISSING_MESSAGE}")),
        "{reports:?}"
    );
}
