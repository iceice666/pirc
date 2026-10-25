mod support;

use pirc_agent_loop::*;
use pirc_llm_types::*;
use support::*;

#[test]
fn fake_model_tools_round_trip_preserves_order_and_no_duplicate_effects() {
    let mut core = Loop::new(1, vec![]);
    assert_eq!(core.status(), Status::Idle);
    let first = model(core.advance(vec![user("go")]).unwrap());
    let calls = tools(
        core.finish_model(first.ticket, reply(StopReason::ToolUse, &["a", "b"]), None)
            .unwrap(),
    );
    assert_eq!(
        calls.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_ne!(calls[0].key, calls[1].key);
    assert_eq!(core.status(), Status::WaitingTools);
    // Late duplicate final reply never causes another tool effect.
    assert_eq!(
        core.finish_model(first.ticket, reply(StopReason::ToolUse, &["a", "b"]), None),
        Err(ResumeError::WrongState)
    );
    assert_eq!(
        core.resume_tool(calls[1].key, outcome(ToolStatus::Completed, "B"))
            .unwrap(),
        Step::Waiting { remaining: 1 }
    );
    assert_eq!(
        core.resume_tool(calls[1].key, outcome(ToolStatus::Completed, "B")),
        Err(ResumeError::DuplicateResult)
    );
    let second = model(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "A"))
            .unwrap(),
    );
    assert_eq!(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "A")),
        Err(ResumeError::StaleTicket)
    );
    let ids = second
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::ToolResult { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(
        core.finish_model(second.ticket, text_reply(StopReason::Stop, "done"), None)
            .unwrap(),
        Step::Idle
    );
    assert_eq!(core.status(), Status::Idle); // normal model stop is not host completion
    assert_eq!(
        core.complete().unwrap(),
        Step::Done(TerminalReason::Completed)
    );
    assert_eq!(core.advance(vec![]), Err(ResumeError::WrongState));
    assert_eq!(core.complete(), Err(ResumeError::WrongState));
}

