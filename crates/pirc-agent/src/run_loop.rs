//! The run's model/tool progression through [`pirc_agent_loop::Loop`].
//!
//! [`crate::agent::Agent`]'s run stays the host: it builds every request
//! from the session store, streams with its own retries and role fallbacks,
//! persists before `message_end`, runs tools one at a time through the
//! policy chain, admits queues, compacts and waits for completion. This
//! adapter only moves the core through the same steps, so a reply's tool
//! calls are taken from the core's validated batch, each result is fenced
//! by its call key, and the run ends in an explicit terminal state.
//!
//! It also tells the core what the run is doing meanwhile: the streaming
//! reply's snapshot at each content block boundary (a block's end carries
//! its whole content, so a snapshot lags at most the block being streamed),
//! and the waits of the running call (a dialog, the write lease).
//!
//! It emits nothing and writes nothing, so the agent's event trace is the
//! one `pirc-conformance/tests/agent_loop_order.rs` records. The core's
//! history is not used for requests (the session store is the context);
//! it holds the run's own replies and tool results, as the core keeps them.
//! Progress and waits are bookkeeping: one the core refuses (stale, out of
//! order) is dropped, never an error of the run.
//!
//! Where the core is stricter than the agent the agent's behavior wins:
//! - a tool-use reply whose call ids are empty or repeated, or that has no
//!   calls, is still run as listed ([`Reply::Unchecked`]); the core keeps
//!   the reply ([`Loop::supersede`]) and gets the results as the next
//!   request's input, and those calls' waits are not tracked;
//! - an interrupted reply (a message sent now aborted the turn, not the run)
//!   supersedes the request instead of cancelling the core, since the run
//!   continues;
//! - retries happen inside the agent's `stream`, so the core only sees the
//!   final attempt, and a failure never asks it for a retry.

use pirc_agent_loop::{
    CallKey, Failure, FailureKind, Loop, Progress, Recovery, ResumeError, Status, Step, Ticket,
    ToolCall, ToolOutcome, ToolStatus, WaitReason,
};
use pirc_protocol::{AssistantContent, AssistantDelta, AssistantMessage, Message, StopReason};
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// Wait tokens are unique across runs: a dialog may outlive its run, and
/// must not end a wait of the next one.
static NEXT_WAIT: AtomicU64 = AtomicU64::new(1);

/// What a final reply leaves the run to do.
#[derive(Debug, PartialEq)]
pub(crate) enum Reply {
    /// Run these calls in this order; report each with [`RunLoop::tool_result`].
    Tools(Vec<ToolCall>),
    /// Run these `(id, name, arguments)` as listed, outside the core's
    /// fence; report each with [`RunLoop::unchecked_result`].
    Unchecked(Vec<(String, String, Map<String, Value>)>),
    /// Nothing to run (a text reply, a failure or an abort).
    Nothing,
}

/// How a tool call ended, as the run saw it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallEnd {
    /// It ran (successfully or not).
    Ran,
    /// It ran while its turn was aborted: what it did is not known.
    RanAborted,
    /// Not run: the turn was aborted before it.
    Skipped,
}

fn state_error(error: ResumeError) -> String {
    format!("agent loop state: {error}")
}

/// The streaming attempt's snapshot, built from block boundaries.
struct Snapshot {
    ticket: Ticket,
    message: AssistantMessage,
    /// A boundary out of order: no more snapshots for this attempt.
    broken: bool,
}

/// One open wait of a call; several can overlap (a script's operations).
struct OpenWait {
    token: u64,
    key: CallKey,
    reason: WaitReason,
}

pub(crate) struct RunLoop {
    core: Loop,
    generation: u64,
    /// The model request issued and not answered yet.
    pending: Option<Ticket>,
    /// The failed reply the core is suspended on.
    suspended: Option<Ticket>,
    /// Results of unchecked calls, admitted with the next request.
    input: Vec<Message>,
    snapshot: Option<Snapshot>,
    /// The checked call running now, and its provider id.
    running: Option<(CallKey, String)>,
    waits: Vec<OpenWait>,
}

impl RunLoop {
    pub(crate) fn new() -> Self {
        Self {
            core: Loop::new(1, Vec::new()),
            generation: 1,
            pending: None,
            suspended: None,
            input: Vec::new(),
            snapshot: None,
            running: None,
            waits: Vec::new(),
        }
    }

    #[cfg(test)]
    fn status(&self) -> Status {
        self.core.status()
    }

    /// The ticket of the model call about to be made: the one the last
    /// step issued, or a new one from an idle core.
    pub(crate) fn request(&mut self) -> Result<Ticket, String> {
        if let Some(ticket) = self.pending {
            return Ok(ticket);
        }
        let input = std::mem::take(&mut self.input);
        let step = self.core.advance(input).map_err(state_error)?;
        self.issued(step)?;
        self.pending
            .ok_or_else(|| "agent loop state: no model request".to_owned())
    }

