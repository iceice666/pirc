//! Executable safety experiments for checkpoints phase 1, not product APIs.
//! All source edits and Git operations below target disposable fixtures only.

#[path = "checkpoint_support/mod.rs"]
mod spike;

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Weak;

use pirc_node::write_broker::{WriteBroker, WriteGrant, paths_overlap};
use spike::{Evidence, File, Inverse, Prepared, Rules, Snapshot, inverse, prepare, snapshot};
use tempfile::TempDir;

struct Fixture {
    source: TempDir,
    staging: TempDir,
    rules: Rules,
}

impl Fixture {
    fn new() -> Self {
        Self {
            source: tempfile::tempdir().unwrap(),
            staging: tempfile::tempdir().unwrap(),
            rules: Rules::default(),
        }
    }

    fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let path = self.source.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn capture(&self) -> Snapshot {
        snapshot(self.source.path(), &self.rules).unwrap()
    }

    fn evidence<'a>(
        &self,
        before: &'a Snapshot,
        after: &'a Snapshot,
        paths: &[&str],
    ) -> Evidence<'a> {
        Evidence {
            before,
            after,
            verified: paths.iter().map(PathBuf::from).collect(),
            writers_quiescent: true,
        }
    }

    fn recover(&self, before: &Snapshot, after: &Snapshot, paths: &[&str]) -> Prepared {
        let current = self.capture();
        let prepared = prepare(
            self.source.path(),
            self.staging.path(),
            &self.rules,
            self.evidence(before, after, paths),
            self.rules.max_total_bytes,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            self.capture(),
            current,
            "preparation must not change source"
        );
        assert!(!prepared.stale);
        prepared
    }

    fn git(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .current_dir(self.source.path())
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Checkpoint fixture",
                "-c",
                "user.email=test@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn git_metadata(&self) -> Snapshot {
        snapshot(&self.source.path().join(".git"), &Rules::default()).unwrap()
    }
}

fn read(prepared: &Prepared, path: &str) -> Vec<u8> {
    fs::read(prepared.destination.path().join(path)).unwrap()
}

// Separate hunks with enough stable context that the merge algorithm can
// distinguish them; adjacent/ambiguous changes must remain conflicts.
const BASE: &str =
    "user dirty baseline\nA = old\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nB = old\n";

#[test]
fn dirty_staged_unstaged_and_untracked_user_bytes_survive() {
    let f = Fixture::new();
    f.git(&["init", "--quiet"]);
    f.write("main.txt", "committed\n");
    f.git(&["add", "main.txt"]);
    f.git(&["commit", "--quiet", "-m", "fixture"]);
    f.write("main.txt", "user staged\n");
    f.git(&["add", "main.txt"]);
    f.write("main.txt", BASE);
    f.write("user-untracked.txt", "my draft\r\n");
    let before = f.capture();
    f.write("main.txt", BASE.replace("A = old", "A = agent"));
    let after = f.capture();
    f.write(
        "main.txt",
        BASE.replace("A = old", "A = agent")
            .replace("B = old", "B = user later"),
    );
    f.write("later-untracked.txt", "later draft\n");
    let metadata = f.git_metadata();
    let result = f.recover(&before, &after, &["main.txt"]);
    assert_eq!(
        read(&result, "main.txt"),
        BASE.replace("B = old", "B = user later").as_bytes()
    );
    assert_eq!(read(&result, "user-untracked.txt"), b"my draft\r\n");
    assert_eq!(read(&result, "later-untracked.txt"), b"later draft\n");
    assert_eq!(
        f.git_metadata(),
        metadata,
        "index, refs, HEAD, objects and config stay unchanged"
    );
    assert!(!result.destination.path().join(".git").exists());
}

#[test]
fn inverse_of_a_retains_b_before_and_after_a() {
    for b_first in [false, true] {
        let f = Fixture::new();
        let baseline = if b_first {
            BASE.replace("B = old", "B = B")
        } else {
            BASE.into()
        };
        f.write("main", &baseline);
        let before = f.capture();
        f.write("main", baseline.replace("A = old", "A = A"));
        let after = f.capture();
        f.write(
            "main",
            BASE.replace("A = old", "A = A").replace("B = old", "B = B"),
        );
        let result = f.recover(&before, &after, &["main"]);
        assert_eq!(
            read(&result, "main"),
            BASE.replace("B = old", "B = B").as_bytes()
        );
        assert!(result.conflicts.is_empty());
    }
}