#[test]
fn blocked_is_not_denied_and_denied_results_are_correlated() {
    let mut core = Loop::new(9, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let calls = tools(
        core.finish_model(
            request.ticket,
            reply(StopReason::ToolUse, &["approval", "lock"]),
            None,
        )
        .unwrap(),
    );
    core.wait_tool(calls[0].key, WaitReason::Approval).unwrap();
    core.wait_tool(calls[1].key, WaitReason::Resource("file held by A".into()))
        .unwrap();
    assert_eq!(core.waiting().len(), 2);
    assert!(core.tool_records().is_empty());
    core.resume_tool(calls[0].key, outcome(ToolStatus::Denied, "no"))
        .unwrap();
    assert_eq!(
        core.waiting(),
        [(calls[1].key, &WaitReason::Resource("file held by A".into()))]
    );
    let next = model(
        core.resume_tool(
            calls[1].key,
            outcome(ToolStatus::Completed, "granted by host"),
        )
        .unwrap(),
    );
    assert!(
        matches!(&next.messages[1], Message::ToolResult { tool_call_id, is_error: true, .. } if tool_call_id == "approval")
    );
    assert_eq!(core.tool_records()[0].outcome.status, ToolStatus::Denied);
}

#[test]
fn progressive_snapshots_are_not_duplicated_into_final_history() {
    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    for text in ["h", "hello"] {
        let progress = Progress {
            ticket: request.ticket,
            delta: AssistantDelta::TextDelta {
                content_index: 0,
                delta: text.into(),
            },
            partial: text_reply(StopReason::Stop, text),
        };
        assert_eq!(core.progress(progress.clone()).unwrap(), progress);
        assert_eq!(core.partial().unwrap(), &text_reply(StopReason::Stop, text));
        assert!(core.history().is_empty());
    }
    core.finish_model(request.ticket, text_reply(StopReason::Stop, "hello"), None)
        .unwrap();
    assert_eq!(
        core.history(),
        [Message::Assistant(text_reply(StopReason::Stop, "hello"))]
    );
    assert!(core.partial().is_none());
}

#[test]
fn duplicate_empty_call_ids_are_rejected_before_any_history_or_effect() {
    for ids in [vec!["same", "same"], vec![""], vec![]] {
        let mut core = Loop::new(0, vec![]);
        let request = model(core.advance(vec![]).unwrap());
        assert_eq!(
            core.finish_model(request.ticket, reply(StopReason::ToolUse, &ids), None),
            Err(ResumeError::InvalidCallIds)
        );
        assert!(core.history().is_empty());
        assert_eq!(core.status(), Status::Streaming);
        core.cancel(4);
    }
}

#[test]
fn generation_change_during_stream_fences_late_tool_reply_and_progress() {
    let mut core = Loop::new(41, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let progress = Progress {
        ticket: request.ticket,
        delta: AssistantDelta::TextStart { content_index: 0 },
        partial: text_reply(StopReason::Stop, "partial"),
    };
    core.progress(progress.clone()).unwrap();
    let notice = user("host: resources changed");
    let invalidated = core.rebind(42, notice.clone(), 8).unwrap();
    assert_eq!(invalidated.model, Some(request.ticket));
    assert!(invalidated.tools.is_empty());
    assert_eq!(core.status(), Status::Idle);
    assert_eq!(core.history().last(), Some(&notice));
    assert!(
        matches!(&core.history()[0], Message::Assistant(m) if m.stop_reason == StopReason::Aborted && m.usage.total_tokens == 5)
    );
    assert_eq!(core.progress(progress), Err(ResumeError::StaleGeneration));
    assert_eq!(
        core.finish_model(
            request.ticket,
            reply(StopReason::ToolUse, &["removed-mount"]),
            None
        ),
        Err(ResumeError::StaleGeneration)
    );
    assert_eq!(
        core.rebind(42, user("same"), 8),
        Err(ResumeError::InvalidGeneration)
    );
    // No implicit restart after a policy change.
    let next = model(core.advance(vec![]).unwrap());
    assert_eq!(next.ticket.generation(), 42);
}

#[test]
fn requests_share_the_history_and_copy_only_while_held() {
    // Room to grow without reallocating, so the buffer's address tells a
    // copy apart from an in-place push.
    let mut history = Vec::with_capacity(16);
    history.push(user("go"));
    let mut core = Loop::new(0, history);
    let first = model(core.advance(vec![]).unwrap());
    assert_eq!(first.messages.as_ptr(), core.history().as_ptr());
    let shared = core.history().as_ptr();
    // Held while the reply is recorded: the request keeps its snapshot.
    let calls = tools(
        core.finish_model(first.ticket, reply(StopReason::ToolUse, &["a"]), None)
            .unwrap(),
    );
    assert_eq!(*first.messages, [user("go")]);
    assert_eq!(core.history().len(), 2);
    assert_ne!(core.history().as_ptr(), shared);
    drop(first);
    // Dropped before the next push: the history grows in place.
    let own = core.history().as_ptr();
    let second = model(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "A"))
            .unwrap(),
    );
    assert_eq!(core.history().as_ptr(), own);
    assert_eq!(second.messages.as_ptr(), own);
    let ticket = second.ticket;
    drop(second);
    core.finish_model(ticket, text_reply(StopReason::Stop, "done"), None)
        .unwrap();
    assert_eq!(core.history().as_ptr(), own);
    assert_eq!(core.history().len(), 4);
}

#[test]
fn a_wait_can_end_while_its_call_stays_pending() {
    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let calls = tools(
        core.finish_model(request.ticket, reply(StopReason::ToolUse, &["a"]), None)
            .unwrap(),
    );
    core.wait_tool(calls[0].key, WaitReason::Approval).unwrap();
    core.end_wait(calls[0].key).unwrap();
    assert!(core.waiting().is_empty());
    assert_eq!(core.status(), Status::WaitingTools);
    // Ending no wait is fine; a call with a result has none to end.
    core.end_wait(calls[0].key).unwrap();
    model(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "A"))
            .unwrap(),
    );
    assert_eq!(core.end_wait(calls[0].key), Err(ResumeError::StaleTicket));
}

