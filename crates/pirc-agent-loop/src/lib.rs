//! A runtime-neutral, host-driven model/tool state machine.
//!
//! Effects are returned once per accepted transition in one live instance, never
//! executed here. There is no durable exactly-once guarantee. The host owns scheduling,
//! approval, locks, cancellation signals, persistence, redaction and all external
//! authority. A ticket fences callbacks, not external side effects: the host must
//! also check generation immediately before dispatch and abort obsolete operations.
//! See the crate README for checkpoint scope and adapter contracts.

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use pirc_llm_types::{
    AssistantContent, AssistantDelta, AssistantMessage, Message, StopReason, UserBlock,
};
use serde_json::{Map, Value};

mod failure;
pub mod history;
mod partial;

pub use failure::{is_context_overflow, is_retryable};
pub use partial::Partial;

/// Opaque correlation identifier, scoped to one live [Loop]. Not a durable ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Ticket {
    generation: u64,
    sequence: u64,
}

impl Ticket {
    pub fn generation(self) -> u64 {
        self.generation
    }
}

/// Distinguishes parallel calls even if a provider later reuses an ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CallKey {
    pub model: Ticket,
    pub index: usize,
}

/// One model effect. Host adds model configuration, prompt and tool definitions.
///
/// `messages` is the history when the request was issued, shared with the
/// core rather than copied: the core copies it only if it must grow while a
/// request still holds it. A host that builds its context elsewhere drops
/// the request and pays nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRequest {
    pub ticket: Ticket,
    pub messages: Arc<Vec<Message>>,
}

/// A requested tool effect. The provider ID is preserved in subsequent history.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub key: CallKey,
    pub id: String,
    pub name: String,
    pub arguments: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Completed,
    Denied,
    Interrupted,
    Failed,
    /// An effect may have occurred. Never automatically reissued by this loop.
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutcome {
    pub status: ToolStatus,
    pub content: Vec<UserBlock>,
    pub details: Option<Value>,
    pub timestamp: u64,
}

/// Why a call was not run at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotRun {
    /// The run was aborted before it.
    Aborted,
    /// Its turn was interrupted before it: the user sent a message.
    Interrupted,
}

impl ToolOutcome {
    /// The outcome of a call that was not run, as the model is told.
    pub fn not_run(reason: NotRun, timestamp: u64) -> Self {
        let text = match reason {
            NotRun::Aborted => "Aborted by the user before this tool ran.",
            NotRun::Interrupted => "Interrupted: the user sent a message before this tool ran.",
        };
        Self {
            status: ToolStatus::Interrupted,
            content: vec![UserBlock::Text {
                text: text.to_owned(),
                text_signature: None,
            }],
            details: None,
            timestamp,
        }
    }

    /// This outcome as the tool result message of call `id` of tool `name`:
    /// an error unless the call completed.
    pub fn message(&self, id: &str, name: &str) -> Message {
        Message::ToolResult {
            tool_call_id: id.to_owned(),
            tool_name: name.to_owned(),
            content: self.content.clone(),
            details: self.details.clone(),
            is_error: self.status != ToolStatus::Completed,
            timestamp: self.timestamp,
        }
    }
}

/// Host-specific reason a call is still pending, not a failed result or approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitReason {
    Approval,
    Resource(String),
    Other(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    Transport,
    RateLimited,
    ContextOverflow,
    InvalidResponse,
    Other,
}

