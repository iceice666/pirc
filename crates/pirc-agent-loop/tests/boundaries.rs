mod support;

use pirc_agent_loop::*;
use pirc_llm_types::*;
use support::*;

#[test]
fn provider_failure_cannot_authorize_partial_tool_calls() {
    let mut core = Loop::new(0, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let reply = reply(StopReason::ToolUse, &["must-not-run"]);
    assert!(matches!(
        core.finish_model(
            request.ticket,
            reply.clone(),
            Some(failure(FailureKind::Transport))
        )
        .unwrap(),
        Step::Suspended(_)
    ));
    assert_eq!(core.partial(), Some(&reply));
    assert!(core.history().is_empty());
    assert_eq!(
        core.recover(request.ticket, Recovery::Retry),
        Err(ResumeError::UnsafeRetry)
    );
    assert_eq!(
        core.wait_tool(
            CallKey {
                model: request.ticket,
                index: 0
            },
            WaitReason::Approval
        ),
        Err(ResumeError::WrongState)
    );
}

#[test]
fn malformed_resume_does_not_consume_the_real_call_or_mutate_history() {
    let mut core = Loop::new(7, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let calls = tools(
        core.finish_model(request.ticket, reply(StopReason::ToolUse, &["real"]), None)
            .unwrap(),
    );
    let forged = CallKey {
        model: request.ticket,
        index: 99,
    };
    let before = core.history().to_vec();
    assert_eq!(
        core.resume_tool(forged, outcome(ToolStatus::Completed, "invalid")),
        Err(ResumeError::UnknownCall)
    );
    assert_eq!(core.complete(), Err(ResumeError::WrongState));
    assert_eq!(
        core.advance(vec![user("wrong state")]),
        Err(ResumeError::WrongState)
    );
    assert_eq!(
        core.rebind(6, user("old generation"), 9),
        Err(ResumeError::InvalidGeneration)
    );
    assert_eq!(core.history(), before);
    let request = model(
        core.resume_tool(
            calls[0].key,
            outcome(ToolStatus::Interrupted, "host interrupted"),
        )
        .unwrap(),
    );
    assert_eq!(
        core.tool_records()[0].outcome.status,
        ToolStatus::Interrupted
    );
    assert!(matches!(
        request.messages.last(),
        Some(Message::ToolResult { is_error: true, .. })
    ));
}

#[test]
fn reused_provider_ids_in_later_batches_still_have_distinct_correlation_keys() {
    let mut core = Loop::new(1, vec![]);
    let request = model(core.advance(vec![]).unwrap());
    let first = tools(
        core.finish_model(request.ticket, reply(StopReason::ToolUse, &["same"]), None)
            .unwrap(),
    );
    let next = model(
        core.resume_tool(first[0].key, outcome(ToolStatus::Completed, "first"))
            .unwrap(),
    );
    let second = tools(
        core.finish_model(next.ticket, reply(StopReason::ToolUse, &["same"]), None)
            .unwrap(),
    );
    assert_eq!(first[0].id, second[0].id);
    assert_ne!(first[0].key, second[0].key);
    assert_eq!(
        core.resume_tool(
            first[0].key,
            outcome(ToolStatus::Completed, "late duplicate")
        ),
        Err(ResumeError::StaleTicket)
    );
    model(
        core.resume_tool(second[0].key, outcome(ToolStatus::Completed, "second"))
            .unwrap(),
    );
    assert_eq!(core.tool_records().len(), 2);
}

#[test]
fn suspended_generation_change_never_restarts_old_error() {
    let mut core = Loop::new(1, vec![]);
    let first = model(core.advance(vec![]).unwrap());
    core.fail_model(first.ticket, failure(FailureKind::Transport))
        .unwrap();
    let invalidated = core.rebind(2, user("trusted notice"), 8).unwrap();
    assert_eq!(
        invalidated,
        Invalidation {
            model: None,
            tools: vec![]
        }
    );
    assert_eq!(core.status(), Status::Idle);
    assert_eq!(core.failures().len(), 1);
    assert_eq!(
        core.recover(first.ticket, Recovery::Retry),
        Err(ResumeError::StaleGeneration)
    );
    assert_eq!(core.history(), [user("trusted notice")]);
}
