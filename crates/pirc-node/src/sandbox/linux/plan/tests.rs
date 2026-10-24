use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};

use super::*;

std::thread_local! {
    /// Run by [`plan`] on this thread once its classification is done
    /// and [`CLAIMED`] is dropped (a release racing the plan).
    static AFTER_CLASSIFICATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

pub(super) fn after_classification() {
    if let Some(hook) = AFTER_CLASSIFICATION.with_borrow_mut(Option::take) {
        hook();
    }
}

fn temp() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
    (dir, root)
}

fn args(paths: &PathPolicy) -> Vec<String> {
    plan(paths, &Options::default()).unwrap().args
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn mounts_follow_the_policy_verdicts() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    for dir in ["home/.ssh", "state/sessions/s1", "state/i-1", "ws/.git"] {
        fs::create_dir_all(p(dir)).unwrap();
    }
    for file in ["home/.bashrc", "secret.txt", "ws/.git/config"] {
        fs::write(p(file), "").unwrap();
    }
    let paths = PathPolicy {
        deny_read: vec![
            p("home/.ssh"),
            p("state"),
            p("state/sessions"),
            p("secret.txt"),
        ],
        allow_read: vec![p("ws"), p("state/sessions/s1"), p("state/i-1")],
        allow_write: vec![p("ws"), p("state/sessions/s1"), p("missing")],
        deny_write: vec![
            p("ws/.pirc"),
            p("ws/.git/config"),
            p("home/.ssh"),
            p("home/.bashrc"),
        ],
        shared_write: None,
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    let expected = strings(&[
        "--ro-bind",
        "/",
        "/",
        "--ro-bind",
        "/dev/null",
        &p("secret.txt"),
        "--tmpfs",
        &p("state"),
        "--bind",
        &p("ws"),
        &p("ws"),
        // Denied for writing and reading: hidden stays hidden.
        "--tmpfs",
        &p("home/.ssh"),
        "--ro-bind",
        &p("state/i-1"),
        &p("state/i-1"),
        // Pinned, so `.git` cannot be renamed away from `config`.
        "--bind",
        &p("ws/.git"),
        &p("ws/.git"),
        // Missing: a placeholder, so the agent cannot create it.
        "--ro-bind",
        "/dev/null",
        &p("ws/.pirc"),
        // Hidden inside hidden: nothing to do. The session dir comes back.
        "--bind",
        &p("state/sessions/s1"),
        &p("state/sessions/s1"),
        "--ro-bind",
        &p("ws/.git/config"),
        &p("ws/.git/config"),
        "--remount-ro",
        &p("state"),
        "--remount-ro",
        &p("home/.ssh"),
    ]);
    // `home/.bashrc` is read-only, as `/` already is; `missing` does not
    // exist and is no deny path.
    assert_eq!(plan.args, expected);
    assert_eq!(plan.mount_points, [PathBuf::from(p("ws/.pirc"))]);
}

#[test]
fn every_writable_directory_above_a_protected_path_is_a_mount_point() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    for dir in ["home/.config/.pirc", "home/a/b", "home/.ssh/keys", "ro/x"] {
        fs::create_dir_all(p(dir)).unwrap();
    }
    fs::write(p("home/a/b/c"), "").unwrap();
    fs::write(p("ro/x/y"), "").unwrap();
    let paths = PathPolicy {
        deny_read: vec![p("home/.ssh")],
        allow_write: vec![p("home")],
        deny_write: vec![
            p("home/.config/.pirc"),
            p("home/a/b/c"),
            p("home/.ssh"),
            // Inside a hidden directory, or with a read-only parent:
            // nothing to rename.
            p("home/.ssh/keys"),
            p("ro/x/y"),
        ],
        ..PathPolicy::default()
    };
    let expected = strings(&[
        "--ro-bind",
        "/",
        "/",
        "--bind",
        &p("home"),
        &p("home"),
        "--bind",
        &p("home/.config"),
        &p("home/.config"),
        "--tmpfs",
        &p("home/.ssh"),
        "--bind",
        &p("home/a"),
        &p("home/a"),
        "--ro-bind",
        &p("home/.config/.pirc"),
        &p("home/.config/.pirc"),
        "--bind",
        &p("home/a/b"),
        &p("home/a/b"),
        "--ro-bind",
        &p("home/a/b/c"),
        &p("home/a/b/c"),
        "--remount-ro",
        &p("home/.ssh"),
    ]);
    assert_eq!(args(&paths), expected);
}

