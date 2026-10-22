//! Phase-2 backend acceptance; real private SQLite/blob files and owned
//! workspaces only. No user's session, repository or memory is touched.
use pirc_node::checkpoints::{FileVersion, Journal, Limits, Scope, digest};
use pirc_policy::PathPolicy;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

struct Fixture {
    state: TempDir,
    work: TempDir,
    scope: Scope,
}
impl Fixture {
    fn new() -> Self {
        let state = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let root = work.path().canonicalize().unwrap();
        let scope = Scope {
            node: "node".into(),
            owner: "owner".into(),
            workspace: "workspace".into(),
            session: "session".into(),
            epoch: 1,
            run: "run-1".into(),
            root: root.clone(),
            device: 0,
            inode: 0,
            policy: PathPolicy {
                allow_write: vec![root.display().to_string()],
                ..Default::default()
            },
        }
        .bind_root()
        .unwrap();
        Self { state, work, scope }
    }
    fn journal(&self) -> Journal {
        self.limited(Limits::default())
    }
    fn limited(&self, limits: Limits) -> Journal {
        Journal::open(self.state.path(), limits).unwrap()
    }
    fn path(&self, path: &str) -> PathBuf {
        self.scope.root.join(path)
    }
    fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let path = self.path(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn begin(&self, j: &Journal, path: &str) -> String {
        j.begin(&self.scope, &self.path(path), "write", None)
            .unwrap()
    }
    fn commit(&self, j: &Journal, path: &str, bytes: &[u8]) -> String {
        let id = self.begin(j, path);
        self.write(path, bytes);
        j.finish(&self.scope, &id, true).unwrap();
        id
    }
    fn sql(&self, sql: &str) -> i64 {
        rusqlite::Connection::open(self.state.path().join("checkpoints/index.sqlite"))
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
    fn seal(&self, j: &Journal) {
        j.seal(
            &self.scope.session,
            self.scope.epoch,
            Some(&self.scope.run),
            false,
        )
        .unwrap();
    }
}
fn hash(version: &FileVersion) -> &str {
    match version {
        FileVersion::File { hash, .. } => hash,
        _ => panic!("not a captured file: {version:?}"),
    }
}

#[test]
fn real_dirty_baseline_and_exact_postimage_are_durable_and_deduplicated() {
    let f = Fixture::new();
    let j = f.journal();
    f.write("main", b"user dirty\r\n\0\xff");
    let first = f.commit(&j, "main", b"agent after\n");
    let second = f.commit(&j, "other", b"agent after\n");
    assert_ne!(first, second);
    let ops = j.operations(&f.scope).unwrap();
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0].capture, ops[1].capture);
    assert_eq!(ops[0].actor_group, ops[1].actor_group);
    assert_ne!(ops[0].actor_group, f.scope.session);
    assert_eq!(
        j.read_blob(hash(&ops[0].before)).unwrap(),
        b"user dirty\r\n\0\xff"
    );
    assert_eq!(
        j.read_blob(hash(ops[0].after.as_ref().unwrap())).unwrap(),
        b"agent after\n"
    );
    assert_eq!(ops[1].before, FileVersion::Absent);
    assert_eq!(f.sql("SELECT COUNT(*) FROM blobs"), 2);
    f.seal(&j);
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "observational");
    drop(j);
    let reopened = f.journal();
    assert_eq!(reopened.operations(&f.scope).unwrap().len(), 2);
    assert_eq!(fs::read(f.path("main")).unwrap(), b"agent after\n");
}

#[test]
fn stale_preimage_rejects_before_any_file_mutation() {
    let f = Fixture::new();
    let j = f.journal();
    f.write("main", "user later");
    assert!(
        j.begin(&f.scope, &f.path("main"), "edit", Some(&digest(b"old")))
            .unwrap_err()
            .contains("stale edit")
    );
    assert_eq!(fs::read(f.path("main")).unwrap(), b"user later");
    assert!(j.operations(&f.scope).unwrap().is_empty());
    assert_eq!(f.sql("SELECT COUNT(*) FROM blobs"), 0);
}

