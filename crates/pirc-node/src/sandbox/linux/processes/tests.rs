use super::*;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct FakeHandle {
    dead: AtomicBool,
    unavailable: AtomicBool,
    signals: AtomicUsize,
    identity: Option<Identity>,
}
impl Handle for FakeHandle {
    fn identity(&self) -> Option<Identity> {
        self.identity.clone()
    }
    fn exited(&self) -> io::Result<bool> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(io::Error::other("unavailable"));
        }
        Ok(self.dead.load(Ordering::SeqCst))
    }
    fn kill(&self) -> io::Result<()> {
        self.signals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[derive(Default)]
struct FakeKernel {
    wrapper: Arc<FakeHandle>,
    namespace: Arc<FakeHandle>,
    captures: AtomicUsize,
}
impl Kernel for FakeKernel {
    fn wrapper(&self, _: u32) -> io::Result<Arc<dyn Handle>> {
        Ok(self.wrapper.clone())
    }
    fn capture(
        &self,
        pid: u32,
        wrapper: &dyn Handle,
        child: &Child,
    ) -> io::Result<Arc<dyn Handle>> {
        self.captures.fetch_add(1, Ordering::SeqCst);
        if pid != 7 || wrapper.exited()? || child.pid != 22 || child.namespace != 77 {
            return Err(io::Error::other("identity not confirmed"));
        }
        Ok(self.namespace.clone())
    }
}
fn fixture() -> (Scope, Arc<FakeKernel>, std::io::PipeWriter) {
    let kernel = Arc::new(FakeKernel::default());
    let scope = Scope {
        kernel: kernel.clone(),
        inner: Arc::default(),
        observer: Mutex::default(),
    };
    let (reader, writer) = std::io::pipe().unwrap();
    nix::fcntl::fcntl(
        &reader,
        nix::fcntl::FcntlArg::F_SETFL(nix::fcntl::OFlag::O_NONBLOCK),
    )
    .unwrap();
    scope.inner.lock().unwrap().reader = Some(reader);
    (scope, kernel, writer)
}
const CHILD: &[u8] = b"{\"child-pid\":22,\"pid-namespace\":77}\n";

#[tokio::test]
async fn retirement_before_fragmented_capture_waits_for_kernel_exit_and_is_scoped() {
    let (scope, kernel, mut writer) = fixture();
    let (peer, peer_kernel, mut peer_writer) = fixture();
    peer_writer.write_all(CHILD).unwrap();
    peer.spawned(7);
    writer.write_all(&CHILD[..10]).unwrap();
    scope.spawned(7);
    scope.terminate();
    assert_eq!(scope.state(), State::Observing);
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
    writer.write_all(&CHILD[10..]).unwrap();
    assert_eq!(
        scope.state(),
        State::Running,
        "signal is not an exit acknowledgement"
    );
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 1);
    kernel.namespace.dead.store(true, Ordering::SeqCst);
    assert_eq!(scope.state(), State::Terminated);
    scope.terminate();
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 1);
    assert_eq!(peer.state(), State::Running);
    assert_eq!(peer_kernel.namespace.signals.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_missing_oversized_and_exit_only_records_never_authorize_a_kill() {
    for record in [
        b"{}\n".to_vec(),
        b"{\"exit-code\":0}\n".to_vec(),
        b"{\"child-pid\":1,\"pid-namespace\":77}\n".to_vec(),
        b"{\"child-pid\":22,\"pid-namespace\":0}\n".to_vec(),
        b"{\"child-pid\":99,\"pid-namespace\":77}\n".to_vec(),
        Vec::new(),
    ] {
        let (scope, kernel, mut writer) = fixture();
        writer.write_all(&record).unwrap();
        drop(writer);
        scope.spawned(7);
        scope.terminate();
        assert_eq!(scope.state(), State::Unconfirmed);
        assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
    }
    let (scope, kernel, _writer) = fixture();
    scope.inner.lock().unwrap().bytes = vec![b'x'; MAX_RECORD];
    scope.spawned(7);
    scope.terminate();
    assert_eq!(scope.state(), State::Unconfirmed);
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn exited_wrapper_does_not_prove_descendants_stopped() {
    let (scope, kernel, mut writer) = fixture();
    kernel.wrapper.dead.store(true, Ordering::SeqCst);
    writer.write_all(CHILD).unwrap();
    scope.spawned(7);
    scope.terminate();
    assert_eq!(scope.state(), State::Unconfirmed);
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn captured_identity_outlives_wrapper_and_never_recaptures_later_records() {
    let (scope, kernel, mut writer) = fixture();
    writer.write_all(CHILD).unwrap();
    scope.spawned(7);
    assert_eq!(scope.state(), State::Running);
    kernel.wrapper.dead.store(true, Ordering::SeqCst);
    writer
        .write_all(b"{\"child-pid\":999,\"pid-namespace\":888}\n")
        .unwrap();
    scope.terminate();
    assert_eq!(kernel.captures.load(Ordering::SeqCst), 1);
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 1);
    kernel.namespace.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(scope.state(), State::Unconfirmed);
    assert!(
        scope
            .prepare_command(&mut tokio::process::Command::new("/bin/sh"))
            .is_err()
    );
}

#[tokio::test]
async fn agent_stdout_cannot_supply_process_authority() {
    let kernel = Arc::new(FakeKernel::default());
    let scope = Scope {
        kernel: kernel.clone(),
        inner: Arc::default(),
        observer: Mutex::default(),
    };
    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.args(["-c", "printf '{\"child-pid\":22,\"pid-namespace\":77}\\n'"]);
    scope.prepare_command(&mut cmd).unwrap();
    let out = cmd.output().await.unwrap();
    drop(cmd);
    assert!(out.status.success());
    scope.spawned(7);
    scope.terminate();
    // EOF can be delayed by concurrent process startup; absence of a trusted
    // record is never a grant, regardless of whether EOF has arrived yet.
    assert!(matches!(
        scope.state(),
        State::Observing | State::Unconfirmed
    ));
    scope.cleanup();
    assert_eq!(scope.state(), State::Unconfirmed);
    assert_eq!(kernel.captures.load(Ordering::SeqCst), 0);
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn status_pipe_stays_open_for_wrappers_exit_record() {
    let (scope, kernel, mut writer) = fixture();
    writer.write_all(CHILD).unwrap();
    scope.spawned(7);
    assert_eq!(scope.state(), State::Running);
    writer.write_all(b"{\"exit-code\":0}\n").unwrap();
    assert_eq!(scope.state(), State::Running);
    drop(scope);
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn final_cleanup_releases_observation_but_does_not_claim_uncaptured_exit() {
    let (scope, kernel, _writer) = fixture();
    scope.spawned(7);
    scope.cleanup();
    assert_eq!(scope.state(), State::Unconfirmed);
    assert!(scope.inner.lock().unwrap().reader.is_none());
    assert!(scope.inner.lock().unwrap().wrapper.is_none());
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn journal_snapshot_keeps_identity_after_exit_and_cleanup_releases_the_handle() {
    let saved = Identity {
        boot_id: "11111111-2222-3333-4444-555555555555".into(),
        observer_namespace: 10,
        namespace: 77,
        pid: 22,
        start_ticks: 100,
    };
    let (mut scope, _, mut writer) = fixture();
    let kernel = Arc::new(FakeKernel {
        namespace: Arc::new(FakeHandle {
            identity: Some(saved.clone()),
            ..Default::default()
        }),
        ..Default::default()
    });
    scope.kernel = kernel.clone();
    writer.write_all(CHILD).unwrap();
    scope.spawned(7);
    assert_eq!(scope.snapshot().identity, Some(saved.clone()));
    kernel.namespace.dead.store(true, Ordering::SeqCst);
    scope.cleanup();
    assert_eq!(scope.snapshot().state, State::Terminated);
    assert_eq!(scope.snapshot().identity, Some(saved));
    assert!(scope.inner.lock().unwrap().namespace.is_none());
    assert!(scope.inner.lock().unwrap().reader.is_none());
    assert_eq!(kernel.namespace.signals.load(Ordering::SeqCst), 0);
}
