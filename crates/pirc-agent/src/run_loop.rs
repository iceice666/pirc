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
//! It also tells the core what the run is doing meanwhile: each streamed
//! delta, from which the core builds the attempt's partial reply at block
//! boundaries ([`pirc_agent_loop::Partial`]), and the waits of the running
//! call (a dialog, the write lease).
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
    CallKey, Failure, Loop, Recovery, ResumeError, Status, Step, Ticket, ToolCall, ToolOutcome,
    ToolStatus, WaitReason, WaitToken,
};
use pirc_protocol::{AssistantContent, AssistantDelta, AssistantMessage, Message, StopReason};
use serde_json::{Map, Value};

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

pub(crate) struct RunLoop {
    core: Loop,
    generation: u64,
    /// The model request issued and not answered yet.
    pending: Option<Ticket>,
    /// The failed reply the core is suspended on.
    suspended: Option<Ticket>,
    /// Results of unchecked calls, admitted with the next request.
    input: Vec<Message>,
    /// The checked call running now, and its provider id.
    running: Option<(CallKey, String)>,
}

impl RunLoop {
    pub(crate) fn new() -> Self {
        Self {
            core: Loop::new(1, Vec::new()),
            generation: 1,
            pending: None,
            suspended: None,
            input: Vec::new(),
            running: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn status(&self) -> Status {
        self.core.status()
    }

    /// The core's outcome of each call so far, in call order.
    #[cfg(test)]
    pub(crate) fn tool_statuses(&self) -> Vec<ToolStatus> {
        self.core
            .tool_records()
            .iter()
            .map(|record| record.outcome.status)
            .collect()
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
        if let Some(ticket) = self.pending {
            let _ = self.core.stream_start(ticket, skeleton);
        }
    }

    /// A streamed delta of the attempt.
    pub(crate) fn delta(&mut self, delta: &AssistantDelta) {
        if let Some(ticket) = self.pending {
            let _ = self.core.stream_delta(ticket, delta);
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
        if reply.stop_reason == StopReason::Aborted && interrupted {
            self.supersede(ticket, reply)?;
            return Ok(Reply::Nothing);
        }
        // `retryable` is the message's class; the agent's `stream` already
        // retried what it retries, so the core is never asked to.
        let failure = Failure::of_reply(reply);
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
    pub(crate) fn wait(&mut self, key: CallKey, reason: WaitReason) -> Option<WaitToken> {
        self.core.begin_wait(key, reason).ok()
    }

    /// A wait ended; other waits of this call remain open.
    pub(crate) fn end_wait(&mut self, token: &WaitToken) {
        self.core.finish_wait(token);
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
        if self
            .running
            .as_ref()
            .is_some_and(|(key, _)| *key == call.key)
        {
            self.running = None;
        }
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
        self.running = None;
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