#[test]
fn restart_marks_pending_operations_interrupted_without_sampling_new_content() {
    let f = Fixture::new();
    let j = f.journal();
    f.write("main", "before");
    let op = f.begin(&j, "main");
    f.write("main", "partially changed before a crash");
    drop(j);
    let j = f.journal();
    let ops = j.operations(&f.scope).unwrap();
    assert_eq!(ops[0].state, "interrupted");
    assert!(ops[0].after.is_none());
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    j.finish(&f.scope, &op, true).unwrap();
    assert!(j.operations(&f.scope).unwrap()[0].after.is_none());
    assert!(j.begin(&f.scope, &f.path("main"), "write", None).is_err());
}

#[test]
fn failed_write_keeps_actual_partial_postimage_and_an_incomplete_group() {
    let f = Fixture::new();
    let j = f.journal();
    f.write("main", "before");
    let op = f.begin(&j, "main");
    f.write("main", "partial");
    j.finish(&f.scope, &op, false).unwrap();
    f.commit(&j, "next", b"next file"); // an incomplete operation does not silently disable the rest
    f.seal(&j);
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    let ops = j.operations(&f.scope).unwrap();
    assert_eq!(ops[0].state, "failed");
    assert_eq!(
        j.read_blob(hash(ops[0].after.as_ref().unwrap())).unwrap(),
        b"partial"
    );
}

#[test]
fn repeat_finish_does_not_relabel_later_user_bytes_as_agent_output() {
    let f = Fixture::new();
    let j = f.journal();
    let op = f.commit(&j, "main", b"agent");
    f.write("main", "later user");
    j.finish(&f.scope, &op, false).unwrap();
    let ops = j.operations(&f.scope).unwrap();
    assert_eq!(ops[0].state, "observed");
    assert_eq!(
        j.read_blob(hash(ops[0].after.as_ref().unwrap())).unwrap(),
        b"agent"
    );
    assert_eq!(fs::read(f.path("main")).unwrap(), b"later user");
}

#[test]
fn operation_tokens_are_bound_to_all_runner_authority_fields() {
    let f = Fixture::new();
    let j = f.journal();
    let op = f.begin(&j, "main");
    for field in 0..9 {
        let mut scope = f.scope.clone();
        match field {
            0 => scope.owner = "other".into(),
            1 => scope.session = "other".into(),
            2 => scope.run = "other".into(),
            3 => scope.epoch += 1,
            4 => scope.workspace = "other".into(),
            5 => scope.node = "other".into(),
            6 => scope.root = f.state.path().into(),
            7 => scope.device += 1,
            _ => scope.inode += 1,
        }
        assert!(j.finish(&scope, &op, true).is_err(), "field {field}");
    }
    assert_eq!(j.operations(&f.scope).unwrap()[0].state, "open");
}

#[test]
fn path_traversal_and_cross_workspace_paths_are_refused() {
    let f = Fixture::new();
    let j = f.journal();
    for path in [
        f.path("../outside"),
        f.state.path().join("outside"),
        f.scope.root.clone(),
        PathBuf::from("relative"),
    ] {
        assert!(
            j.begin(&f.scope, &path, "write", None).is_err(),
            "{}",
            path.display()
        );
    }
    assert!(j.begin(&f.scope, &f.path("main"), "bash", None).is_err());
    assert!(
        j.begin(&f.scope, &f.path("main"), "edit", Some("not-a-hash"))
            .is_err()
    );
}

#[test]
fn deny_read_symlinks_hardlinks_nested_repos_and_special_paths_are_exclusions() {
    let mut f = Fixture::new();
    let j = f.journal();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "secret").unwrap();
    symlink(outside.path(), f.path("link")).unwrap();
    f.write("hard", "inode");
    fs::hard_link(f.path("hard"), f.path("hard2")).unwrap();
    f.write("private/token", "private");
    f.scope
        .policy
        .deny_read
        .push(f.path("private").display().to_string());
    f.write("nested/.git/HEAD", "nested repo");
    f.write("nested/main", "nested");
    f.write(".git/config", "git private");
    f.write("directory/child", "ordinary");
    for path in [
        "link/secret",
        "hard",
        "hard2",
        "private/token",
        "nested/main",
        ".git/config",
        "directory",
    ] {
        let op = f.begin(&j, path);
        j.finish(&f.scope, &op, true).unwrap();
    }
    let ops = j.operations(&f.scope).unwrap();
    assert_eq!(ops.len(), 7);
    assert!(
        ops.iter()
            .all(|o| matches!(o.before, FileVersion::Excluded { .. }))
    );
    assert_eq!(f.sql("SELECT COUNT(*) FROM blobs"), 0);
    f.seal(&j);
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"secret");
}

