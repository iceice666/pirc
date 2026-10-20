//! One timer for the earliest deadline, re-armed whenever the deadlines
//! change: what the schedules' timer did, without the schedules
//! (plans/rewrite/00-demolition.md keeps it for 05-self-wake.md).
//!
//! The owner says when the next deadline is ([`DeadlineTimer::start`]'s
//! `due`) and what to do when it passes (`fire`); it calls
//! [`DeadlineTimer::arm`] after changing what `due` would answer.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::util::now_ms;

/// Look again at least this often, so a suspended machine or a clock
/// change is noticed.
const MAX_SLEEP_MS: i64 = 3_600_000;

#[derive(Default)]
pub struct DeadlineTimer {
    arm: Notify,
}

impl DeadlineTimer {
    /// Run the timer: sleep until the earliest deadline `due` reports (at
    /// most an hour, or until [`Self::arm`]), then `fire`. With no deadline
    /// it waits for [`Self::arm`].
    pub fn start(
        self: &Arc<Self>,
        due: impl Fn() -> Option<i64> + Send + 'static,
        fire: impl Fn() + Send + 'static,
    ) -> tokio::task::JoinHandle<()> {
        let timer = self.clone();
        tokio::spawn(async move {
            loop {
                match due() {
                    None => timer.arm.notified().await,
                    Some(due) => {
                        let delay = (due - now_ms()).clamp(0, MAX_SLEEP_MS) as u64;
                        tokio::select! {
                            () = timer.arm.notified() => {}
                            () = tokio::time::sleep(Duration::from_millis(delay)) => {
                                if due <= now_ms() {
                                    fire();
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    /// The deadlines changed: look at them again.
    pub fn arm(&self) {
        self.arm.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn fires_at_the_earliest_deadline_and_rearms() {
        let deadline = Arc::new(Mutex::new(None::<i64>));
        let fired = Arc::new(AtomicUsize::new(0));
        let timer = Arc::new(DeadlineTimer::default());
        let handle = timer.start(
            {
                let deadline = deadline.clone();
                move || *deadline.lock().unwrap()
            },
            {
                let (deadline, fired) = (deadline.clone(), fired.clone());
                move || {
                    fired.fetch_add(1, Ordering::SeqCst);
                    *deadline.lock().unwrap() = None;
                }
            },
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(fired.load(Ordering::SeqCst), 0);
        *deadline.lock().unwrap() = Some(now_ms() + 30);
        timer.arm();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        handle.abort();
    }
}