#[test]
fn a_superseded_stream_keeps_the_host_reply_and_fences_the_old_ticket() {
    let mut core = Loop::new(3, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let progress = Progress {
        ticket: request.ticket,
        delta: AssistantDelta::TextStart { content_index: 0 },
        partial: text_reply(StopReason::Stop, "part"),
    };
    core.progress(progress.clone()).unwrap();
    let kept = reply(StopReason::ToolUse, &["same", "same"]);
    assert_eq!(
        core.supersede(request.ticket, 3, kept.clone()),
        Err(ResumeError::InvalidGeneration)
    );
    let invalidated = core.supersede(request.ticket, 4, kept.clone()).unwrap();
    assert_eq!(invalidated.model, Some(request.ticket));
    assert!(invalidated.tools.is_empty());
    // The reply as given, once: the partial is not recorded beside it.
    assert_eq!(core.history(), [Message::Assistant(kept.clone())]);
    assert_eq!(core.status(), Status::Idle);
    assert!(core.partial().is_none());
    assert_eq!(core.progress(progress), Err(ResumeError::StaleGeneration));
    assert_eq!(
        core.finish_model(request.ticket, kept.clone(), None),
        Err(ResumeError::StaleGeneration)
    );
    let next = model(core.advance(vec![]).unwrap());
    assert_eq!(next.ticket.generation(), 4);
    // Only a streaming request can be superseded.
    assert_eq!(
        core.supersede(request.ticket, 5, kept.clone()),
        Err(ResumeError::StaleGeneration)
    );
    let calls = tools(
        core.finish_model(next.ticket, reply(StopReason::ToolUse, &["a"]), None)
            .unwrap(),
    );
    assert_eq!(
        core.supersede(calls[0].key.model, 5, kept),
        Err(ResumeError::WrongState)
    );
}

#[test]
fn generation_change_during_tool_wait_records_partial_results_and_unknowns() {
    let mut core = Loop::new(1, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let calls = tools(
        core.finish_model(
            request.ticket,
            reply(StopReason::ToolUse, &["a", "b"]),
            None,
        )
        .unwrap(),
    );
    core.resume_tool(calls[1].key, outcome(ToolStatus::Completed, "done"))
        .unwrap();
    core.wait_tool(calls[0].key, WaitReason::Approval).unwrap();
    let invalidated = core.rebind(2, user("access revoked"), 9).unwrap();
    assert_eq!(invalidated.tools, [calls[0].key]);
    assert_eq!(core.tool_records()[0].outcome.status, ToolStatus::Unknown);
    assert_eq!(core.tool_records()[1].outcome.status, ToolStatus::Completed);
    assert_eq!(
        core.resume_tool(
            calls[0].key,
            outcome(ToolStatus::Completed, "stale approval")
        ),
        Err(ResumeError::StaleGeneration)
    );
}

#[test]
fn cancellation_during_approval_wait_is_terminal_and_idempotent() {
    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let calls = tools(
        core.finish_model(request.ticket, reply(StopReason::ToolUse, &["a"]), None)
            .unwrap(),
    );
    core.wait_tool(calls[0].key, WaitReason::Approval).unwrap();
    assert_eq!(core.cancel(5).tools, [calls[0].key]);
    assert_eq!(core.status(), Status::Done(TerminalReason::Cancelled));
    assert_eq!(core.tool_records()[0].outcome.status, ToolStatus::Unknown);
    assert_eq!(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "late")),
        Err(ResumeError::WrongState)
    );
    assert!(core.cancel(6).tools.is_empty());
    assert_eq!(core.tool_records().len(), 1);
    assert_eq!(
        core.rebind(1, user("change"), 7),
        Err(ResumeError::WrongState)
    );
}

#[test]
fn cancel_stream_keeps_partial_usage_but_rejects_completion() {
    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    core.progress(Progress {
        ticket: request.ticket,
        delta: AssistantDelta::TextDelta {
            content_index: 0,
            delta: "partial".into(),
        },
        partial: text_reply(StopReason::Error, "partial"),
    })
    .unwrap();
    assert_eq!(core.cancel(20).model, Some(request.ticket));
    assert!(matches!(&core.history()[0], Message::Assistant(m)
        if m.stop_reason == StopReason::Aborted && m.completed_at == Some(20) && m.usage.total_tokens == 5));
    assert_eq!(
        core.finish_model(request.ticket, reply(StopReason::Stop, &[]), None),
        Err(ResumeError::WrongState)
    );
}