#[test]
fn executable_bit_is_recorded_without_capturing_privileged_permissions() {
    let f = Fixture::new();
    let j = f.journal();
    f.write("script", "#!/bin/sh\n");
    fs::set_permissions(f.path("script"), fs::Permissions::from_mode(0o6755)).unwrap();
    let op = f.begin(&j, "script");
    fs::set_permissions(f.path("script"), fs::Permissions::from_mode(0o600)).unwrap();
    j.finish(&f.scope, &op, true).unwrap();
    let ops = j.operations(&f.scope).unwrap();
    assert!(matches!(
        ops[0].before,
        FileVersion::File {
            executable: true,
            ..
        }
    ));
    assert!(matches!(
        ops[0].after,
        Some(FileVersion::File {
            executable: false,
            ..
        })
    ));
    let blob = f
        .state
        .path()
        .join("checkpoints/blobs")
        .join(hash(&ops[0].before));
    assert_eq!(
        fs::metadata(blob).unwrap().permissions().mode() & 0o7777,
        0o600
    );
}

#[test]
fn file_limit_is_an_explicit_gap_and_does_not_store_large_contents() {
    let f = Fixture::new();
    let j = f.limited(Limits {
        file_bytes: 4,
        ..Default::default()
    });
    f.write("large", "12345");
    let op = f.begin(&j, "large");
    j.finish(&f.scope, &op, true).unwrap();
    assert_eq!(
        j.operations(&f.scope).unwrap()[0].before,
        FileVersion::Excluded {
            reason: "file_limit".into()
        }
    );
    assert_eq!(f.sql("SELECT COUNT(*) FROM blobs"), 0);
}

#[test]
fn postimage_quota_failure_retains_pending_evidence_and_never_reports_success() {
    let f = Fixture::new();
    let j = f.limited(Limits {
        blob_bytes: 4,
        ..Default::default()
    });
    f.write("main", "1234");
    let op = f.begin(&j, "main");
    f.write("main", "5678");
    assert!(j.finish(&f.scope, &op, true).unwrap_err().contains("quota"));
    assert_eq!(j.operations(&f.scope).unwrap()[0].state, "open");
    f.seal(&j);
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    assert_eq!(fs::read(f.path("main")).unwrap(), b"5678");
}

#[test]
fn pinned_and_active_captures_are_not_evicted_to_make_room() {
    for pinned in [false, true] {
        let f = Fixture::new();
        let j = f.limited(Limits {
            captures_per_workspace: 1,
            ..Default::default()
        });
        f.commit(&j, "main", b"one");
        if pinned {
            f.seal(&j);
            j.pin(&f.scope, true).unwrap();
        }
        let mut next = f.scope.clone();
        next.run = "next".into();
        assert!(j.begin(&next, &f.path("main"), "write", None).is_err());
        assert!(j.info(&f.scope).unwrap().is_some());
        assert_eq!(j.operations(&f.scope).unwrap().len(), 1);
    }
}

#[test]
fn retention_commits_before_orphan_gc_and_reclaims_blob_quota() {
    let f = Fixture::new();
    let j = f.limited(Limits {
        captures_per_workspace: 1,
        blob_bytes: 4,
        ..Default::default()
    });
    f.commit(&j, "main", b"1234");
    f.seal(&j);
    let mut next = f.scope.clone();
    next.run = "next".into();
    fs::remove_file(f.path("main")).unwrap();
    let op = j.begin(&next, &f.path("next"), "write", None).unwrap();
    f.write("next", "5678");
    j.finish(&next, &op, true).unwrap();
    assert!(j.info(&f.scope).unwrap().is_none());
    assert!(j.read_blob(&digest(b"1234")).is_err());
    assert_eq!(j.read_blob(&digest(b"5678")).unwrap(), b"5678");
}

