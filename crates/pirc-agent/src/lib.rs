//! The session agent (`apps/gateway/src/agent`), rewritten in Rust
//! (docs/development/historical-records.md): one session per process, JSONL RPC on
//! stdin/stdout, inference through the node's Unix socket.
//!
//! Like the TS agent it is single-threaded: a current-thread tokio runtime,
//! `Rc`/`RefCell` state and non-`Send` futures, so events keep the order the
//! TS event loop gave them.

use std::future::Future;
use std::pin::Pin;

pub mod agent;
pub mod auto_mode;
pub mod capabilities;
pub mod channels;
pub mod compaction;
pub mod config;
pub mod context;
pub mod feature;
pub mod features;
pub mod handoff;
pub mod handoff_compactor;
pub mod hooks;
pub mod host;
pub mod journal;
pub mod messages;
pub mod ptc;
pub mod redact;
pub mod remote;
pub mod roles;
pub mod rpc;
pub mod run;
pub mod session_store;
pub mod signal;
pub mod skills;
pub mod state_io;
pub mod stream;
pub mod tools;
pub mod ui;

pub use run::run_agent;

/// A boxed future that need not be `Send` (the agent is single-threaded).
pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Run `future` at once up to its first pending await, then as a task: a
/// JavaScript `void promise()` call, whose synchronous part runs before the
/// caller goes on.
pub fn spawn_eager(future: impl Future<Output = ()> + 'static) {
    let mut future = Box::pin(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    if future.as_mut().poll(&mut context).is_pending() {
        // The task polls it again at once, with its own waker.
        tokio::task::spawn_local(future);
    }
}

/// `setTimeout(work, 0)`: `work` runs as a task after the runtime polled
/// its drivers, behind what is runnable now, and timeouts set earlier run
/// first (a later timeout never overtakes an earlier one).
pub fn set_timeout_zero(work: impl Future<Output = ()> + 'static) {
    tokio::task::spawn_local(async move {
        tokio::task::yield_now().await;
        work.await;
    });
}

/// One microtask tick: the task goes to the back of the ready queue at
/// once, behind what is already runnable (tasks spawned or woken before
/// it), as a JavaScript `await` lets the queued microtasks run first.
/// `tokio::task::yield_now` defers the wake until the runtime has polled
/// its drivers, which lets tasks woken later overtake it.
pub async fn tick() {
    let mut ready = false;
    std::future::poll_fn(|cx| {
        if ready {
            std::task::Poll::Ready(())
        } else {
            ready = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
    .await;
}

/// The current time in epoch milliseconds (`Date.now()`).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A random RFC 4122 version 4 UUID (`crypto.randomUUID()`).
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the system random number generator");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `randomBytes(n).toString('hex')`.
pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the system random number generator");
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

pub mod workspace_journal;

pub mod history;
