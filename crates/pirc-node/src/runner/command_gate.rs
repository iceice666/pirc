//! Preserve command ordering while allowing Stop to interrupt admission hooks.
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Mutex, MutexGuard, Notify};

#[derive(Default)]
pub(super) struct CommandGate {
    lock: Mutex<()>,
    admitting: AtomicBool,
    changed: Notify,
}
impl CommandGate {
    pub(super) async fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().await
    }
    #[cfg(test)]
    pub(super) fn try_lock(&self) -> Result<MutexGuard<'_, ()>, tokio::sync::TryLockError> {
        self.lock.try_lock()
    }

    /// Only Stop/deletion may overtake a queued prompt awaiting admission.
    /// Wake a Stop that arrived during preparation once the prompt is queued.
    pub(super) async fn stop_lock(&self) -> Option<MutexGuard<'_, ()>> {
        loop {
            let changed = self.changed.notified();
            if self.admitting.load(Ordering::Acquire) {
                return None;
            }
            tokio::select! {
                guard = self.lock.lock() => return Some(guard),
                _ = changed => {},
            }
        }
    }

    /// Caller holds the ordinary lock and has already queued its RPC line.
    pub(super) fn admission(&self) -> AdmissionWait<'_> {
        self.admitting.store(true, Ordering::Release);
        self.changed.notify_waiters();
        AdmissionWait(self)
    }
}
pub(super) struct AdmissionWait<'a>(&'a CommandGate);
impl Drop for AdmissionWait<'_> {
    fn drop(&mut self) {
        self.0.admitting.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stop_waiting_during_preparation_wakes_only_after_rpc_is_queued() {
        let gate = CommandGate::default();
        let held = gate.lock().await;
        let stop = gate.stop_lock();
        tokio::pin!(stop);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut stop)
                .await
                .is_err()
        );
        let admission = gate.admission();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), &mut stop)
                .await
                .unwrap()
                .is_none()
        );
        assert!(gate.try_lock().is_err());
        drop(admission);
        drop(held);
        assert!(gate.stop_lock().await.is_some());
    }
}
