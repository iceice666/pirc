//! Runtime-neutral wait bookkeeping. Waits describe pending calls, never permission
//! to dispatch them: the host still owns approval, cancellation and resources.

use std::sync::Arc;

use crate::{CallKey, Loop, ResumeError, State};

/// Host-specific reason a call is still pending, not a failed result or approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitReason {
    Approval,
    Resource(String),
    Other(String),
}

/// One independently endable wait of one call in one live [Loop].
///
/// This is not a durable identifier or an authorization. Clones refer to the
/// same wait; finishing any clone ends it once. Tokens from another loop, an
/// invalidated call or an earlier run cannot finish a new wait, even when the
/// loops use identical generations and call keys. Dropping a token does not end
/// the wait: the host explicitly calls [Loop::finish_wait].
#[derive(Clone, Debug)]
pub struct WaitToken {
    key: CallKey,
    // Keep the allocation alive in stale tokens, so its identity cannot be
    // reused while a late callback can still present it. No global counter,
    // process identity, runtime, or overflow handling is needed.
    identity: Arc<()>,
}

impl PartialEq for WaitToken {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key && Arc::ptr_eq(&self.identity, &other.identity)
    }
}

impl Eq for WaitToken {}

#[derive(Debug)]
struct OpenWait {
    // None denotes the compatibility wait_tool/end_wait slot.
    identity: Option<Arc<()>>,
    reason: WaitReason,
}

#[derive(Debug, Default)]
pub(crate) struct Waits(Vec<OpenWait>);

impl Waits {
    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }

    fn end_legacy(&mut self) {
        self.0.retain(|wait| wait.identity.is_some());
    }

    fn latest(&self) -> Option<&WaitReason> {
        self.0.last().map(|wait| &wait.reason)
    }
}

impl Loop {
    /// Begin an independent wait. Several reasons may overlap on the same call,
    /// including identical reasons. Only the returned token ends this wait.
    pub fn begin_wait(
        &mut self,
        key: CallKey,
        reason: WaitReason,
    ) -> Result<WaitToken, ResumeError> {
        let call = self.pending_tool(key)?;
        let identity = Arc::new(());
        call.waits.0.push(OpenWait {
            identity: Some(Arc::clone(&identity)),
            reason,
        });
        Ok(WaitToken { key, identity })
    }

    /// End exactly this wait, leaving other waits and the call pending.
    /// Returns false for a foreign, stale or already finished token, without
    /// changing any state. A successful result/cancel/rebind also ends waits.
    pub fn finish_wait(&mut self, token: &WaitToken) -> bool {
        let Ok(call) = self.pending_tool(token.key) else {
            return false;
        };
        let Some(at) = call.waits.0.iter().position(|wait| {
            wait.identity
                .as_ref()
                .is_some_and(|identity| Arc::ptr_eq(identity, &token.identity))
        }) else {
            return false;
        };
        call.waits.0.remove(at);
        true
    }

    /// Set the compatibility wait slot, replacing only the previous wait set by
    /// this method. Tokenized waits are independent and are never replaced.
    /// Use [Loop::begin_wait] when reasons can overlap.
    pub fn wait_tool(&mut self, key: CallKey, reason: WaitReason) -> Result<(), ResumeError> {
        let call = self.pending_tool(key)?;
        call.waits.end_legacy();
        call.waits.0.push(OpenWait {
            identity: None,
            reason,
        });
        Ok(())
    }

    /// End only the compatibility wait set by [Loop::wait_tool]. The call and
    /// any tokenized waits stay pending. Ending an empty slot is harmless.
    pub fn end_wait(&mut self, key: CallKey) -> Result<(), ResumeError> {
        self.pending_tool(key)?.waits.end_legacy();
        Ok(())
    }

    /// Latest still-open reason for each waiting call, in call order.
    /// See [Loop::waiting_all] for every overlapping reason.
    pub fn waiting(&self) -> Vec<(CallKey, &WaitReason)> {
        match &self.state {
            State::Tools { calls, .. } => calls
                .iter()
                .filter_map(|call| call.waits.latest().map(|reason| (call.call.key, reason)))
                .collect(),
            _ => Vec::new(),
        }
    }

    /// All still-open reasons, in call order and then wait creation order.
    /// Identical reasons are preserved as separate waits.
    pub fn waiting_all(&self) -> Vec<(CallKey, &WaitReason)> {
        match &self.state {
            State::Tools { calls, .. } => calls
                .iter()
                .flat_map(|call| {
                    call.waits
                        .0
                        .iter()
                        .map(|wait| (call.call.key, &wait.reason))
                })
                .collect(),
            _ => Vec::new(),
        }
    }
}