#[test]
fn partial_failure_metadata_survives_and_unsafe_retry_is_refused() {
    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let partial = text_reply(StopReason::Error, "possibly billable partial");
    core.progress(Progress {
        ticket: request.ticket,
        delta: AssistantDelta::TextStart { content_index: 0 },
        partial: partial.clone(),
    })
    .unwrap();
    let error = failure(FailureKind::Transport);
    let step = core.fail_model(request.ticket, error.clone()).unwrap();
    assert!(matches!(step, Step::Suspended(_)));
    assert_eq!(core.status(), Status::Suspended);
    assert_eq!(core.partial(), Some(&partial));
    assert_eq!(core.failures()[0].failure, error);
    assert_eq!(
        core.failures()[0]
            .partial
            .as_ref()
            .unwrap()
            .usage
            .total_tokens,
        5
    );
    assert_eq!(
        core.recover(request.ticket, Recovery::Retry),
        Err(ResumeError::UnsafeRetry)
    );
    core.cancel(5);
    assert_eq!(core.status(), Status::Done(TerminalReason::Cancelled));
    assert_eq!(core.failures().len(), 1);
    assert_eq!(
        core.recover(request.ticket, Recovery::Retry),
        Err(ResumeError::WrongState)
    );
}

#[test]
fn explicit_retry_and_compaction_use_new_tickets_and_never_replay_old_resume() {
    let mut core = Loop::new(0, vec![user("large history")]);
    let first = model(core.advance(vec![]).unwrap());
    core.fail_model(first.ticket, failure(FailureKind::RateLimited))
        .unwrap();
    let second = model(core.recover(first.ticket, Recovery::Retry).unwrap());
    assert_ne!(first.ticket, second.ticket);
    assert_eq!(
        core.recover(first.ticket, Recovery::Retry),
        Err(ResumeError::StaleTicket)
    );
    core.fail_model(second.ticket, failure(FailureKind::ContextOverflow))
        .unwrap();
    let compacted = vec![user("host summary")];
    let third = model(
        core.recover(second.ticket, Recovery::ReplaceHistory(compacted.clone()))
            .unwrap(),
    );
    assert_eq!(*third.messages, compacted);
    assert_eq!(core.failures().len(), 2);
    core.fail_model(third.ticket, failure(FailureKind::Transport))
        .unwrap();
    assert_eq!(
        core.recover(third.ticket, Recovery::ReplaceHistory(vec![])),
        Err(ResumeError::UnsafeRetry)
    );
    assert_eq!(
        core.recover(third.ticket, Recovery::Stop).unwrap(),
        Step::Done(TerminalReason::Failed)
    );
}

#[test]
fn unknown_transport_outcome_is_never_retryable() {
    let mut core = Loop::new(0, vec![]);
    let first = model(core.advance(vec![]).unwrap());
    let mut unknown = failure(FailureKind::Transport);
    unknown.outcome_unknown = true;
    core.fail_model(first.ticket, unknown).unwrap();
    assert_eq!(
        core.recover(first.ticket, Recovery::Retry),
        Err(ResumeError::UnsafeRetry)
    );
}

#[test]
fn aborted_model_is_terminal_and_raw_error_is_retained_without_claiming_safe() {
    let mut core = Loop::new(0, vec![]);
    let first = model(core.advance(vec![]).unwrap());
    let mut error = reply(StopReason::Error, &[]);
    error.error_message = Some("raw private endpoint details".into());
    assert!(matches!(
        core.finish_model(first.ticket, error, None).unwrap(),
        Step::Suspended(_)
    ));
    assert_eq!(
        core.failures()[0].failure.message,
        "raw private endpoint details"
    );
    assert_eq!(
        core.recover(first.ticket, Recovery::Retry),
        Err(ResumeError::UnsafeRetry)
    );
    core.recover(first.ticket, Recovery::Stop).unwrap();

    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    assert_eq!(
        core.finish_model(request.ticket, reply(StopReason::Aborted, &[]), None)
            .unwrap(),
        Step::Done(TerminalReason::Cancelled)
    );
}
