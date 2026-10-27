//! A kernel-owned process scope is stronger than a process group: descendants
//! can call setsid. This evidence covers only the captured sandbox, not host
//! commands, terminals, browser contexts, effects already sent or old launches
//! whose handles were lost on Node restart.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Unsupported,
    Observing,
    Running,
    Terminated,
    Unconfirmed,
}

pub trait ProcessScope: Send + Sync {
    /// The trusted wrapper's PID, while it is still owned and unreaped.
    fn spawned(&self, pid: u32);
    fn terminate(&self);
    fn state(&self) -> State;
    /// Final wrapper teardown; release observation FDs without inventing proof.
    fn cleanup(&self);
}
