//! Panel git end to end under the native sandbox (security audit S8): the
//! panel functions of `panels::inspect` run git through
//! `NativeSandbox::prepare_readonly`, whose policy is
//! `common::readonly_session`'s, in bubblewrap. git works in a real
//! repository; a clean filter the agent configured in `.git/config` does
//! run, but sandboxed: no write outside the temp directory, no network, no
//! read of what the session may not read. Skipped, with a message, where
//! `bwrap` or `git` is missing.

#![cfg(target_os = "linux")]

mod sandbox_linux_support;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use pirc_node::panels::inspect::{ChildEnv, git_diff, git_log, git_status};
use sandbox_linux_support::{fixture, path};

const CLIENT: &str = "PIRC_FILTER_TEST_CLIENT";

/// The filter's network probe: exit 0 if the host's port
/// `$PIRC_FILTER_TEST_CLIENT` can be reached.
#[test]
fn filter_client() {
    let Ok(port) = std::env::var(CLIENT) else {
        return;
    };
    let reached = std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(3),
    )
    .is_ok();
    std::process::exit(if reached { 0 } else { 1 });
}

fn host_git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[tokio::test]
async fn panel_git_runs_agent_filters_only_in_the_sandbox() {
    let Some(f) = fixture("panel-git") else {
        return;
    };
    if Command::new("git").arg("--version").output().is_err() {
        eprintln!("skipped: git is not on PATH");
        return;
    }
    let root = &f.root;
    let ws = root.join("workspace");
    std::fs::remove_dir_all(ws.join(".git")).unwrap();
    std::fs::write(ws.join("a.txt"), "one\n").unwrap();
    std::fs::write(ws.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
    host_git(&ws, &["init", "-q"]);
    host_git(&ws, &["add", "."]);
    host_git(&ws, &["commit", "-qm", "first"]);

    // What the agent writes: a change, and a clean filter that tries to
    // escape (S8's attack), reporting what it managed.
    std::fs::write(ws.join("a.txt"), "two\n").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let exe = std::env::current_exe().unwrap();
    let outside = path(root, "outside/pwned");
    let script = format!(
        r#"o=refused; touch '{outside}' 2>/dev/null && o=ok
w=refused; touch '{ws}/pwned' 2>/dev/null && w=ok
g=refused; touch '{ws}/.git/pwned' 2>/dev/null && g=ok
t=refused; touch "$TMPDIR/scratch" 2>/dev/null && t=ok
n=refused; {CLIENT}={port} '{exe}' --exact filter_client -q >/dev/null 2>&1 && n=connected
s=hidden; cat '{secret}' >/dev/null 2>&1 && s=read
k=hidden; cat '{key}' >/dev/null 2>&1 && k=read
printf 'FILTER-RAN outside=%s workspace=%s git=%s tmp=%s net=%s state=%s ssh=%s\n' $o $w $g $t $n $s $k
cat
"#,
        ws = ws.display(),
        exe = exe.display(),
        secret = path(root, "state/secret"),
        key = path(root, "home/.ssh/id_ed25519"),
    );
    std::fs::write(ws.join("evil.sh"), script).unwrap();
    let mut config = std::fs::read_to_string(ws.join(".git/config")).unwrap();
    config.push_str("[filter \"evil\"]\n\tclean = sh ./evil.sh\n");
    std::fs::write(ws.join(".git/config"), &config).unwrap();

    let env: ChildEnv = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", path(root, "home")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();

    let status = git_status(&f.sandbox, &ws, &env).await.unwrap();
    assert_eq!(status["repo"], true, "{status}");
    let files = status["files"].as_array().unwrap();
    let changed = |name: &str| files.iter().find(|file| file["path"] == name).cloned();
    assert_eq!(changed("a.txt").unwrap()["worktree"], "M", "{status}");
    assert!(changed("evil.sh").is_some(), "{status}");

    let log = git_log(&f.sandbox, &ws, &env, 0, 10).await.unwrap();
    let commits = log["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 1, "{log}");
    assert_eq!(commits[0]["subject"], "first");

    // The worktree file goes through the clean filter: it ran, inside.
    let diff = git_diff(&f.sandbox, &ws, &env, Some("a.txt"), false, false)
        .await
        .unwrap();
    let text = diff["diff"].as_str().unwrap();
    assert!(
        text.contains(
            "+FILTER-RAN outside=refused workspace=refused git=refused tmp=ok net=refused state=hidden ssh=hidden"
        ),
        "{text}"
    );
    assert!(text.contains("-one") && text.contains("+two"), "{text}");

    // Nothing reached the host.
    assert!(!Path::new(&outside).exists());
    assert!(!ws.join("pwned").exists());
    assert!(!ws.join(".git/pwned").exists());
    assert!(
        listener.accept().is_err(),
        "the filter reached the host's port"
    );
    assert_eq!(
        std::fs::read_to_string(ws.join(".git/config")).unwrap(),
        config
    );
}

/// Git LFS (review F1): its clean filter, required and run on every changed
/// LFS file, writes the object into `lfs.storage`, which the panel points at
/// the sandbox's temp directory; under the default `.git/lfs` the
/// read-only sandbox made status and diff fail. Skipped without `git-lfs`.
#[tokio::test]
async fn panel_git_handles_git_lfs_files() {
    let Some(f) = fixture("panel-git-lfs") else {
        return;
    };
    let lfs = Command::new("git").args(["lfs", "version"]).output();
    if !lfs.is_ok_and(|output| output.status.success()) {
        eprintln!("skipped: git or git-lfs is not on PATH");
        return;
    }
    let ws = f.root.join("workspace");
    std::fs::remove_dir_all(ws.join(".git")).unwrap();
    host_git(&ws, &["init", "-q"]);
    host_git(&ws, &["lfs", "install", "--local"]);
    host_git(&ws, &["lfs", "track", "*.bin"]);
    std::fs::write(ws.join("a.bin"), "one\n").unwrap();
    host_git(&ws, &["add", "."]);
    host_git(&ws, &["commit", "-qm", "first"]);
    std::fs::write(ws.join("a.bin"), "two\n").unwrap();
    fn objects(dir: &Path) -> usize {
        std::fs::read_dir(dir).map_or(0, |entries| {
            entries
                .flatten()
                .map(|entry| {
                    if entry.file_type().unwrap().is_dir() {
                        objects(&entry.path())
                    } else {
                        1
                    }
                })
                .sum()
        })
    }
    let before = objects(&ws.join(".git/lfs"));

    let env: ChildEnv = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", path(&f.root, "home")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let status = git_status(&f.sandbox, &ws, &env).await.unwrap();
    let files = status["files"].as_array().unwrap();
    let changed = files.iter().find(|file| file["path"] == "a.bin");
    assert_eq!(changed.unwrap()["worktree"], "M", "{status}");

    let diff = git_diff(&f.sandbox, &ws, &env, Some("a.bin"), false, false)
        .await
        .unwrap();
    let text = diff["diff"].as_str().unwrap();
    assert!(
        text.contains(" version https://git-lfs.github.com/spec/v1")
            && text.contains("-oid sha256:")
            && text.contains("+oid sha256:"),
        "{text}"
    );
    // The objects went to the temp directory, not the repository.
    assert_eq!(objects(&ws.join(".git/lfs")), before);
}

/// bubblewrap's own failure (review F2; here `execvp git` with git off the
/// command's `PATH`) exits 1 as git's "no" does: the panel answers 503,
/// not a clean repository or an empty history.
#[tokio::test]
async fn a_failing_sandbox_is_not_a_clean_repository() {
    let Some(f) = fixture("git-broken") else {
        return;
    };
    let ws = f.root.join("workspace");
    let env: ChildEnv = [
        ("PATH", path(&f.root, "no-such-bin")),
        ("HOME", path(&f.root, "home")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let error = git_status(&f.sandbox, &ws, &env).await.unwrap_err();
    assert_eq!(
        (error.status, error.code.as_ref()),
        (503, "runner_unavailable")
    );
    assert!(
        error.message.starts_with(
            "The Git panel runs git in the sandbox, and it is unavailable on this node: bwrap: execvp git"
        ),
        "{}",
        error.message
    );
    let error = git_log(&f.sandbox, &ws, &env, 0, 10).await.unwrap_err();
    assert_eq!(error.status, 503, "{}", error.message);
}