    fn issued(&mut self, step: Step) -> Result<(), String> {
        match step {
            Step::Model(request) => self.pending = Some(request.ticket),
            Step::Waiting { .. } => {}
            Step::Suspended(record) => self.suspended = Some(record.ticket),
            other => return Err(format!("agent loop state: unexpected {other:?}")),
        }
        Ok(())
    }

    /// An attempt at the pending request started streaming; `skeleton` is
    /// its message without content. A retry starts over.
    pub(crate) fn attempt(&mut self, skeleton: AssistantMessage) {
        self.snapshot = self.pending.map(|ticket| Snapshot {
            ticket,
            message: AssistantMessage {
                content: Vec::new(),
                ..skeleton
            },
            broken: false,
        });
    }

    /// A streamed delta. Only block starts and ends change the snapshot.
    pub(crate) fn delta(&mut self, delta: &AssistantDelta) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        if snapshot.broken || self.pending != Some(snapshot.ticket) {
            return;
        }
        let (index, block) = match delta {
            AssistantDelta::TextStart { content_index } => (
                content_index,
                AssistantContent::Text {
                    text: String::new(),
                    text_signature: None,
                },
            ),
            AssistantDelta::TextEnd {
                content_index,
                content,
            } => (
                content_index,
                AssistantContent::Text {
                    text: content.clone(),
                    text_signature: None,
                },
            ),
            AssistantDelta::ThinkingStart { content_index } => (
                content_index,
                AssistantContent::Thinking {
                    thinking: String::new(),
                    signature: None,
                    redacted: None,
                },
            ),
            AssistantDelta::ThinkingEnd {
                content_index,
                content,
            } => (
                content_index,
                AssistantContent::Thinking {
                    thinking: content.clone(),
                    signature: None,
                    redacted: None,
                },
            ),
            // Arguments stream as unparsed JSON: empty until the call ends.
            AssistantDelta::ToolcallStart {
                content_index,
                id,
                tool_name,
            } => (
                content_index,
                AssistantContent::ToolCall {
                    id: id.clone(),
                    name: tool_name.clone(),
                    arguments: Map::new(),
                    thought_signature: None,
                },
            ),
            AssistantDelta::ToolcallEnd {
                content_index,
                tool_call,
            } => (content_index, tool_call.clone()),
            AssistantDelta::TextDelta { .. }
            | AssistantDelta::ThinkingDelta { .. }
            | AssistantDelta::ToolcallDelta { .. } => return,
        };
        let index = *index as usize;
        let content = &mut snapshot.message.content;
        let starts = matches!(
            delta,
            AssistantDelta::TextStart { .. }
                | AssistantDelta::ThinkingStart { .. }
                | AssistantDelta::ToolcallStart { .. }
        );
        if starts && index == content.len() {
            content.push(block);
        } else if !starts && index < content.len() {
            content[index] = block;
        } else {
            snapshot.broken = true;
            return;
        }
        let update = Progress {
            ticket: snapshot.ticket,
            delta: delta.clone(),
            partial: snapshot.message.clone(),
        };
        if self.core.progress(update).is_err() {
            snapshot.broken = true;
        }
    }

    #[cfg(test)]
    pub(crate) fn partial(&self) -> Option<&AssistantMessage> {
        self.core.partial()
    }

    /// The final reply to `ticket`. `interrupted`: the turn was aborted
    /// but the run goes on.
    pub(crate) fn reply(
        &mut self,
        ticket: Ticket,
        reply: &AssistantMessage,
        interrupted: bool,
    ) -> Result<Reply, String> {
        if self.pending != Some(ticket) {
            return Err("agent loop state: a reply to no pending request".to_owned());
        }
        self.pending = None;
        self.snapshot = None;
        if reply.stop_reason == StopReason::Aborted && interrupted {
            self.supersede(ticket, reply)?;
            return Ok(Reply::Nothing);
        }
        let failure = (reply.stop_reason == StopReason::Error).then(|| Failure {
            kind: if crate::compaction::is_context_overflow(reply) {
                FailureKind::ContextOverflow
            } else {
                FailureKind::Other
            },
            message: reply.error_message.clone().unwrap_or_default(),
            // The agent's `stream` already retried what it retries.
            retryable: false,
            retry_after_ms: None,
            outcome_unknown: false,
        });
        match self.core.finish_model(ticket, reply.clone(), failure) {
            Ok(Step::Tools(calls)) => Ok(Reply::Tools(calls)),
            Ok(Step::Suspended(record)) => {
                self.suspended = Some(record.ticket);
                Ok(Reply::Nothing)
            }
            Ok(Step::Idle | Step::Done(_)) => Ok(Reply::Nothing),
            Ok(other) => Err(format!("agent loop state: unexpected {other:?}")),
            Err(ResumeError::InvalidCallIds) => {
                self.supersede(ticket, reply)?;
                Ok(Reply::Unchecked(
                    reply
                        .content
                        .iter()
                        .filter_map(|part| match part {
                            AssistantContent::ToolCall {
                                id,
                                name,
                                arguments,
                                ..
                            } => Some((id.clone(), name.clone(), arguments.clone())),
                            _ => None,
                        })
                        .collect(),
                ))
            }
            Err(error) => Err(state_error(error)),
        }
    }

    /// Keep `reply` as the core's record of `ticket`, fenced off: the core
    /// is idle, nothing was dispatched for it.
    fn supersede(&mut self, ticket: Ticket, reply: &AssistantMessage) -> Result<(), String> {
        self.generation += 1;
        self.core
            .supersede(ticket, self.generation, reply.clone())
            .map_err(state_error)?;
        Ok(())
    }

    /// `call` starts running: waits from now on are its own.
    pub(crate) fn start_call(&mut self, call: &ToolCall) {
        self.running = Some((call.key, call.id.clone()));
    }

    /// The running call's key, if `id` is its provider id.
    pub(crate) fn running_call(&self, id: &str) -> Option<CallKey> {
        self.running
            .as_ref()
            .filter(|(_, running)| running == id)
            .map(|(key, _)| *key)
    }

    /// `key` waits for `reason` until [`RunLoop::end_wait`] with the token.
    pub(crate) fn wait(&mut self, key: CallKey, reason: WaitReason) -> Option<u64> {
        self.core.wait_tool(key, reason.clone()).ok()?;
        let token = NEXT_WAIT.fetch_add(1, Ordering::Relaxed);
        self.waits.push(OpenWait { token, key, reason });
        Some(token)
    }

    /// A wait ended; the call still waits for the latest other one, if any.
    pub(crate) fn end_wait(&mut self, token: u64) {
        let Some(at) = self.waits.iter().position(|wait| wait.token == token) else {
            return;
        };
        let key = self.waits.remove(at).key;
        let _ = match self.waits.iter().rev().find(|wait| wait.key == key) {
            Some(other) => self.core.wait_tool(key, other.reason.clone()),
            None => self.core.end_wait(key),
        };
    }

    #[cfg(test)]
    pub(crate) fn waiting(&self) -> Vec<(CallKey, WaitReason)> {
        self.core
            .waiting()
            .into_iter()
            .map(|(key, reason)| (key, reason.clone()))
            .collect()
    }

    /// `call` ended with the recorded tool result `result`.
    pub(crate) fn tool_result(
        &mut self,
        call: &ToolCall,
        result: &Message,
        end: CallEnd,
    ) -> Result<(), String> {
        if self
            .running
            .as_ref()
            .is_some_and(|(key, _)| *key == call.key)
        {
            self.running = None;
        }
        self.waits.retain(|wait| wait.key != call.key);
        let Message::ToolResult {
            content,
            details,
            is_error,
            timestamp,
            ..
        } = result
        else {
            return Err("agent loop state: a tool result that is not one".to_owned());
        };
        let status = match end {
            CallEnd::Skipped => ToolStatus::Interrupted,
            _ if !is_error => ToolStatus::Completed,
            CallEnd::RanAborted => ToolStatus::Unknown,
            CallEnd::Ran => ToolStatus::Failed,
        };
        let outcome = ToolOutcome {
            status,
            content: content.clone(),
            details: details.clone(),
            timestamp: *timestamp,
        };
        let step = self
            .core
            .resume_tool(call.key, outcome)
            .map_err(state_error)?;
        self.issued(step)
    }

    /// An unchecked call's recorded result.
    pub(crate) fn unchecked_result(&mut self, result: Message) {
        self.input.push(result);
    }

    /// The context was compacted after an overflow: the turn runs again.
    pub(crate) fn compacted(&mut self) -> Result<(), String> {
        let ticket = self
            .suspended
            .take()
            .ok_or("agent loop state: compacted without an overflow")?;
        // The session store holds the compacted context; the core keeps
        // the run's record as it is.
        let history = self.core.history().to_vec();
        let step = self
            .core
            .recover(ticket, Recovery::ReplaceHistory(history))
            .map_err(state_error)?;
        self.issued(step)
    }

    /// The run ended: `cancelled` when it was aborted. Work still pending
    /// was never dispatched, so nothing needs aborting.
    pub(crate) fn close(&mut self, cancelled: bool, timestamp: u64) -> Result<(), String> {
        self.pending = None;
        self.input.clear();
        self.snapshot = None;
        self.running = None;
        self.waits.clear();
        if cancelled {
            self.core.cancel(timestamp);
            return Ok(());
        }
        match self.core.status() {
            Status::Idle => {
                self.core.complete().map_err(state_error)?;
            }
            Status::Suspended => {
                let ticket = self
                    .suspended
                    .take()
                    .ok_or("agent loop state: suspended without a ticket")?;
                self.core
                    .recover(ticket, Recovery::Stop)
                    .map_err(state_error)?;
            }
            // A request issued but not made (the turn limit), or calls
            // never reported.
            Status::Streaming | Status::WaitingTools => {
                self.core.cancel(timestamp);
            }
            Status::Done(_) => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