/// May contain raw provider information. Hosts must redact before publication.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub kind: FailureKind,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    /// If true, retry is refused even if retryable was set by the adapter.
    pub outcome_unknown: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FailureRecord {
    pub ticket: Ticket,
    pub failure: Failure,
    pub partial: Option<AssistantMessage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalReason {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No model/tools pending. The host may continue or explicitly complete.
    Idle,
    Streaming,
    WaitingTools,
    Suspended,
    Done(TerminalReason),
}

/// A transition returns new effects, not a repeatable polling instruction.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Model(ModelRequest),
    Tools(Vec<ToolCall>),
    Waiting { remaining: usize },
    Idle,
    Suspended(Box<FailureRecord>),
    Done(TerminalReason),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub ticket: Ticket,
    pub delta: AssistantDelta,
    /// Full canonical snapshot supplied by the adapter, not appended delta text.
    pub partial: AssistantMessage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolRecord {
    pub call: ToolCall,
    pub outcome: ToolOutcome,
}

/// Operations the host must abort. This does NOT claim external effects stopped.
#[derive(Clone, Debug, PartialEq)]
pub struct Invalidation {
    pub model: Option<Ticket>,
    pub tools: Vec<CallKey>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Recovery {
    /// Explicit host retry, only if safe metadata and no partial content.
    Retry,
    /// Host-owned compaction; only for a context-overflow suspension.
    ReplaceHistory(Vec<Message>),
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResumeError {
    WrongState,
    StaleGeneration,
    StaleTicket,
    UnknownCall,
    DuplicateResult,
    InvalidCallIds,
    InvalidGeneration,
    UnsafeRetry,
    SequenceExhausted,
}

impl fmt::Display for ResumeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ResumeError {}

#[derive(Debug)]
struct PendingTool {
    call: ToolCall,
    wait: Option<WaitReason>,
    outcome: Option<ToolOutcome>,
}

#[derive(Debug)]
enum State {
    Idle,
    Streaming {
        ticket: Ticket,
        partial: Option<Partial>,
    },
    Tools {
        ticket: Ticket,
        calls: Vec<PendingTool>,
    },
    Suspended(FailureRecord),
    Done(TerminalReason),
}

/// In-memory progression only. It neither spawns tasks nor reads environment/files.
/// No Send/Sync bounds: a host may keep it in Rc/RefCell or move it across threads.
#[derive(Debug)]
pub struct Loop {
    generation: u64,
    sequence: u64,
    state: State,
    /// Shared with issued requests; copied on write only while one holds it.
    history: Arc<Vec<Message>>,
    tool_records: Vec<ToolRecord>,
    failures: Vec<FailureRecord>,
}

impl Loop {
    pub fn new(generation: u64, history: Vec<Message>) -> Self {
        Self {
            generation,
            sequence: 0,
            state: State::Idle,
            history: Arc::new(history),
            tool_records: Vec::new(),
            failures: Vec::new(),
        }
    }

    pub fn status(&self) -> Status {
        match &self.state {
            State::Idle => Status::Idle,
            State::Streaming { .. } => Status::Streaming,
            State::Tools { .. } => Status::WaitingTools,
            State::Suspended(_) => Status::Suspended,
            State::Done(reason) => Status::Done(*reason),
        }
    }

    pub fn history(&self) -> &[Message] {
        &self.history
    }

    fn history_mut(&mut self) -> &mut Vec<Message> {
        Arc::make_mut(&mut self.history)
    }

    pub fn tool_records(&self) -> &[ToolRecord] {
        &self.tool_records
    }

    pub fn failures(&self) -> &[FailureRecord] {
        &self.failures
    }

    pub fn partial(&self) -> Option<&AssistantMessage> {
        match &self.state {
            State::Streaming { partial, .. } => partial.as_ref().map(Partial::message),
            State::Suspended(record) => record.partial.as_ref(),
            _ => None,
        }
    }

    /// Admit host input only at an idle boundary and request one model call.
    pub fn advance(&mut self, input: Vec<Message>) -> Result<Step, ResumeError> {
        if !matches!(self.state, State::Idle) {
            return Err(ResumeError::WrongState);
        }
        self.ensure_sequence()?;
        self.history_mut().extend(input);
        Ok(self.request_model())
    }

    /// Streaming progress never authorizes tools. The final snapshot is canonical.
    /// The adapter owns delta/snapshot consistency and must supply ordered updates.
    pub fn progress(&mut self, update: Progress) -> Result<Progress, ResumeError> {
        self.check_ticket(update.ticket)?;
        let State::Streaming { partial, .. } = &mut self.state else {
            return Err(ResumeError::WrongState);
        };
        *partial = Some(Partial::snapshot(update.partial.clone()));
        Ok(update)
    }

    /// An attempt at the request started streaming; `skeleton` is its reply
    /// without content. The core builds the partial from the deltas given
    /// to [`Loop::stream_delta`] (see [`Partial`]), so the host copies
    /// nothing per delta. A retry starts over.
    pub fn stream_start(
        &mut self,
        ticket: Ticket,
        skeleton: AssistantMessage,
    ) -> Result<(), ResumeError> {
        self.check_ticket(ticket)?;
        let State::Streaming { partial, .. } = &mut self.state else {
            return Err(ResumeError::WrongState);
        };
        *partial = Some(Partial::new(skeleton));
        Ok(())
    }

    /// A delta of the attempt [`Loop::stream_start`] began: whether it
    /// changed the partial (a content delta does not, nor does anything
    /// after a boundary out of order, nor a delta of no attempt).
    pub fn stream_delta(
        &mut self,
        ticket: Ticket,
        delta: &AssistantDelta,
    ) -> Result<bool, ResumeError> {
        self.check_ticket(ticket)?;
        let State::Streaming { partial, .. } = &mut self.state else {
            return Err(ResumeError::WrongState);
        };
        Ok(partial.as_mut().is_some_and(|partial| partial.apply(delta)))
    }

    /// Complete a model request. Duplicate/stale replies cannot issue tools again.
    /// Bad call IDs are rejected atomically; host can then fail or cancel the stream.
    pub fn finish_model(
        &mut self,
        ticket: Ticket,
        reply: AssistantMessage,
        failure: Option<Failure>,
    ) -> Result<Step, ResumeError> {
        self.check_ticket(ticket)?;
        if !matches!(self.state, State::Streaming { .. }) {
            return Err(ResumeError::WrongState);
        }
        if reply.stop_reason == StopReason::Aborted {
            self.history_mut().push(Message::Assistant(reply));
            self.state = State::Done(TerminalReason::Cancelled);
            return Ok(Step::Done(TerminalReason::Cancelled));
        }
        if failure.is_some() || reply.stop_reason == StopReason::Error {
            let failure = failure.unwrap_or_else(|| Failure {
                kind: FailureKind::Other,
                message: reply.error_message.clone().unwrap_or_default(),
                retryable: false,
                retry_after_ms: None,
                outcome_unknown: false,
            });
            return Ok(self.suspend(ticket, failure, Some(reply)));
        }
        let mut calls = Vec::new();
        if reply.stop_reason == StopReason::ToolUse {
            let mut ids = HashSet::new();
            for part in &reply.content {
                if let AssistantContent::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                } = part
                {
                    if id.is_empty() || !ids.insert(id) {
                        return Err(ResumeError::InvalidCallIds);
                    }
                    calls.push(ToolCall {
                        key: CallKey {
                            model: ticket,
                            index: calls.len(),
                        },
                        id: id.clone(),
                        name: name.clone(),
                        arguments: arguments.clone(),
                    });
                }
            }
            if calls.is_empty() {
                return Err(ResumeError::InvalidCallIds);
            }
        }
        self.history_mut().push(Message::Assistant(reply));
        if calls.is_empty() {
            self.state = State::Idle;
            Ok(Step::Idle)
        } else {
            self.state = State::Tools {
                ticket,
                calls: calls
                    .iter()
                    .cloned()
                    .map(|call| PendingTool {
                        call,
                        wait: None,
                        outcome: None,
                    })
                    .collect(),
            };
            Ok(Step::Tools(calls))
        }
    }

    /// Transport failure without a final reply preserves the latest partial/usage.
    pub fn fail_model(&mut self, ticket: Ticket, failure: Failure) -> Result<Step, ResumeError> {
        self.check_ticket(ticket)?;
        let State::Streaming { partial, .. } = &self.state else {
            return Err(ResumeError::WrongState);
        };
        let partial = partial.as_ref().map(Partial::message).cloned();
        Ok(self.suspend(ticket, failure, partial))
    }

    pub fn wait_tool(&mut self, key: CallKey, reason: WaitReason) -> Result<(), ResumeError> {
        let call = self.pending_tool(key)?;
        call.wait = Some(reason);
        Ok(())
    }

    /// The call no longer waits (its approval was answered, its resource
    /// acquired). It is still pending; only a result ends it.
    pub fn end_wait(&mut self, key: CallKey) -> Result<(), ResumeError> {
        self.pending_tool(key)?.wait = None;
        Ok(())
    }

    pub fn waiting(&self) -> Vec<(CallKey, &WaitReason)> {
        match &self.state {
            State::Tools { calls, .. } => calls
                .iter()
                .filter_map(|call| call.wait.as_ref().map(|reason| (call.call.key, reason)))
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Results can arrive in any order; conversation results retain call order.
    /// Returns the next model effect only after every call has a terminal result.
    pub fn resume_tool(&mut self, key: CallKey, outcome: ToolOutcome) -> Result<Step, ResumeError> {
        self.ensure_sequence()?;
        let call = self.pending_tool(key)?;
        call.wait = None;
        call.outcome = Some(outcome);
        let State::Tools { calls, .. } = &self.state else {
            unreachable!()
        };
        let remaining = calls.iter().filter(|call| call.outcome.is_none()).count();
        if remaining != 0 {
            return Ok(Step::Waiting { remaining });
        }
        let State::Tools { calls, .. } = std::mem::replace(&mut self.state, State::Idle) else {
            unreachable!()
        };
        for call in calls {
            self.record_tool(call.call, call.outcome.expect("all results checked"));
        }
        Ok(self.request_model())
    }

    /// No implicit sleeps/retries: the host decides when/how to resume failures.
    pub fn recover(&mut self, ticket: Ticket, recovery: Recovery) -> Result<Step, ResumeError> {
        self.check_ticket(ticket)?;
        let State::Suspended(record) = &self.state else {
            return Err(ResumeError::WrongState);
        };
        match recovery {
            Recovery::Stop => {
                self.state = State::Done(TerminalReason::Failed);
                Ok(Step::Done(TerminalReason::Failed))
            }
            Recovery::Retry => {
                if !record.failure.retryable
                    || record.failure.outcome_unknown
                    || record
                        .partial
                        .as_ref()
                        .is_some_and(|p| !p.content.is_empty())
                {
                    return Err(ResumeError::UnsafeRetry);
                }
                self.ensure_sequence()?;
                Ok(self.request_model())
            }
            Recovery::ReplaceHistory(history) => {
                if record.failure.kind != FailureKind::ContextOverflow
                    || record.failure.outcome_unknown
                {
                    return Err(ResumeError::UnsafeRetry);
                }
                self.ensure_sequence()?;
                self.history = Arc::new(history);
                Ok(self.request_model())
            }
        }
    }

    pub fn complete(&mut self) -> Result<Step, ResumeError> {
        if !matches!(self.state, State::Idle) {
            return Err(ResumeError::WrongState);
        }
        self.state = State::Done(TerminalReason::Completed);
        Ok(Step::Done(TerminalReason::Completed))
    }

    /// Permanently cancels this run, including suspended and streaming states.
    /// Outstanding tool outcomes are recorded as unknown, not falsely undone.
    pub fn cancel(&mut self, timestamp: u64) -> Invalidation {
        if matches!(self.state, State::Done(_)) {
            return Invalidation {
                model: None,
                tools: Vec::new(),
            };
        }
        let invalidated = self.invalidate(timestamp);
        self.state = State::Done(TerminalReason::Cancelled);
        invalidated
    }

    /// Fence obsolete work and deliver a trusted host notice without auto-restart.
    /// Host must apply the returned aborts before dispatching new effects.
    pub fn rebind(
        &mut self,
        generation: u64,
        notice: Message,
        timestamp: u64,
    ) -> Result<Invalidation, ResumeError> {
        if generation <= self.generation {
            return Err(ResumeError::InvalidGeneration);
        }
        if matches!(self.state, State::Done(_)) {
            return Err(ResumeError::WrongState);
        }
        let invalidated = self.invalidate(timestamp);
        self.generation = generation;
        self.history_mut().push(notice);
        Ok(invalidated)
    }

    /// The host settled the streaming request itself instead of
    /// `finish_model`: it keeps `reply` (an interrupted reply it goes on
    /// from, say, or one whose calls it ran although the core refused their
    /// IDs). `reply` is recorded as given, replacing any partial, and no tool
    /// effect is issued for it. The request is fenced by moving to the strictly
    /// greater `generation`; the core is idle.
    pub fn supersede(
        &mut self,
        ticket: Ticket,
        generation: u64,
        reply: AssistantMessage,
    ) -> Result<Invalidation, ResumeError> {
        self.check_ticket(ticket)?;
        if !matches!(self.state, State::Streaming { .. }) {
            return Err(ResumeError::WrongState);
        }
        if generation <= self.generation {
            return Err(ResumeError::InvalidGeneration);
        }
        self.state = State::Idle;
        self.generation = generation;
        self.history_mut().push(Message::Assistant(reply));
        Ok(Invalidation {
            model: Some(ticket),
            tools: Vec::new(),
        })
    }

    fn ensure_sequence(&self) -> Result<(), ResumeError> {
        self.sequence
            .checked_add(1)
            .ok_or(ResumeError::SequenceExhausted)
            .map(|_| ())
    }

    fn request_model(&mut self) -> Step {
        self.sequence += 1; // every caller checked before mutating
        let ticket = Ticket {
            generation: self.generation,
            sequence: self.sequence,
        };
        self.state = State::Streaming {
            ticket,
            partial: None,
        };
        Step::Model(ModelRequest {
            ticket,
            messages: Arc::clone(&self.history),
        })
    }

    fn check_ticket(&self, ticket: Ticket) -> Result<(), ResumeError> {
        if ticket.generation != self.generation {
            return Err(ResumeError::StaleGeneration);
        }
        let expected = match &self.state {
            State::Streaming { ticket, .. } | State::Tools { ticket, .. } => *ticket,
            State::Suspended(record) => record.ticket,
            _ => return Err(ResumeError::WrongState),
        };
        if expected != ticket {
            return Err(ResumeError::StaleTicket);
        }
        Ok(())
    }

    fn pending_tool(&mut self, key: CallKey) -> Result<&mut PendingTool, ResumeError> {
        self.check_ticket(key.model)?;
        let State::Tools { calls, .. } = &mut self.state else {
            return Err(ResumeError::WrongState);
        };
        let call = calls.get_mut(key.index).ok_or(ResumeError::UnknownCall)?;
        if call.outcome.is_some() {
            return Err(ResumeError::DuplicateResult);
        }
        Ok(call)
    }

    fn suspend(
        &mut self,
        ticket: Ticket,
        failure: Failure,
        partial: Option<AssistantMessage>,
    ) -> Step {
        let record = FailureRecord {
            ticket,
            failure,
            partial,
        };
        self.failures.push(record.clone());
        self.state = State::Suspended(record.clone());
        Step::Suspended(Box::new(record))
    }

    fn record_tool(&mut self, call: ToolCall, outcome: ToolOutcome) {
        let message = outcome.message(&call.id, &call.name);
        self.history_mut().push(message);
        self.tool_records.push(ToolRecord { call, outcome });
    }

    fn invalidate(&mut self, timestamp: u64) -> Invalidation {
        let old = std::mem::replace(&mut self.state, State::Idle);
        let mut invalidated = Invalidation {
            model: None,
            tools: Vec::new(),
        };
        match old {
            State::Streaming { ticket, partial } => {
                invalidated.model = Some(ticket);
                if let Some(mut partial) = partial.map(Partial::into_message) {
                    partial.stop_reason = StopReason::Aborted;
                    partial.completed_at = Some(timestamp);
                    self.history_mut().push(Message::Assistant(partial));
                }
            }
            State::Tools { calls, .. } => {
                for call in calls {
                    let outcome = call.outcome.unwrap_or_else(|| {
                        invalidated.tools.push(call.call.key);
                        ToolOutcome {
                            status: ToolStatus::Unknown,
                            content: vec![UserBlock::Text {
                                text: "Interrupted by host; external effect outcome is unknown."
                                    .into(),
                                text_signature: None,
                            }],
                            details: None,
                            timestamp,
                        }
                    });
                    self.record_tool(call.call, outcome);
                }
            }
            State::Suspended(_) | State::Idle | State::Done(_) => {}
        }
        invalidated
    }
}
