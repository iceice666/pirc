//! Hard process death at actual durable factory boundaries. Hooks exist only
//! in this test build; the shipped Node has no crash/fault-injection switch.
use super::*;
use crate::sandbox::unavailable::UnavailableSandbox;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const DIR: &str = "PIRC_CHECKPOINT_CRASH_FIXTURE";
const STAGE: &str = "PIRC_CHECKPOINT_CRASH_STAGE";

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn marker(dir: &Path) -> ! {
    fs::write(dir.join("boundary"), b"reached").unwrap();
    loop {
        std::thread::park();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "subprocess helper for hard-kill checkpoint acceptance"]
async fn crash_child() {
    let dir = PathBuf::from(std::env::var_os(DIR).expect("only launched by crash acceptance"));
    let stage = std::env::var(STAGE).unwrap();
    let root = dir.join("source");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("main"), b"dirty user source\r\n").unwrap();
    let scope = Scope {
        node: "n".into(),
        owner: "o".into(),
        workspace: "w".into(),
        session: "s".into(),
        epoch: 1,
        run: "r".into(),
        root,
        device: 0,
        inode: 0,
        policy: Default::default(),
    }
    .bind_root()
    .unwrap();
    fs::write(dir.join("scope.json"), serde_json::to_vec(&scope).unwrap()).unwrap();
    let journal =
        Arc::new(Journal::open(&dir.join("state"), super::super::Limits::default()).unwrap());
    let mut factory = RecoveryFactory::new(journal, CopyLimits::default()).unwrap();
    if stage == "copy" {
        let boundary = dir.clone();
        factory.after_copy = Some(Arc::new(move || marker(&boundary)));
    }
    let sandbox = UnavailableSandbox::new("non-Git fixture never needs a host command");
    let env = ChildEnv::new();
    let selection = Selection {
        operations: vec![],
        review_observational: false,
    };
    let preview = factory
        .preview(scope.clone(), selection.clone(), &sandbox, &env)
        .await
        .unwrap();
    let request = PrepareRequest {
        version: 1,
        key: "hard-crash".into(),
        preview_revision: preview.revision,
        selection,
    };
    fs::write(
        dir.join("request.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    let job = factory
        .prepare(scope.clone(), request, &sandbox, &env)
        .await
        .unwrap();
    if stage == "claimed" {
        let _ticket = factory
            .claim(scope, job.id, job.revision, false, &sandbox, &env)
            .await
            .unwrap();
        marker(&dir);
    }
    assert_eq!(stage, "ready");
    marker(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigkill_during_copy_after_ready_and_after_claim_never_rebuilds_user_output() {
    for stage in ["copy", "ready", "claimed"] {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let log = fs::File::create(&log_path).unwrap();
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "checkpoints::recovery::crash_tests::crash_child",
                    "--nocapture",
                ])
                .env(DIR, dir.path())
                .env(STAGE, stage)
                .stdin(Stdio::null())
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while !dir.path().join("boundary").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "{stage}: {}",
                fs::read_to_string(&log_path).unwrap()
            );
            assert!(
                Instant::now() < deadline,
                "{stage}: child never reached boundary"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        let scope: Scope =
            serde_json::from_slice(&fs::read(dir.path().join("scope.json")).unwrap()).unwrap();
        let request: PrepareRequest =
            serde_json::from_slice(&fs::read(dir.path().join("request.json")).unwrap()).unwrap();
        let journal = Arc::new(
            Journal::open(&dir.path().join("state"), super::super::Limits::default()).unwrap(),
        );
        let (id, reserved): (String, u64) = journal
            .lock()
            .unwrap()
            .query_row("SELECT id,reserved FROM recovery_jobs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(reserved > 0, "reserved evidence must survive abrupt death");
        let output = journal.root.join("workspaces").join(&id).join("root/main");
        assert_eq!(fs::read(&output).unwrap(), b"dirty user source\r\n");
        // A user may edit an unpublished/claimed copy before retrying. Neither
        // recovery restart nor idempotent repetition may remove these bytes.
        fs::write(&output, b"user edited retained copy after crash").unwrap();
        let factory = RecoveryFactory::new(journal.clone(), CopyLimits::default()).unwrap();
        let sandbox = UnavailableSandbox::new("non-Git fixture");
        let env = ChildEnv::new();
        let repeated = factory
            .prepare(scope.clone(), request, &sandbox, &env)
            .await
            .unwrap();
        assert_eq!(repeated.id, id);
        if stage == "copy" {
            assert_eq!(repeated.state, "interrupted");
            assert!(repeated.output.is_none());
        } else if stage == "ready" {
            assert_eq!(repeated.state, "ready");
            assert!(
                factory
                    .claim(
                        scope.clone(),
                        id.clone(),
                        repeated.revision,
                        false,
                        &sandbox,
                        &env
                    )
                    .await
                    .is_err(),
                "edited unopened output requires review"
            );
        } else {
            assert_eq!(repeated.state, "opened");
            // The dead process's writer flock must be released by the OS.
            let ticket = factory
                .claim(
                    scope.clone(),
                    id.clone(),
                    repeated.revision,
                    false,
                    &sandbox,
                    &env,
                )
                .await
                .unwrap();
            assert_eq!(ticket.root().join("main"), output);
            drop(ticket);
        }
        assert_eq!(
            fs::read(output).unwrap(),
            b"user edited retained copy after crash"
        );
        assert_eq!(
            fs::read(scope.root.join("main")).unwrap(),
            b"dirty user source\r\n"
        );
        let count: i64 = journal
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM recovery_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "retry must not allocate another workspace");
    }
}