#[test]
fn idle_workspace_sweep_expires_closed_evidence_but_keeps_pins_and_active_runs() {
    for (pinned, active) in [(false, false), (true, false), (false, true)] {
        let f = Fixture::new();
        let j = f.journal();
        f.commit(&j, "main", b"old evidence");
        if !active {
            f.seal(&j);
        }
        if pinned {
            j.pin(&f.scope, true).unwrap();
        }
        let db =
            rusqlite::Connection::open(f.state.path().join("checkpoints/index.sqlite")).unwrap();
        db.execute("UPDATE captures SET created=0", []).unwrap();
        drop(db);
        j.sweep().unwrap();
        assert_eq!(j.info(&f.scope).unwrap().is_some(), pinned || active);
        assert_eq!(
            j.read_blob(&digest(b"old evidence")).is_ok(),
            pinned || active
        );
    }
}

#[test]
fn operation_count_bounds_journal_growth_without_losing_previous_evidence() {
    let f = Fixture::new();
    let j = f.limited(Limits {
        operations_per_capture: 1,
        ..Default::default()
    });
    f.commit(&j, "main", b"first");
    assert!(j.begin(&f.scope, &f.path("next"), "write", None).is_err());
    assert_eq!(j.operations(&f.scope).unwrap().len(), 1);
}

#[test]
fn metadata_admission_keeps_capacity_for_sealing_and_restart() {
    let f = Fixture::new();
    let limits = Limits {
        metadata_bytes: 128 * 1024,
        ..Default::default()
    };
    let j = f.limited(limits.clone());
    let mut suspended = false;
    for _ in 0..1000 {
        if let Err(error) = j.note_uncovered(&f.scope, "background_task") {
            assert!(error.contains("metadata quota"), "{error}");
            suspended = true;
            break;
        }
    }
    assert!(suspended);
    f.seal(&j);
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    drop(j);
    let j = f.limited(limits);
    assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    j.delete_session(&f.scope.owner, &f.scope.session).unwrap();
    let mut next = f.scope.clone();
    next.session = "fresh".into();
    next.run = "fresh".into();
    j.start(&next).unwrap();
}

#[test]
fn corrupt_or_missing_blobs_invalidate_the_manifest() {
    for missing in [false, true] {
        let f = Fixture::new();
        let j = f.journal();
        f.commit(&j, "main", b"original");
        f.seal(&j);
        let blob = f
            .state
            .path()
            .join("checkpoints/blobs")
            .join(digest(b"original"));
        if missing {
            fs::remove_file(blob).unwrap();
        } else {
            fs::write(blob, "corrupt").unwrap();
        }
        assert!(
            j.operations(&f.scope)
                .unwrap_err()
                .contains("missing or corrupt")
        );
        assert_eq!(j.info(&f.scope).unwrap().unwrap().state, "incomplete");
    }
}

#[test]
fn damaged_evidence_from_an_active_run_is_not_a_retention_victim() {
    let f = Fixture::new();
    let j = f.limited(Limits {
        captures_per_workspace: 1,
        ..Default::default()
    });
    f.commit(&j, "main", b"original");
    fs::remove_file(
        f.state
            .path()
            .join("checkpoints/blobs")
            .join(digest(b"original")),
    )
    .unwrap();
    assert!(j.operations(&f.scope).is_err());
    let mut next = f.scope.clone();
    next.run = "next".into();
    assert!(j.start(&next).is_err());
    assert!(j.info(&f.scope).unwrap().is_some());
}

#[test]
fn orphaned_objects_and_partial_files_are_removed_on_restart_only_by_known_names() {
    let f = Fixture::new();
    let j = f.journal();
    f.commit(&j, "main", b"referenced");
    drop(j);
    let dir = f.state.path().join("checkpoints/blobs");
    let orphan = dir.join(digest(b"orphan"));
    fs::write(&orphan, "orphan").unwrap();
    let partial = dir.join("pending-11111111-1111-1111-1111-111111111111");
    fs::write(&partial, "partial").unwrap();
    fs::write(dir.join("unknown-user-file"), "retain unknown").unwrap();
    let j = f.journal();
    assert!(!orphan.exists());
    assert!(!partial.exists());
    assert!(dir.join("unknown-user-file").exists());
    assert_eq!(j.operations(&f.scope).unwrap().len(), 1);
}