#[test]
fn missing_deny_paths_get_placeholders_on_their_first_missing_component() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws/a")).unwrap();
    fs::create_dir_all(p("ro")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![
            p("ws/.pirc"),
            // An intermediate component: an empty read-only directory,
            // shared with the deeper deny below it.
            p("ws/.claude/commands"),
            p("ws/.claude/agents"),
            p("ws/.claude"),
            p("ws/a/b/c/d"),
            // Not writable around it: nothing to place.
            p("ro/x"),
        ],
        ..PathPolicy::default()
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    let expected = strings(&[
        "--ro-bind",
        "/",
        "/",
        "--bind",
        &p("ws"),
        &p("ws"),
        "--tmpfs",
        &p("ws/.claude"),
        "--ro-bind",
        "/dev/null",
        &p("ws/.pirc"),
        // Pinned: the placeholder's parent cannot be renamed away.
        "--bind",
        &p("ws/a"),
        &p("ws/a"),
        "--tmpfs",
        &p("ws/a/b"),
        "--remount-ro",
        &p("ws/.claude"),
        "--remount-ro",
        &p("ws/a/b"),
    ]);
    assert_eq!(plan.args, expected);
    assert_eq!(
        plan.mount_points,
        [p("ws/.claude"), p("ws/.pirc"), p("ws/a/b")].map(PathBuf::from)
    );
}

#[test]
fn missing_read_denies_get_hidden_placeholders() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    fs::create_dir_all(p("ro")).unwrap();
    let paths = PathPolicy {
        deny_read: vec![p("ws/.env"), p("ws/secrets/token"), p("ro/x")],
        allow_write: vec![p("ws")],
        ..PathPolicy::default()
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    assert_eq!(
        plan.args,
        strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--ro-bind",
            "/dev/null",
            &p("ws/.env"),
            "--tmpfs",
            &p("ws/secrets"),
            "--remount-ro",
            &p("ws/secrets"),
        ])
    );
    assert_eq!(
        plan.mount_points,
        [p("ws/.env"), p("ws/secrets")].map(PathBuf::from)
    );
}