#[test]
fn same_hunk_user_edit_keeps_current_without_markers() {
    let f = Fixture::new();
    f.write("main", "value = baseline\n");
    let before = f.capture();
    f.write("main", "value = A\n");
    let after = f.capture();
    f.write("main", "value = user later\n");
    let result = f.recover(&before, &after, &["main"]);
    assert_eq!(result.conflicts, BTreeSet::from([PathBuf::from("main")]));
    assert_eq!(read(&result, "main"), b"value = user later\n");
}

#[test]
fn b_editing_a_introduced_code_requires_review() {
    let f = Fixture::new();
    f.write("main", "start\nend\n");
    let before = f.capture();
    f.write("main", "start\nnew_function(1);\nend\n");
    let after = f.capture();
    f.write("main", "start\nnew_function(2);\nend\n");
    let result = f.recover(&before, &after, &["main"]);
    assert!(result.conflicts.contains(Path::new("main")));
    assert_eq!(read(&result, "main"), b"start\nnew_function(2);\nend\n");
}

#[test]
fn observed_shell_or_shared_child_changes_are_not_attributed() {
    let f = Fixture::new();
    f.write("main", BASE);
    let before = f.capture();
    f.write("main", "unknown shared writer\n");
    f.write("child", "unknown child writer\n");
    let after = f.capture();
    let result = f.recover(&before, &after, &[]);
    assert!(result.review.contains(Path::new("main")));
    assert!(result.review.contains(Path::new("child")));
    assert_eq!(read(&result, "main"), b"unknown shared writer\n");
    assert_eq!(read(&result, "child"), b"unknown child writer\n");
}

#[test]
fn creations_deletions_and_recreated_paths_use_exact_postimages() {
    let b = File::text("baseline\n");
    let a = File::text("agent\n");
    let later = File::text("later\n");
    for (before, after, current, expected) in [
        (None, Some(&a), Some(&a), Inverse::File(None)),
        (None, Some(&a), Some(&later), Inverse::Conflict),
        (None, Some(&a), None, Inverse::File(None)),
        (Some(&b), None, None, Inverse::File(Some(b.clone()))),
        (Some(&b), None, Some(&later), Inverse::Conflict),
        (Some(&b), Some(&a), None, Inverse::Conflict),
        (Some(&b), Some(&a), Some(&b), Inverse::File(Some(b.clone()))),
    ] {
        assert_eq!(inverse(before, after, current).unwrap(), expected);
    }
}

#[test]
fn occupied_directory_is_not_a_deleted_file() {
    let f = Fixture::new();
    f.write("path", "baseline");
    let before = f.capture();
    fs::remove_file(f.source.path().join("path")).unwrap();
    let after = f.capture();
    f.write("path/user.txt", "new directory contents");
    let result = f.recover(&before, &after, &["path"]);
    assert!(result.conflicts.contains(Path::new("path")));
    assert_eq!(read(&result, "path/user.txt"), b"new directory contents");
}

#[test]
fn binary_inverse_requires_exact_current_postimage() {
    let b = File {
        bytes: vec![0, 255, 1],
        executable: false,
    };
    let a = File {
        bytes: vec![0, 255, 2],
        executable: false,
    };
    let later = File {
        bytes: vec![0, 255, 3],
        executable: false,
    };
    assert_eq!(
        inverse(Some(&b), Some(&a), Some(&a)).unwrap(),
        Inverse::File(Some(b.clone()))
    );
    assert_eq!(
        inverse(Some(&b), Some(&a), Some(&later)).unwrap(),
        Inverse::Conflict
    );
}

#[test]
fn crlf_and_missing_final_newline_are_preserved() {
    for baseline in [BASE.replace('\n', "\r\n"), BASE.trim_end().to_owned()] {
        let b = File::text(&baseline);
        let a = File::text(&baseline.replace("A = old", "A = A"));
        let current = File::text(
            &String::from_utf8(a.bytes.clone())
                .unwrap()
                .replace("B = old", "B = B"),
        );
        assert_eq!(
            inverse(Some(&b), Some(&a), Some(&current)).unwrap(),
            Inverse::File(Some(File::text(&baseline.replace("B = old", "B = B"))))
        );
    }
}

#[test]
fn exact_noop_does_not_normalize_arbitrary_bytes() {
    let f = File {
        bytes: vec![0, 255, b'\r', b'\n'],
        executable: true,
    };
    assert_eq!(
        inverse(Some(&f), Some(&f), Some(&f)).unwrap(),
        Inverse::File(Some(f))
    );
}