#[test]
fn store_refuses_symlink_metadata_or_blob_indirection() {
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), f.state.path().join("checkpoints")).unwrap();
    assert!(Journal::open(f.state.path(), Limits::default()).is_err());
    let f = Fixture::new();
    let j = f.journal();
    f.commit(&j, "main", b"blob");
    let blob = f
        .state
        .path()
        .join("checkpoints/blobs")
        .join(digest(b"blob"));
    fs::remove_file(&blob).unwrap();
    fs::write(outside.path().join("external"), "blob").unwrap();
    symlink(outside.path().join("external"), blob).unwrap();
    assert!(j.read_blob(&digest(b"blob")).is_err());
}

#[test]
fn a_second_live_journal_cannot_mark_the_firsts_operations_interrupted() {
    let f = Fixture::new();
    let j = f.journal();
    f.begin(&j, "main");
    assert!(Journal::open(f.state.path(), Limits::default()).is_err());
    assert_eq!(j.operations(&f.scope).unwrap()[0].state, "open");
}

#[test]
fn deletion_respects_pins_other_sessions_and_shared_blob_references() {
    let f = Fixture::new();
    let j = f.journal();
    f.commit(&j, "main", b"shared");
    let mut other = f.scope.clone();
    other.session = "other-session".into();
    other.run = "other-run".into();
    let op = j.begin(&other, &f.path("main"), "write", None).unwrap();
    j.finish(&other, &op, true).unwrap();
    f.seal(&j);
    j.pin(&f.scope, true).unwrap();
    assert!(j.delete_session(&f.scope.owner, &f.scope.session).is_err());
    j.pin(&f.scope, false).unwrap();
    j.delete_session(&f.scope.owner, &f.scope.session).unwrap();
    assert!(j.operations(&f.scope).unwrap().is_empty());
    assert_eq!(j.operations(&other).unwrap().len(), 1);
    assert_eq!(j.read_blob(&digest(b"shared")).unwrap(), b"shared");
    assert!(
        j.begin(&f.scope, &f.path("main"), "write", None).is_err(),
        "deleted scope cannot resurrect evidence"
    );
    j.delete_session(&other.owner, &other.session).unwrap();
    assert!(j.read_blob(&digest(b"shared")).is_err());
}

#[test]
fn sealed_run_and_closed_epoch_refuse_late_or_reordered_begin_requests() {
    let f = Fixture::new();
    let j = f.journal();
    f.seal(&j);
    assert!(j.begin(&f.scope, &f.path("main"), "write", None).is_err());
    let mut next = f.scope.clone();
    next.run = "next".into();
    j.start(&next).unwrap();
    j.seal(&next.session, next.epoch, None, true).unwrap();
    next.run = "late-run".into();
    assert!(j.start(&next).is_err());
    next.epoch += 1;
    j.start(&next).unwrap();
}

#[test]
fn shell_and_child_markers_never_invent_exact_file_attribution() {
    let f = Fixture::new();
    let j = f.journal();
    j.start(&f.scope).unwrap();
    j.note_uncovered(&f.scope, "bash").unwrap();
    j.note_uncovered(&f.scope, "ptc").unwrap();
    j.note_uncovered(&f.scope, "team").unwrap();
    f.seal(&j);
    let ops = j.operations(&f.scope).unwrap();
    assert!(
        ops.iter()
            .all(|o| o.state == "uncovered" && o.after.is_none())
    );
    let info = j.info(&f.scope).unwrap().unwrap();
    assert!(info.gaps);
    assert_eq!(info.state, "incomplete");
    assert!(info.coverage.contains("observational"));
    assert_eq!(f.sql("SELECT COUNT(*) FROM blobs"), 0);
}