/// Globs are taken literally: their missing names get no placeholder
/// (no stray `**` on the host); a name that exists is literal.
#[test]
fn missing_glob_spellings_get_no_placeholders() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws/lit[1]")).unwrap();
    let paths = PathPolicy {
        deny_read: vec![p("ws/**/.env"), p("ws/lit[1]/.env")],
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/.claude/*.json"), p("ws/a?"), p("ws/[x]/y")],
        ..PathPolicy::default()
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    assert_eq!(
        plan.args,
        strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--bind",
            &p("ws/lit[1]"),
            &p("ws/lit[1]"),
            "--ro-bind",
            "/dev/null",
            &p("ws/lit[1]/.env"),
        ])
    );
    assert_eq!(plan.mount_points, [PathBuf::from(p("ws/lit[1]/.env"))]);
}

#[test]
fn a_worktree_git_file_is_pinned_as_a_file() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    fs::write(p("ws/.git"), "gitdir: /elsewhere").unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/.git/hooks"), p("ws/.git/config")],
        ..PathPolicy::default()
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    assert_eq!(
        plan.args,
        strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--ro-bind",
            &p("ws/.git"),
            &p("ws/.git")
        ])
    );
    assert!(plan.mount_points.is_empty());
}

/// A leftover placeholder is claimed again (and so removed later) only
/// when the record names it: a user's own empty read-only file looks
/// the same, and is only covered.
#[test]
fn recorded_stale_placeholders_are_claimed_again_and_others_only_covered() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    for file in [".bashrc", ".zshrc", ".profile"] {
        fs::write(p(&format!("ws/{file}")), "").unwrap();
    }
    for file in [".bashrc", ".zshrc"] {
        fs::set_permissions(p(&format!("ws/{file}")), fs::Permissions::from_mode(0o444)).unwrap();
    }
    let record = PathBuf::from(p("record"));
    fs::write(&record, format!("{}\nrelative\n", p("ws/.bashrc"))).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/.bashrc"), p("ws/.profile"), p("ws/.zshrc")],
        ..PathPolicy::default()
    };
    let options = Options {
        record: Some(record.clone()),
        ..Options::default()
    };
    let plan = plan(&paths, &options).unwrap();
    let expected = strings(&[
        "--ro-bind",
        "/",
        "/",
        "--bind",
        &p("ws"),
        &p("ws"),
        "--ro-bind",
        "/dev/null",
        &p("ws/.bashrc"),
        // The user's own empty file (it has write bits): kept as it is.
        "--ro-bind",
        &p("ws/.profile"),
        &p("ws/.profile"),
        // Unrecorded: covered, never claimed.
        "--ro-bind",
        "/dev/null",
        &p("ws/.zshrc"),
    ]);
    assert_eq!(plan.args, expected);
    assert_eq!(plan.mount_points, [PathBuf::from(p("ws/.bashrc"))]);
    // Without a record nothing is claimed.
    let plan = super::plan(&paths, &Options::default()).unwrap();
    assert!(plan.mount_points.is_empty());
    assert_eq!(plan.args, expected);
}

/// Another session's release can remove a placeholder found in place
/// once the plan has classified it: the plan still covers it (and
/// bubblewrap makes it again), it does not drop the mount.
#[test]
fn a_stale_placeholder_removed_during_the_plan_is_still_covered() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    for file in [".bashrc", ".zshrc"] {
        fs::write(p(&format!("ws/{file}")), "").unwrap();
        fs::set_permissions(p(&format!("ws/{file}")), fs::Permissions::from_mode(0o444)).unwrap();
    }
    let record = PathBuf::from(p("record"));
    fs::write(&record, format!("{}\n", p("ws/.bashrc"))).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/.bashrc"), p("ws/.zshrc")],
        ..PathPolicy::default()
    };
    let options = Options {
        record: Some(record),
        ..Options::default()
    };
    let (bashrc, zshrc) = (p("ws/.bashrc"), p("ws/.zshrc"));
    AFTER_CLASSIFICATION.set(Some(Box::new(move || {
        fs::remove_file(bashrc).unwrap();
        fs::remove_file(zshrc).unwrap();
    })));
    let plan = plan(&paths, &options).unwrap();
    assert!(!Path::new(&p("ws/.bashrc")).exists(), "the hook ran");
    assert_eq!(
        plan.args,
        strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--ro-bind",
            "/dev/null",
            &p("ws/.bashrc"),
            "--ro-bind",
            "/dev/null",
            &p("ws/.zshrc"),
        ])
    );
    assert_eq!(plan.mount_points, [PathBuf::from(p("ws/.bashrc"))]);
}

#[test]
fn symlinked_deny_paths_are_resolved_before_they_are_masked() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    fs::create_dir_all(p("dotfiles")).unwrap();
    fs::create_dir_all(p("ro")).unwrap();
    fs::write(p("dotfiles/mcp.json"), "{}").unwrap();
    // Links in a directory the agent cannot write: protected at their
    // targets, one dangling.
    symlink(p("dotfiles/mcp.json"), p("ro/mcp")).unwrap();
    symlink(p("ws/created-later"), p("ro/dangling")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws"), p("dotfiles")],
        deny_write: vec![p("ro/mcp"), p("ro/dangling")],
        ..PathPolicy::default()
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    assert_eq!(
        plan.args,
        strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("dotfiles"),
            &p("dotfiles"),
            "--bind",
            &p("ws"),
            &p("ws"),
            "--ro-bind",
            &p("dotfiles/mcp.json"),
            &p("dotfiles/mcp.json"),
            "--ro-bind",
            "/dev/null",
            &p("ws/created-later"),
        ])
    );
    assert_eq!(
        resolve_symlinked_deny_path(&p("ro/dangling/x/y")),
        Some(p("ws/created-later/x/y"))
    );
    symlink(p("loop-b"), p("loop-a")).unwrap();
    symlink(p("loop-a"), p("loop-b")).unwrap();
    assert_eq!(resolve_symlinked_deny_path(&p("loop-a/x")), None);
}

#[test]
fn protected_paths_through_replaceable_symlinks_are_refused() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    fs::create_dir_all(p("repo/.git")).unwrap();
    fs::write(p("repo/.git/config"), "").unwrap();
    symlink(p("repo/.git"), p("ws/.git")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/.git/config")],
        ..PathPolicy::default()
    };
    let refusal = plan(&paths, &Options::default()).unwrap_err();
    assert_eq!(
        refusal,
        Refusal {
            protected: p("ws/.git/config"),
            link: p("ws/.git"),
            parent: false,
        }
    );
    assert_eq!(
        refusal.to_string(),
        format!(
            "the protected path {} goes through the symbolic link {}, which the agent could replace (bubblewrap cannot pin a link); replace the link with the file or directory it points to",
            p("ws/.git/config"),
            p("ws/.git")
        )
    );
    // The leaf itself, and a mandatory path found by the scan.
    fs::remove_file(p("ws/.git")).unwrap();
    symlink(p("repo/.git/config"), p("ws/.mcp.json")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        ..PathPolicy::default()
    };
    let options = Options {
        cwd: Some(p("ws")),
        ..Options::default()
    };
    assert_eq!(plan(&paths, &options).unwrap_err().link, p("ws/.mcp.json"));
    // The node's own spelling of its config directory (the policy only
    // holds the resolved one).
    fs::remove_file(p("ws/.mcp.json")).unwrap();
    symlink(p("repo"), p("ws/dotconfig")).unwrap();
    let options = Options {
        spellings: vec![p("ws/dotconfig/pirc")],
        ..Options::default()
    };
    assert_eq!(plan(&paths, &options).unwrap_err().link, p("ws/dotconfig"));
    symlink(p("repo/.git/config"), p("ws/.mcp.json")).unwrap();
    // A link the agent cannot replace is fine: its target is protected.
    let paths = PathPolicy {
        allow_write: vec![p("ws/sub")],
        deny_write: vec![p("ws/.mcp.json")],
        ..PathPolicy::default()
    };
    assert!(plan(&paths, &Options::default()).is_ok());
}

/// A host socket spelled through a link in a writable root (tmux's
/// `/tmp/ssh-agent-$USER` for `SSH_AUTH_SOCK`) is hidden at its target
/// and refuses nothing: it is not protected for host tools.
#[test]
fn host_sockets_behind_replaceable_links_are_hidden_at_their_targets() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("tmp")).unwrap();
    fs::create_dir_all(p("agent")).unwrap();
    let _listener = std::os::unix::net::UnixListener::bind(p("agent/socket")).unwrap();
    symlink(p("agent/socket"), p("tmp/ssh-agent")).unwrap();
    let paths = PathPolicy {
        deny_read: vec![p("tmp/ssh-agent")],
        allow_write: vec![p("tmp")],
        ..PathPolicy::default()
    };
    assert_eq!(
        plan(&paths, &Options::default()).unwrap_err().link,
        p("tmp/ssh-agent"),
        "any other deny is refused"
    );
    let options = Options {
        host_sockets: vec![p("tmp/ssh-agent")],
        ..Options::default()
    };
    let plan = plan(&paths, &options).unwrap();
    assert_eq!(
        plan.args,
        strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("tmp"),
            &p("tmp"),
            "--ro-bind",
            "/dev/null",
            &p("agent/socket"),
        ])
    );
}

/// sshd's agent directories: `ssh-*` directories the uid owns, not
/// links to one nor files.
#[test]
fn ssh_agent_dirs_are_the_uids_ssh_directories() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    for dir in ["ssh-AbC123", "ssh-x/agent.1", "other"] {
        fs::create_dir_all(p(dir)).unwrap();
    }
    fs::write(p("ssh-file"), "").unwrap();
    symlink(p("other"), p("ssh-link")).unwrap();
    let uid = nix::unistd::getuid().as_raw();
    assert_eq!(ssh_agent_dirs(&root, uid), [p("ssh-AbC123"), p("ssh-x")]);
    assert!(ssh_agent_dirs(&root, uid + 1).is_empty());
    assert!(ssh_agent_dirs(&p("missing"), uid).is_empty());
}

#[test]
fn proc_net_unix_lists_each_bound_path_once() {
    let text = "Num       RefCount Protocol Flags    Type St Inode Path\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 1001 /run/a.sock\n\
            0000000000000000: 00000003 00000000 00000000 0001 03 1002 /run/a.sock\n\
            0000000000000000: 00000002 00000000 00010000 0001 01 1003 @abstract\n\
            0000000000000000: 00000002 00000000 00000000 0002 01 1004 /tmp/with space\n\
            0000000000000000: 00000003 00000000 00000000 0001 03 1005\n";
    assert_eq!(
        parse_proc_net_unix(text),
        ["/run/a.sock", "/tmp/with space"]
    );
}

/// Listed paths that are sockets now are hidden at their canonical
/// path, but allowed ones and sessions' proxy sockets; a listed path
/// that is gone or a file now (a socket bound in another mount
/// namespace) is not.
#[test]
fn host_unix_sockets_are_the_listed_sockets_but_the_allowed() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    let _a = std::os::unix::net::UnixListener::bind(p("a.sock")).unwrap();
    let _b = std::os::unix::net::UnixListener::bind(p("b.sock")).unwrap();
    fs::create_dir_all(p("pirc-n-A/p")).unwrap();
    let _proxy = std::os::unix::net::UnixListener::bind(p("pirc-n-A/p/s")).unwrap();
    symlink(p("a.sock"), p("link.sock")).unwrap();
    fs::write(p("file"), "").unwrap();
    let line = |path: &str| format!("0: 00000002 00000000 00010000 0001 01 1 {path}\n");
    let text = ["Num RefCount Protocol Flags Type St Inode Path\n".to_owned()]
        .into_iter()
        .chain(
            [
                "link.sock",
                "a.sock",
                "b.sock",
                "file",
                "gone.sock",
                "pirc-n-A/p/s",
            ]
            .map(|name| line(&p(name))),
        )
        .collect::<String>();
    assert_eq!(host_unix_sockets(&text, &[]), [p("a.sock"), p("b.sock")]);
    assert_eq!(host_unix_sockets(&text, &[p("b.sock")]), [p("a.sock")]);
}

/// The plan hides the host's sockets with `/dev/null`, but the allowed
/// ones, and a socket inside a hidden directory needs no mount. Linux
/// only: the list is the kernel's `/proc/net/unix`.
#[cfg(target_os = "linux")]
#[test]
fn host_rules_hide_bound_sockets_but_the_allowed() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("hidden")).unwrap();
    let _a = std::os::unix::net::UnixListener::bind(p("a.sock")).unwrap();
    let _b = std::os::unix::net::UnixListener::bind(p("b.sock")).unwrap();
    let _c = std::os::unix::net::UnixListener::bind(p("hidden/c.sock")).unwrap();
    let paths = PathPolicy {
        deny_read: vec![p("hidden")],
        ..PathPolicy::default()
    };
    let options = Options {
        host_rules: true,
        bound_sockets: Some(fs::read_to_string(PROC_NET_UNIX).unwrap()),
        allowed_sockets: vec![p("b.sock")],
        ..Options::default()
    };
    let args = plan(&paths, &options).unwrap().args;
    let mounted = |path: &str| args.iter().any(|arg| *arg == path);
    let at = args.iter().position(|arg| *arg == p("a.sock")).unwrap();
    assert_eq!(args[at - 1], "/dev/null");
    assert!(!mounted(&p("b.sock")));
    assert!(!mounted(&p("hidden/c.sock")));
}

/// A link the agent cannot replace that leads through one it can (or
/// through a directory it can replace, by `..`) is refused too: the
/// spelling follows whatever the agent puts there.
#[test]
fn links_in_the_middle_of_a_chain_are_refused() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    for dir in ["ws/sub", "ro", "real/pirc"] {
        fs::create_dir_all(p(dir)).unwrap();
    }
    // ro/entry -> ws/hop -> real
    symlink(p("ws/hop"), p("ro/entry")).unwrap();
    symlink(p("real"), p("ws/hop")).unwrap();
    // ro/up -> ws/sub/../../real: `ws/sub` replaced by a link moves it.
    symlink(format!("{root}/ws/sub/../../real"), p("ro/up")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ro/entry/pirc")],
        ..PathPolicy::default()
    };
    assert_eq!(
        plan(&paths, &Options::default()).unwrap_err(),
        Refusal {
            protected: p("ro/entry/pirc"),
            link: p("ws/hop"),
            parent: false,
        }
    );
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        ..PathPolicy::default()
    };
    let options = Options {
        spellings: vec![p("ro/up/pirc")],
        ..Options::default()
    };
    let refusal = plan(&paths, &options).unwrap_err();
    assert_eq!(
        refusal,
        Refusal {
            protected: p("ro/up/pirc"),
            link: p("ws/sub"),
            parent: true,
        }
    );
    assert!(
            refusal
                .to_string()
                .starts_with(&format!("the protected path {} goes through the directory {} (a symbolic link's target leaves it through ..)", p("ro/up/pirc"), p("ws/sub"))),
            "{refusal}"
        );
    // Nothing the agent may write on the way: protected at the target.
    let paths = PathPolicy {
        allow_write: vec![p("real/pirc")],
        deny_write: vec![p("ro/entry/pirc"), p("ro/up/pirc")],
        ..PathPolicy::default()
    };
    assert!(plan(&paths, &Options::default()).is_ok());
    // `..` out of a directory the agent may not write, in one it may:
    // that directory is pinned, so it cannot be replaced.
    fs::create_dir_all(p("ws/prot")).unwrap();
    fs::create_dir_all(p("ws/target")).unwrap();
    symlink("../target", p("ws/prot/l")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/prot"), p("ws/prot/l/f")],
        ..PathPolicy::default()
    };
    let plan = plan(&paths, &Options::default()).unwrap();
    let has = |a: &str, b: &str, c: &str| plan.args.windows(3).any(|w| w == [a, b, c]);
    assert!(has("--ro-bind", &p("ws/prot"), &p("ws/prot")));
    assert!(has("--ro-bind", "/dev/null", &p("ws/target/f")));
}

#[test]
fn mandatory_deny_paths_join_the_policy() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws/.git/hooks")).unwrap();
    fs::create_dir_all(p("ws/sub/.vscode")).unwrap();
    fs::write(p("ws/sub/.vscode/tasks.json"), "").unwrap();
    fs::write(p("ws/.git/config"), "").unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        ..PathPolicy::default()
    };
    let options = Options {
        cwd: Some(p("ws")),
        ..Options::default()
    };
    let plan = plan(&paths, &options).unwrap();
    let has = |a: &str, b: &str, c: &str| plan.args.windows(3).any(|w| w == [a, b, c]);
    assert!(has("--ro-bind", &p("ws/.git/config"), &p("ws/.git/config")));
    assert!(has("--ro-bind", &p("ws/.git/hooks"), &p("ws/.git/hooks")));
    assert!(has("--ro-bind", &p("ws/sub/.vscode"), &p("ws/sub/.vscode")));
    assert!(has("--ro-bind", "/dev/null", &p("ws/.bashrc")));
    assert!(
        plan.args
            .windows(2)
            .any(|w| w == ["--tmpfs", &p("ws/.claude")])
    );
    // No write root around the working directory: no scan at all.
    let read_only = PathPolicy {
        allow_write: vec![p("elsewhere")],
        ..PathPolicy::default()
    };
    assert_eq!(
        super::plan(&read_only, &options).unwrap().args,
        strings(&["--ro-bind", "/", "/"])
    );
}

/// Linux's root (`/etc` is a symlink to `/private/etc` on macOS).
#[test]
#[cfg(target_os = "linux")]
fn a_denied_root_is_expanded_and_kernel_paths_are_left_alone() {
    let paths = PathPolicy {
        deny_read: vec!["/".into(), "/proc/1".into()],
        allow_read: vec!["/usr".into()],
        ..PathPolicy::default()
    };
    let args = args(&paths);
    assert_eq!(args[..3], ["--ro-bind", "/", "/"]);
    assert!(args.windows(2).any(|w| w == ["--tmpfs", "/etc"]));
    // A regular file at the root (`/.dockerenv`, a runner's swap file)
    // is hidden by binding `/dev/null` onto it: that source is not a
    // mount under `/dev`.
    let paths: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(i, arg)| !(*arg == "/dev/null" && *i > 0 && args[i - 1] == "--ro-bind"))
        .map(|(_, arg)| arg)
        .collect();
    assert!(
        !paths.iter().any(|arg| *arg == "/usr"
            || arg.starts_with("/proc")
            || arg.starts_with("/sys")
            || arg.starts_with("/dev/")),
        "{args:?}"
    );
    // No mount lands on a symlink: every target is its canonical path.
    for arg in args.iter().filter(|a| a.starts_with('/') && *a != "/") {
        assert!(
            !fs::symlink_metadata(arg).unwrap().file_type().is_symlink(),
            "{arg}"
        );
    }
}

/// Another sandbox's directory placeholder is an empty directory on the
/// host: it is planned as this sandbox's placeholder too, not as the
/// user's directory with placeholders inside.
#[test]
fn another_sandboxs_directory_placeholder_is_claimed_again() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("ws")).unwrap();
    let paths = PathPolicy {
        allow_write: vec![p("ws")],
        deny_write: vec![p("ws/.claude/commands"), p("ws/.claude/agents")],
        ..PathPolicy::default()
    };
    let first = plan(&paths, &Options::default()).unwrap();
    let expected = strings(&[
        "--ro-bind",
        "/",
        "/",
        "--bind",
        &p("ws"),
        &p("ws"),
        "--tmpfs",
        &p("ws/.claude"),
        "--remount-ro",
        &p("ws/.claude"),
    ]);
    assert_eq!(first.args, expected);
    let mut claim = MountPoints::claim(first.mount_points, None);
    // What bubblewrap makes for the first sandbox.
    fs::create_dir(p("ws/.claude")).unwrap();
    let second = plan(&paths, &Options::default()).unwrap();
    assert_eq!(second.args, expected);
    assert_eq!(second.mount_points, [PathBuf::from(p("ws/.claude"))]);
    let mut again = MountPoints::claim(second.mount_points, None);
    claim.release();
    assert!(Path::new(&p("ws/.claude")).exists(), "still claimed");
    again.release();
    assert!(!Path::new(&p("ws/.claude")).exists());
    // Unclaimed and unrecorded, an empty directory is the user's.
    fs::create_dir(p("ws/.claude")).unwrap();
    let users = plan(&paths, &Options::default()).unwrap();
    assert!(
        users
            .args
            .windows(3)
            .any(|w| w == ["--ro-bind", "/dev/null", &p("ws/.claude/commands")]),
        "{:?}",
        users.args
    );
}

/// An empty directory the record names that the policy now allows (a
/// leftover the user made a workspace of) is the user's: never
/// covered as a placeholder, and the denies below it get their own.
#[test]
fn a_recorded_directory_the_policy_allows_is_not_reused() {
    let (_dir, root) = temp();
    let p = |rest: &str| format!("{root}/{rest}");
    fs::create_dir_all(p("home/newproj")).unwrap();
    let record = PathBuf::from(p("record"));
    fs::write(&record, format!("{}\n", p("home/newproj"))).unwrap();
    let options = Options {
        record: Some(record),
        ..Options::default()
    };
    for allowed in ["home", "home/newproj", "home/newproj/sub"] {
        let paths = PathPolicy {
            allow_write: vec![p("home"), p(allowed)],
            deny_write: vec![p("home/newproj/.bashrc")],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &options).unwrap();
        let reused = plan
            .args
            .windows(2)
            .any(|w| w == ["--tmpfs", &p("home/newproj")]);
        assert_eq!(reused, allowed == "home", "{allowed}: {:?}", plan.args);
        if allowed != "home" {
            assert_eq!(
                plan.mount_points,
                [PathBuf::from(p("home/newproj/.bashrc"))]
            );
        }
    }
}

/// At the node's start the record's leftovers no sandbox claims are
/// removed when still what bubblewrap made, and the record keeps only
/// the claimed ones; once per record.
#[test]
fn the_record_is_swept_at_the_first_plan() {
    let (_dir, root) = temp();
    let p = |rest: &str| PathBuf::from(format!("{root}/{rest}"));
    let record = p("record");
    let (file, dir, nested, written, users, claimed) = (
        p(".bashrc"),
        p(".claude"),
        p("a/.git"),
        p(".zshrc"),
        p(".profile"),
        p(".mcp.json"),
    );
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&nested).unwrap();
    for (path, contents, mode) in [
        (&file, "", 0o444),
        (&written, "x", 0o444),
        (&users, "", 0o644),
        (&claimed, "", 0o444),
    ] {
        fs::write(path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }
    let all = [&file, &dir, &p("a"), &nested, &written, &users, &claimed];
    let text: String = all.iter().map(|e| format!("{}\n", e.display())).collect();
    fs::write(&record, &text).unwrap();
    let mut claim = MountPoints::claim(vec![claimed.clone()], None);
    sweep_record(&record);
    assert!(!file.exists() && !dir.exists());
    assert!(!p("a").exists(), "deepest first: emptied, then removed");
    assert!(
        written.exists() && users.exists(),
        "not what bubblewrap made"
    );
    assert!(claimed.exists(), "claimed");
    assert_eq!(read_record(&record), BTreeSet::from([claimed.clone()]));
    fs::write(&record, &text).unwrap();
    sweep_record(&record);
    assert_eq!(fs::read_to_string(&record).unwrap(), text, "once");
    claim.release();
}

#[test]
fn claimed_placeholders_stay_recorded_until_released() {
    let (_dir, root) = temp();
    let record = PathBuf::from(format!("{root}/record"));
    let ours = PathBuf::from(format!("{root}/.bashrc"));
    let gone = PathBuf::from(format!("{root}/gone"));
    let kept = PathBuf::from(format!("{root}/kept"));
    fs::write(&kept, "").unwrap();
    fs::write(&record, format!("{}\n{}\n", gone.display(), kept.display())).unwrap();
    let mut claim = MountPoints::claim(vec![ours.clone()], Some(record.clone()));
    let mode = fs::metadata(&record).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    // Recorded before bubblewrap makes it; a recorded path that is
    // gone and unclaimed is dropped.
    assert_eq!(
        read_record(&record),
        BTreeSet::from([ours.clone(), kept.clone()])
    );
    fs::write(&ours, "").unwrap();
    claim.release();
    assert!(!ours.exists());
    assert_eq!(read_record(&record), BTreeSet::from([kept]));
}

/// A claim dropped on the async runtime does not wait there for the
/// process-wide lock (or the removals): the blocking pool releases it.
#[tokio::test]
async fn dropped_claims_are_released_off_the_runtime() {
    let (_dir, root) = temp();
    let file = PathBuf::from(format!("{root}/.bashrc"));
    let claim = MountPoints::claim(vec![file.clone()], None);
    fs::write(&file, "").unwrap();
    let (locked, wait) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
        locked.send(()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
    });
    wait.recv().unwrap();
    let started = std::time::Instant::now();
    drop(claim);
    assert!(
        started.elapsed() < std::time::Duration::from_millis(300),
        "the drop waited {:?}",
        started.elapsed()
    );
    holder.join().unwrap();
    for _ in 0..200 {
        if !file.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!file.exists());
}

#[test]
fn placeholders_are_removed_when_their_last_sandbox_ends() {
    let (_dir, root) = temp();
    let file = PathBuf::from(format!("{root}/.bashrc"));
    let dir = PathBuf::from(format!("{root}/.claude"));
    let kept = PathBuf::from(format!("{root}/.profile"));
    let mut first = MountPoints::claim(vec![file.clone(), dir.clone(), kept.clone()], None);
    let mut second = MountPoints::claim(vec![file.clone()], None);
    fs::write(&file, "").unwrap();
    fs::create_dir(&dir).unwrap();
    fs::write(&kept, "written meanwhile").unwrap();
    first.release();
    assert!(file.exists(), "still used by the second sandbox");
    assert!(!dir.exists());
    assert!(kept.exists(), "not what bubblewrap made");
    second.release();
    assert!(!file.exists());
    drop(second);
}