#[test]
fn executable_changes_are_separate_and_privileged_bits_never_copied() {
    let f = Fixture::new();
    f.write("script", "baseline\n");
    fs::set_permissions(
        f.source.path().join("script"),
        fs::Permissions::from_mode(0o6755),
    )
    .unwrap();
    let before = f.capture();
    f.write("script", "agent\n");
    fs::set_permissions(
        f.source.path().join("script"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let after = f.capture();
    let result = f.recover(&before, &after, &["script"]);
    assert_eq!(read(&result, "script"), b"baseline\n");
    assert_eq!(
        fs::metadata(result.destination.path().join("script"))
            .unwrap()
            .mode()
            & 0o7777,
        0o700
    );
    let b = File::text("baseline\n");
    let a = File::text("agent\n");
    let current = File {
        executable: true,
        ..a.clone()
    };
    assert_eq!(
        inverse(Some(&b), Some(&a), Some(&current)).unwrap(),
        Inverse::File(Some(File {
            executable: true,
            ..b
        }))
    );
}

#[test]
fn symlinks_hardlinks_sensitive_paths_and_large_files_are_explicit_exclusions() {
    let mut f = Fixture::new();
    f.rules.max_file_bytes = 100;
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "do not follow").unwrap();
    symlink(outside.path(), f.source.path().join("link")).unwrap();
    f.write("private/token", "sensitive");
    f.write("ignored/cache", "build output");
    f.write("too-big", vec![b'x'; 101]);
    f.write("hard", "shared inode");
    fs::hard_link(
        f.source.path().join("hard"),
        f.source.path().join("hard-alias"),
    )
    .unwrap();
    let view = f.capture();
    for path in [
        "link",
        "private",
        "ignored",
        "too-big",
        "hard",
        "hard-alias",
    ] {
        assert!(view.excluded.contains(Path::new(path)), "{path}");
    }
    assert!(view.files.is_empty());
    let result = f.recover(&view, &view, &[]);
    assert_eq!(result.review, view.excluded);
    assert_eq!(
        fs::read(outside.path().join("secret")).unwrap(),
        b"do not follow"
    );
    assert_eq!(fs::read_dir(result.destination.path()).unwrap().count(), 0);
}

#[test]
fn newly_denied_paths_cannot_reappear_in_an_allowed_destination() {
    let mut f = Fixture::new();
    f.write("main", "baseline");
    let before = f.capture();
    f.write("main", "agent");
    let after = f.capture();
    f.rules.denied.push("main".into());
    let result = f.recover(&before, &after, &["main"]);
    assert!(result.review.contains(Path::new("main")));
    assert!(!result.destination.path().join("main").exists());
}

#[test]
fn type_change_to_symlink_never_recreates_its_old_file() {
    let f = Fixture::new();
    f.write("main", "baseline");
    let before = f.capture();
    f.write("main", "agent");
    let after = f.capture();
    fs::remove_file(f.source.path().join("main")).unwrap();
    symlink("outside", f.source.path().join("main")).unwrap();
    let result = f.recover(&before, &after, &["main"]);
    assert!(result.review.contains(Path::new("main")));
    assert!(!result.destination.path().join("main").exists());
}

#[test]
fn copies_have_independent_inodes_and_dont_execute_repo_hooks_or_filters() {
    let f = Fixture::new();
    f.git(&["init", "--quiet"]);
    f.write("main", "baseline");
    f.write(".gitattributes", "* filter=spike\n");
    f.git(&["config", "filter.spike.smudge", "touch SHOULD_NOT_RUN"]);
    f.write(
        ".git/hooks/post-checkout",
        "#!/bin/sh\ntouch SHOULD_NOT_RUN\n",
    );
    fs::set_permissions(
        f.source.path().join(".git/hooks/post-checkout"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let before = f.capture();
    let metadata = f.git_metadata();
    let result = f.recover(&before, &before, &[]);
    let original = fs::metadata(f.source.path().join("main")).unwrap();
    let copied = fs::metadata(result.destination.path().join("main")).unwrap();
    assert_ne!(
        (original.dev(), original.ino()),
        (copied.dev(), copied.ino())
    );
    fs::write(result.destination.path().join("main"), "edited recovery").unwrap();
    assert_eq!(fs::read(f.source.path().join("main")).unwrap(), b"baseline");
    assert_eq!(f.git_metadata(), metadata);
    assert!(!f.source.path().join("SHOULD_NOT_RUN").exists());
    assert!(!result.destination.path().join("SHOULD_NOT_RUN").exists());
}

#[test]
fn external_write_at_the_old_check_then_rename_race_point_survives() {
    let f = Fixture::new();
    f.write("main", "baseline");
    let before = f.capture();
    f.write("main", "agent");
    let after = f.capture();
    let result = prepare(
        f.source.path(),
        f.staging.path(),
        &f.rules,
        f.evidence(&before, &after, &["main"]),
        100,
        |_| {
            // Deliberate fixture mutation models the uncooperative editor.
            f.write("main", "user typed while recovery was preparing");
            Ok(())
        },
    )
    .unwrap();
    assert!(
        result.stale,
        "prepared copy cannot be offered as latest source"
    );
    assert_eq!(
        fs::read(f.source.path().join("main")).unwrap(),
        b"user typed while recovery was preparing"
    );
    assert_eq!(read(&result, "main"), b"baseline");
}

#[test]
fn candidate_copy_budget_is_checked_before_allocating_output() {
    let f = Fixture::new();
    f.write("main", "12345");
    let before = f.capture();
    let result = prepare(
        f.source.path(),
        f.staging.path(),
        &f.rules,
        f.evidence(&before, &before, &[]),
        4,
        |_| panic!("must not start copy"),
    );
    assert!(result.is_err());
    assert_eq!(fs::read_dir(f.staging.path()).unwrap().count(), 0);
    assert_eq!(f.capture(), before);
    let result = f.recover(&before, &before, &[]);
    assert_eq!(result.copied_bytes, 5);
}

#[test]
fn failed_copy_cleans_only_its_own_unpublished_destination() {
    let f = Fixture::new();
    f.write("main", "user bytes");
    let before = f.capture();
    let result = prepare(
        f.source.path(),
        f.staging.path(),
        &f.rules,
        f.evidence(&before, &before, &[]),
        100,
        |destination| {
            assert_eq!(fs::read(destination.join("main"))?, b"user bytes");
            Err(std::io::Error::other("injected preparation failure"))
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read_dir(f.staging.path()).unwrap().count(), 0);
    assert_eq!(f.capture(), before);
}

#[test]
fn active_descendants_and_background_jobs_prevent_stable_capture() {
    let f = Fixture::new();
    let before = f.capture();
    let mut evidence = f.evidence(&before, &before, &[]);
    evidence.writers_quiescent = false;
    assert!(
        prepare(
            f.source.path(),
            f.staging.path(),
            &f.rules,
            evidence,
            100,
            |_| panic!("active writer group must not prepare")
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(f.staging.path()).unwrap().count(), 0);
}

#[test]
fn capture_limits_fail_closed_and_destination_cannot_be_inside_source() {
    let mut f = Fixture::new();
    f.write("one", "12345");
    f.rules.max_total_bytes = 4;
    assert!(snapshot(f.source.path(), &f.rules).is_err());
    f.rules.max_total_bytes = 100;
    f.rules.max_entries = 0;
    assert!(snapshot(f.source.path(), &f.rules).is_err());
    f.rules.max_entries = 100;
    let before = f.capture();
    assert!(
        prepare(
            f.source.path(),
            f.source.path(),
            &f.rules,
            f.evidence(&before, &before, &[]),
            100,
            |_| Ok(())
        )
        .is_err()
    );
    assert_eq!(f.capture(), before);
}

#[test]
fn current_brokers_do_not_provide_cross_node_or_child_attribution() {
    let first = WriteBroker::new(Weak::new());
    let second = WriteBroker::new(Weak::new());
    let f = Fixture::new();
    let root = f.source.path().canonicalize().unwrap();
    assert_eq!(first.acquire("parent", &root), WriteGrant::Granted);
    assert_eq!(
        first.acquire("parent", &root.join("child-output")),
        WriteGrant::Granted
    );
    assert!(matches!(
        first.acquire("other-session", &root),
        WriteGrant::Refused { .. }
    ));
    // This is a measured GAP: separate nodes both grant the same physical root.
    assert_eq!(second.acquire("other-node", &root), WriteGrant::Granted);
    symlink(&root, f.staging.path().join("alias")).unwrap();
    let alias = f.staging.path().join("alias").canonicalize().unwrap();
    assert_eq!(root, alias);
    assert!(paths_overlap(&root, &alias.join("nested")));
    first.release("parent");
    assert_eq!(first.acquire("other-session", &root), WriteGrant::Granted);
    // Session ownership alone says nothing about descendants still writing.
}

#[test]
fn checkpoint_storage_stays_private_and_recovery_requires_new_root_authority() {
    use pirc_policy::PathGuard;
    use pirc_policy::session::{Platform, SandboxConfig, SessionPolicyInput, session_policy};

    let f = Fixture::new();
    let state = tempfile::tempdir().unwrap();
    let checkpoint = state.path().join("checkpoints/blob");
    fs::create_dir(checkpoint.parent().unwrap()).unwrap();
    fs::write(&checkpoint, "private snapshot bytes").unwrap();
    // Linux policy is also generated on macOS here: normalize the host's
    // /var -> /private/var alias before supplying synthetic Linux inputs.
    let text = |p: &Path| pirc_policy::real_resolve(&p.display().to_string());
    for platform in [Platform::Linux, Platform::Macos] {
        let policy = session_policy(&SessionPolicyInput {
            config: SandboxConfig::default(),
            config_dir: text(state.path()),
            home: text(state.path()),
            private_dirs: vec![text(state.path())],
            workspace_root: text(f.source.path()),
            allowed_paths: Vec::new(),
            session_dir: text(&state.path().join("sessions/current")),
            workspace_memory_file: None,
            inference_socket: None,
            tmp_dirs: Vec::new(),
            protected_paths: Vec::new(),
            read_only_dirs: Vec::new(),
            platform,
            uid: 1000,
            ssh_auth_sock: None,
        })
        .unwrap();
        let guard = PathGuard::new(&text(f.source.path()), &policy.paths, &[]);
        assert!(guard.resolve(&text(&checkpoint), false).is_err());
        assert!(guard.resolve(&text(&checkpoint), true).is_err());
        assert!(
            guard
                .resolve(&text(&f.staging.path().join("candidate")), true)
                .is_err()
        );
        guard
            .resolve(&text(&f.source.path().join("ordinary-file")), true)
            .unwrap_or_else(|error| panic!("{error}; policy={:?}", policy.paths));
    }
    // Policy generation only: this does not execute Seatbelt or bubblewrap.
}

#[test]
fn logical_copy_and_blob_costs_are_separate() {
    let f = Fixture::new();
    let baseline = vec![b'b'; 4096];
    let a = vec![b'a'; 4096];
    let b = vec![b'c'; 4096];
    for path in ["one", "two", "three"] {
        f.write(path, &baseline);
    }
    let before = f.capture();
    f.write("one", &a);
    let after = f.capture();
    f.write("two", &b);
    let current = f.capture();
    let result = f.recover(&before, &after, &["one"]);
    let candidate = snapshot(result.destination.path(), &f.rules).unwrap();
    let unique: BTreeSet<_> = [&before, &after, &current, &candidate]
        .iter()
        .flat_map(|s| s.files.values().map(|f| &f.bytes))
        .collect();
    let blob_bytes: usize = unique.iter().map(|bytes| bytes.len()).sum();
    assert_eq!(blob_bytes, 3 * 4096);
    assert_eq!(result.copied_bytes, 3 * 4096);
    assert_eq!(read(&result, "one"), baseline);
    assert_eq!(read(&result, "two"), b);
    // Prospective content deduplication cannot eliminate the independent copy.
    // Physical allocation, journals, metadata and compression are not measured.
}

#[test]
fn independent_process_writing_during_copy_invalidates_the_candidate() {
    use std::io::Write;
    use std::process::{Child, Stdio};

    // The only child is a fixture shell waiting on a pipe. Reap it even if an
    // assertion fails; no daemon, external terminal or user process is touched.
    struct Reap(Child);
    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let f = Fixture::new();
    f.write("main", "baseline");
    let before = f.capture();
    f.write("main", "agent");
    let after = f.capture();
    let mut child = Reap(
        Command::new("/bin/sh")
            .current_dir(f.source.path())
            .args([
                "-c",
                "IFS= read -r gate; printf '%s' 'external writer' > main",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    assert!(child.0.try_wait().unwrap().is_none());
    let result = prepare(
        f.source.path(),
        f.staging.path(),
        &f.rules,
        f.evidence(&before, &after, &["main"]),
        100,
        |_| {
            child.0.stdin.take().unwrap().write_all(b"go\n")?;
            assert!(child.0.wait()?.success());
            Ok(())
        },
    )
    .unwrap();
    assert!(result.stale);
    assert_eq!(
        fs::read(f.source.path().join("main")).unwrap(),
        b"external writer"
    );
    assert_eq!(read(&result, "main"), b"baseline");
}

#[test]
fn replacing_root_with_identical_bytes_still_invalidates_observation() {
    let f = Fixture::new();
    f.write("main", "same bytes");
    let before = f.capture();
    let moved = f.staging.path().join("external-root-move");
    let result = prepare(
        f.source.path(),
        f.staging.path(),
        &f.rules,
        f.evidence(&before, &before, &[]),
        100,
        |_| {
            fs::rename(f.source.path(), &moved)?;
            fs::create_dir(f.source.path())?;
            fs::write(f.source.path().join("main"), "same bytes")?;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        f.capture(),
        before,
        "bytes alone would miss root replacement"
    );
    assert!(result.stale);
    assert_eq!(fs::read(moved.join("main")).unwrap(), b"same bytes");
}