#[test]
fn concurrent_operations_have_unique_node_ids_order_and_shared_group() {
    let f = Fixture::new();
    let journal = Arc::new(f.journal());
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let j = journal.clone();
            let scope = f.scope.clone();
            std::thread::spawn(move || {
                let op = j
                    .begin(&scope, &scope.root.join(format!("file-{i}")), "write", None)
                    .unwrap();
                j.finish(&scope, &op, true).unwrap();
                op
            })
        })
        .collect();
    let ids: std::collections::BTreeSet<_> =
        threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(ids.len(), 8);
    let ops = journal.operations(&f.scope).unwrap();
    assert_eq!(ops.len(), 8);
    assert!(ops.iter().all(|o| o.actor_group == ops[0].actor_group));
}

#[test]
fn root_identity_replacement_cannot_be_recorded_as_the_same_workspace() {
    let f = Fixture::new();
    let j = f.journal();
    f.write("main", "before");
    let op = f.begin(&j, "main");
    let moved = f.state.path().join("moved-fixture");
    fs::rename(f.work.path(), &moved).unwrap();
    fs::create_dir(f.work.path()).unwrap();
    f.write("main", "replacement");
    j.finish(&f.scope, &op, true).unwrap();
    let ops = j.operations(&f.scope).unwrap();
    assert!(
        matches!(ops[0].after,Some(FileVersion::Excluded{ref reason}) if reason=="workspace_identity_changed")
    );
    assert_eq!(fs::read(moved.join("main")).unwrap(), b"before");
}

#[test]
fn metadata_store_has_private_permissions_and_unknown_schema_is_refused() {
    let f = Fixture::new();
    let j = f.journal();
    drop(j);
    for path in ["checkpoints/index.sqlite", "checkpoints/journal.lock"] {
        assert_eq!(
            fs::metadata(f.state.path().join(path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    rusqlite::Connection::open(f.state.path().join("checkpoints/index.sqlite"))
        .unwrap()
        .pragma_update(None, "user_version", 999)
        .unwrap();
    assert!(Journal::open(f.state.path(), Limits::default()).is_err());
}

#[test]
fn configuration_is_explicit_and_empty_selection_creates_no_capture_store() {
    use pirc_config::{Env, NodeConfig};
    use pirc_node::checkpoints::runtime::CaptureService;
    use pirc_protocol::NodeRole;
    let f = Fixture::new();
    let vars = [
        ("HOME", f.work.path().to_str().unwrap()),
        ("PIRC_STATE_DIR", f.state.path().to_str().unwrap()),
        ("PIRC_NODE_ID", "n"),
        ("PIRC_NODE_TOKEN", "0123456789abcdef0123456789abcdef"),
        ("PIRC_DAEMON_URL", "ws://localhost:8787"),
        ("PIRC_ALLOWED_USERS", "owner"),
    ];
    let env = Env::new(vars, f.work.path());
    let config = NodeConfig::load(&env, NodeRole::Node).unwrap();
    assert!(CaptureService::configured(&config, &env).unwrap().is_none());
    assert!(!f.state.path().join("checkpoints").exists());
    for invalid in ["true", "{\"workspace\":true}", "[\"\"]"] {
        let env = Env::new(
            vars.into_iter()
                .chain([("PIRC_CHECKPOINT_WORKSPACES", invalid)]),
            f.work.path(),
        );
        assert!(CaptureService::configured(&config, &env).is_err());
    }
    let env = Env::new(
        vars.into_iter()
            .chain([("PIRC_CHECKPOINT_WORKSPACES", "[]")]),
        f.work.path(),
    );
    assert!(CaptureService::configured(&config, &env).unwrap().is_none());
    let env = Env::new(
        vars.into_iter()
            .chain([("PIRC_CHECKPOINT_WORKSPACES", "[\"workspace\"]")]),
        f.work.path(),
    );
    let service = CaptureService::configured(&config, &env).unwrap().unwrap();
    assert!(service.enabled("workspace"));
    assert!(!service.enabled("other"));
    drop(service);
    let disabled = Env::new(vars, f.work.path());
    let retained = CaptureService::configured(&config, &disabled)
        .unwrap()
        .unwrap();
    assert!(!retained.enabled("workspace"));
    assert!(!retained.enabled("other"));
}
