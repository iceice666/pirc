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
//! It emits nothing and writes nothing, so the agent's event trace is the
//! one `pirc-conformance/tests/agent_loop_order.rs` records. The core's
//! history is not used for requests (the session store is the context);
//! it holds the run's own replies and tool results, as the core keeps them.
//!
//! Where the core is stricter than the agent the agent's behavior wins:
//! - a tool-use reply whose call ids are empty or repeated, or that has no
//!   calls, is still run as listed ([`Reply::Unchecked`]); the core is
//!   rebound past it and gets the results as the next request's input;
//! - an interrupted reply (a message sent now aborted the turn, not the run)
//!   rebinds the core instead of cancelling it, since the run continues;
//! - retries happen inside the agent's `stream`, so the core only sees the
//!   final attempt, and a failure never asks it for a retry.

use pirc_agent_loop::{
    Failure, FailureKind, Loop, Recovery, ResumeError, Status, Step, Ticket, ToolCall, ToolOutcome,
    ToolStatus,
};
use pirc_protocol::{AssistantContent, AssistantMessage, Message, StopReason};
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
}

impl RunLoop {
    pub(crate) fn new() -> Self {
        Self {
            core: Loop::new(1, Vec::new()),
            generation: 1,
            pending: None,
            suspended: None,
            input: Vec::new(),
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
            self.rebind(reply)?;
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
                self.rebind(reply)?;
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

    /// Fence the streaming request off and keep `reply` as the core's
    /// record of it: the core is idle, nothing was dispatched.
    fn rebind(&mut self, reply: &AssistantMessage) -> Result<(), String> {
        self.generation += 1;
        let at = reply.completed_at.unwrap_or(reply.timestamp);
        self.core
            .rebind(self.generation, Message::Assistant(reply.clone()), at)
            .map_err(state_error)?;
        Ok(())
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
mod tests {
    use super::*;
    use pirc_agent_loop::TerminalReason;
    use pirc_protocol::UserBlock;
    use serde_json::json;

    fn reply(stop: StopReason, content: Vec<AssistantContent>) -> AssistantMessage {
        AssistantMessage {
            content,
            api: "openai-completions".to_owned(),
            provider: "fake".to_owned(),
            model: "fake-model".to_owned(),
            usage: crate::messages::empty_usage(),
            stop_reason: stop,
            error_message: None,
            timestamp: 1,
            completed_at: Some(2),
            canonical_provider: None,
            response_id: None,
            response_model: None,
        }
    }

    fn text(text: &str) -> AssistantContent {
        AssistantContent::Text {
            text: text.to_owned(),
            text_signature: None,
        }
    }

    fn call(id: &str) -> AssistantContent {
        AssistantContent::ToolCall {
            id: id.to_owned(),
            name: "read".to_owned(),
            arguments: json!({ "path": id }).as_object().unwrap().clone(),
            thought_signature: None,
        }
    }

    fn result(id: &str, is_error: bool) -> Message {
        Message::ToolResult {
            tool_call_id: id.to_owned(),
            tool_name: "read".to_owned(),
            content: vec![UserBlock::Text {
                text: format!("result of {id}"),
                text_signature: None,
            }],
            details: None,
            is_error,
            timestamp: 3,
        }
    }

    fn tools(run: &mut RunLoop, ids: &[&str]) -> Vec<ToolCall> {
        let ticket = run.request().unwrap();
        let content = ids.iter().map(|id| call(id)).collect();
        match run
            .reply(ticket, &reply(StopReason::ToolUse, content), false)
            .unwrap()
        {
            Reply::Tools(calls) => calls,
            other => panic!("not a tool batch: {other:?}"),
        }
    }

    #[test]
    fn a_tool_round_then_a_text_reply_completes() {
        let mut run = RunLoop::new();
        let calls = tools(&mut run, &["a", "b"]);
        assert_eq!(
            calls.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        run.tool_result(&calls[0], &result("a", false), CallEnd::Ran)
            .unwrap();
        assert_eq!(run.status(), Status::WaitingTools);
        run.tool_result(&calls[1], &result("b", true), CallEnd::Ran)
            .unwrap();
        // The next request was issued by the last result.
        let next = run.request().unwrap();
        assert_eq!(run.request().unwrap(), next);
        let done = run
            .reply(next, &reply(StopReason::Stop, vec![text("Done.")]), false)
            .unwrap();
        assert_eq!(done, Reply::Nothing);
        assert_eq!(run.status(), Status::Idle);
        run.close(false, 9).unwrap();
        assert_eq!(run.status(), Status::Done(TerminalReason::Completed));
        let records = run.core.tool_records();
        assert_eq!(records[0].outcome.status, ToolStatus::Completed);
        assert_eq!(records[1].outcome.status, ToolStatus::Failed);
    }

    #[test]
    fn a_result_is_accepted_once_and_only_for_its_batch() {
        let mut run = RunLoop::new();
        let calls = tools(&mut run, &["a"]);
        run.tool_result(&calls[0], &result("a", false), CallEnd::Ran)
            .unwrap();
        let error = run
            .tool_result(&calls[0], &result("a", false), CallEnd::Ran)
            .unwrap_err();
        assert!(error.starts_with("agent loop state:"), "{error}");
        assert!(
            run.tool_result(&calls[0], &json_text(), CallEnd::Ran)
                .is_err()
        );
    }

    fn json_text() -> Message {
        Message::User {
            content: pirc_protocol::UserContent::Text("x".to_owned()),
            timestamp: 1,
        }
    }

    #[test]
    fn interrupted_calls_and_an_aborted_running_call() {
        let mut run = RunLoop::new();
        let calls = tools(&mut run, &["a", "b"]);
        run.tool_result(&calls[0], &result("a", true), CallEnd::RanAborted)
            .unwrap();
        run.tool_result(&calls[1], &result("b", true), CallEnd::Skipped)
            .unwrap();
        let statuses: Vec<ToolStatus> = run
            .core
            .tool_records()
            .iter()
            .map(|r| r.outcome.status)
            .collect();
        assert_eq!(statuses, [ToolStatus::Unknown, ToolStatus::Interrupted]);
        // The run was aborted before its next model call.
        run.close(true, 9).unwrap();
        assert_eq!(run.status(), Status::Done(TerminalReason::Cancelled));
    }

    #[test]
    fn an_interrupted_reply_rebinds_and_the_run_goes_on() {
        let mut run = RunLoop::new();
        let first = run.request().unwrap();
        let aborted = reply(StopReason::Aborted, vec![text("Partial")]);
        assert_eq!(run.reply(first, &aborted, true).unwrap(), Reply::Nothing);
        assert_eq!(run.status(), Status::Idle);
        let second = run.request().unwrap();
        assert_ne!(first.generation(), second.generation());
        // A late answer to the old request is refused.
        assert!(run.reply(first, &aborted, false).is_err());
        run.reply(second, &reply(StopReason::Stop, vec![text("Ok")]), false)
            .unwrap();
        assert_eq!(run.core.history().len(), 2);
    }

    #[test]
    fn an_aborted_run_cancels_the_core() {
        let mut run = RunLoop::new();
        let ticket = run.request().unwrap();
        run.reply(ticket, &reply(StopReason::Aborted, Vec::new()), false)
            .unwrap();
        assert_eq!(run.status(), Status::Done(TerminalReason::Cancelled));
        run.close(true, 9).unwrap();
        run.close(false, 9).unwrap();
    }

    #[test]
    fn calls_the_core_rejects_still_run_as_listed() {
        for content in [
            vec![call("a"), call("a")],
            vec![call("")],
            vec![text("no calls")],
        ] {
            let mut run = RunLoop::new();
            let ticket = run.request().unwrap();
            let listed: Vec<String> = content
                .iter()
                .filter_map(|part| match part {
                    AssistantContent::ToolCall { id, .. } => Some(id.clone()),
                    _ => None,
                })
                .collect();
            let Reply::Unchecked(calls) = run
                .reply(ticket, &reply(StopReason::ToolUse, content), false)
                .unwrap()
            else {
                panic!("not unchecked");
            };
            assert_eq!(
                calls
                    .iter()
                    .map(|(id, _, _)| id.clone())
                    .collect::<Vec<_>>(),
                listed
            );
            for id in &listed {
                run.unchecked_result(result(id, false));
            }
            let next = run.request().unwrap();
            assert_eq!(next.generation(), 2);
            // The reply and its results are in the core's record.
            assert_eq!(run.core.history().len(), 1 + listed.len());
        }
    }

    #[test]
    fn an_overflow_is_compacted_once_or_stops() {
        let mut overflow = reply(StopReason::Error, Vec::new());
        overflow.error_message = Some("context length exceeded".to_owned());
        let mut run = RunLoop::new();
        let ticket = run.request().unwrap();
        assert_eq!(run.reply(ticket, &overflow, false).unwrap(), Reply::Nothing);
        assert_eq!(run.status(), Status::Suspended);
        run.compacted().unwrap();
        let again = run.request().unwrap();
        run.reply(again, &overflow, false).unwrap();
        run.close(false, 9).unwrap();
        assert_eq!(run.status(), Status::Done(TerminalReason::Failed));
        let kinds: Vec<FailureKind> = run.core.failures().iter().map(|f| f.failure.kind).collect();
        assert_eq!(kinds, [FailureKind::ContextOverflow; 2]);

        // Any other failure cannot be compacted.
        let mut run = RunLoop::new();
        let ticket = run.request().unwrap();
        let mut failed = reply(StopReason::Error, Vec::new());
        failed.error_message = Some("HTTP 400".to_owned());
        run.reply(ticket, &failed, false).unwrap();
        assert!(run.compacted().is_err());
    }

    #[test]
    fn a_request_never_made_is_cancelled_at_the_end() {
        let mut run = RunLoop::new();
        let calls = tools(&mut run, &["a"]);
        run.tool_result(&calls[0], &result("a", false), CallEnd::Ran)
            .unwrap();
        run.close(false, 9).unwrap();
        assert_eq!(run.status(), Status::Done(TerminalReason::Cancelled));
    }
}
