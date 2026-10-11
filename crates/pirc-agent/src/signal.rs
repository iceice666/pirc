//! `AbortController` / `AbortSignal` for the single-threaded agent.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use tokio::sync::Notify;

struct State {
    aborted: Cell<bool>,
    notify: Notify,
    listeners: RefCell<Vec<Listener>>,
}

/// What runs on abort, in the order added.
enum Listener {
    Call(Box<dyn FnOnce()>),
    /// A dependent signal, held weakly (as `AbortSignal.any` holds its
    /// dependents): once it is gone, the entry is pruned instead of
    /// accumulating on a long-lived signal.
    Child(Weak<State>),
}

/// Aborts its [`AbortSignal`] (`AbortController`).
#[derive(Clone)]
pub struct AbortController(Rc<State>);

/// Whether, and when, an operation was aborted (`AbortSignal`).
#[derive(Clone)]
pub struct AbortSignal(Rc<State>);

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortController {
    pub fn new() -> Self {
        Self(Rc::new(State {
            aborted: Cell::new(false),
            notify: Notify::new(),
            listeners: RefCell::new(Vec::new()),
        }))
    }

    pub fn signal(&self) -> AbortSignal {
        AbortSignal(self.0.clone())
    }

    /// Abort once; listeners run in the order they were added.
    pub fn abort(&self) {
        if self.0.aborted.replace(true) {
            return;
        }
        self.0.notify.notify_waiters();
        let listeners = std::mem::take(&mut *self.0.listeners.borrow_mut());
        for listener in listeners {
            match listener {
                Listener::Call(call) => call(),
                Listener::Child(child) => {
                    if let Some(state) = child.upgrade() {
                        AbortController(state).abort();
                    }
                }
            }
        }
    }

    /// A controller aborted when `parent` is (`AbortSignal.any([parent])`
    /// with its own `abort`).
    pub fn child_of(parent: &AbortSignal) -> Self {
        let child = Self::new();
        parent.add_child(&child);
        child
    }
}

impl AbortSignal {
    /// A signal that never aborts.
    pub fn never() -> Self {
        AbortController::new().signal()
    }

    pub fn aborted(&self) -> bool {
        self.0.aborted.get()
    }

    /// Run `listener` when aborted (at once if it already is).
    pub fn on_abort(&self, listener: impl FnOnce() + 'static) {
        if self.aborted() {
            listener();
        } else {
            self.push(Listener::Call(Box::new(listener)));
        }
    }

    /// `AbortSignal.any(signals)`: aborted once any of them is, without
    /// keeping anything alive on them.
    pub fn any(signals: &[&AbortSignal]) -> AbortSignal {
        let combined = AbortController::new();
        for signal in signals {
            signal.add_child(&combined);
        }
        combined.signal()
    }

    fn add_child(&self, child: &AbortController) {
        if self.aborted() {
            child.abort();
        } else {
            self.push(Listener::Child(Rc::downgrade(&child.0)));
        }
    }

    fn push(&self, listener: Listener) {
        let mut listeners = self.0.listeners.borrow_mut();
        listeners.retain(|entry| match entry {
            Listener::Child(child) => child.strong_count() > 0,
            Listener::Call(_) => true,
        });
        listeners.push(listener);
    }

    /// Resolves once aborted.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.notify.notified();
            if self.aborted() {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependents_do_not_accumulate_on_a_long_lived_signal() {
        let lifetime = AbortController::new();
        for _ in 0..1000 {
            let call = AbortController::new();
            let combined = AbortSignal::any(&[&lifetime.signal(), &call.signal()]);
            assert!(!combined.aborted());
        }
        assert!(lifetime.0.listeners.borrow().len() <= 1);
        let call = AbortController::new();
        let combined = AbortSignal::any(&[&lifetime.signal(), &call.signal()]);
        lifetime.abort();
        assert!(combined.aborted());
        let late = AbortSignal::any(&[&lifetime.signal()]);
        assert!(late.aborted());
    }

    #[tokio::test]
    async fn aborts_once_and_reaches_children() {
        let parent = AbortController::new();
        let child = AbortController::child_of(&parent.signal());
        let calls = Rc::new(Cell::new(0));
        let counter = calls.clone();
        child
            .signal()
            .on_abort(move || counter.set(counter.get() + 1));
        let waiting = child.signal();
        let wait = tokio::task::LocalSet::new();
        wait.run_until(async move {
            let handle = tokio::task::spawn_local(async move { waiting.cancelled().await });
            tokio::task::yield_now().await;
            parent.abort();
            parent.abort();
            handle.await.unwrap();
        })
        .await;
        assert_eq!(calls.get(), 1);
        assert!(child.signal().aborted());
        let late = Rc::new(Cell::new(false));
        let flag = late.clone();
        child.signal().on_abort(move || flag.set(true));
        assert!(late.get());
    }
}
