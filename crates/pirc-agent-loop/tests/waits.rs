mod support;

use pirc_agent_loop::*;
use pirc_llm_types::StopReason;
use support::*;

fn batch(core: &mut Loop, ids: &[&str]) -> Vec<ToolCall> {
    let request = model(core.advance(vec![]).unwrap());
    tools(
        core.finish_model(request.ticket, reply(StopReason::ToolUse, ids), None)
            .unwrap(),
    )
}

#[test]
fn overlapping_waits_end_independently_even_for_identical_reasons() {
    let mut core = Loop::new(1, vec![]);
    let calls = batch(&mut core, &["a"]);
    let key = calls[0].key;
    let first = core.begin_wait(key, WaitReason::Approval).unwrap();
    let second = core.begin_wait(key, WaitReason::Approval).unwrap();
    let lease_reason = WaitReason::Resource("lease".into());
    let lease = core.begin_wait(key, lease_reason.clone()).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        core.waiting_all(),
        [
            (key, &WaitReason::Approval),
            (key, &WaitReason::Approval),
            (key, &lease_reason)
        ]
    );
    assert_eq!(core.waiting(), [(key, &lease_reason)]);

    // Removing an older wait cannot erase the most recent one.
    assert!(core.finish_wait(&first.clone()));
    assert!(!core.finish_wait(&first));
    assert_eq!(core.waiting(), [(key, &lease_reason)]);
    // Removing the newest one restores the previous open reason.
    assert!(core.finish_wait(&lease));
    assert_eq!(core.waiting(), [(key, &WaitReason::Approval)]);
    assert!(core.finish_wait(&second));
    assert!(core.waiting_all().is_empty());
    assert_eq!(core.status(), Status::WaitingTools);
    assert!(core.tool_records().is_empty());
}

#[test]
fn waits_of_different_calls_and_result_cleanup_are_independent() {
    let mut core = Loop::new(1, vec![]);
    let calls = batch(&mut core, &["a", "b"]);
    let a1 = core.begin_wait(calls[0].key, WaitReason::Approval).unwrap();
    let a2 = core
        .begin_wait(calls[0].key, WaitReason::Other("question".into()))
        .unwrap();
    let b = core.begin_wait(calls[1].key, WaitReason::Approval).unwrap();
    assert_eq!(core.waiting_all().len(), 3);
    assert_eq!(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "A"))
            .unwrap(),
        Step::Waiting { remaining: 1 }
    );
    assert!(!core.finish_wait(&a1));
    assert!(!core.finish_wait(&a2));
    assert_eq!(core.waiting_all(), [(calls[1].key, &WaitReason::Approval)]);
    assert_eq!(
        core.begin_wait(calls[0].key, WaitReason::Approval),
        Err(ResumeError::DuplicateResult)
    );
    // A duplicate result cannot erase another call's wait.
    assert_eq!(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "duplicate")),
        Err(ResumeError::DuplicateResult)
    );
    assert_eq!(core.waiting_all().len(), 1);
    model(
        core.resume_tool(calls[1].key, outcome(ToolStatus::Denied, "B"))
            .unwrap(),
    );
    assert!(!core.finish_wait(&b));
    assert!(core.waiting_all().is_empty());
}

#[test]
fn compatibility_slot_never_replaces_or_ends_tokenized_waits() {
    let mut core = Loop::new(1, vec![]);
    let calls = batch(&mut core, &["a"]);
    let key = calls[0].key;
    core.wait_tool(key, WaitReason::Other("old slot".into()))
        .unwrap();
    let token = core.begin_wait(key, WaitReason::Approval).unwrap();
    let legacy = WaitReason::Other("new slot".into());
    core.wait_tool(key, legacy.clone()).unwrap();
    assert_eq!(
        core.waiting_all(),
        [(key, &WaitReason::Approval), (key, &legacy)]
    );
    assert_eq!(core.waiting(), [(key, &legacy)]);
    core.end_wait(key).unwrap();
    core.end_wait(key).unwrap();
    assert_eq!(core.waiting_all(), [(key, &WaitReason::Approval)]);
    assert!(core.finish_wait(&token));
    assert!(core.waiting().is_empty());
}

#[test]
fn foreign_tokens_cannot_end_waits_even_with_identical_call_keys() {
    let mut first = Loop::new(1, vec![]);
    let mut second = Loop::new(1, vec![]);
    let a = batch(&mut first, &["same"]);
    let b = batch(&mut second, &["same"]);
    assert_eq!(a[0].key, b[0].key);
    let old = first.begin_wait(a[0].key, WaitReason::Approval).unwrap();
    let current = second.begin_wait(b[0].key, WaitReason::Approval).unwrap();
    assert!(!second.finish_wait(&old));
    assert!(!first.finish_wait(&current));
    assert_eq!(first.waiting_all().len(), 1);
    assert_eq!(second.waiting_all().len(), 1);
    first.cancel(9);
    drop(first);
    assert!(!second.finish_wait(&old));
    assert!(second.finish_wait(&current));
}

#[test]
fn invalid_resumes_and_waits_leave_existing_waits_and_history_untouched() {
    let mut core = Loop::new(1, vec![]);
    let calls = batch(&mut core, &["a", "b"]);
    let token = core.begin_wait(calls[0].key, WaitReason::Approval).unwrap();
    let history = core.history().to_vec();
    let invalid = CallKey {
        index: 99,
        ..calls[0].key
    };
    assert_eq!(
        core.begin_wait(invalid, WaitReason::Approval),
        Err(ResumeError::UnknownCall)
    );
    assert_eq!(
        core.wait_tool(invalid, WaitReason::Approval),
        Err(ResumeError::UnknownCall)
    );
    assert_eq!(core.end_wait(invalid), Err(ResumeError::UnknownCall));
    assert_eq!(
        core.resume_tool(invalid, outcome(ToolStatus::Completed, "invalid")),
        Err(ResumeError::UnknownCall)
    );
    assert_eq!(
        core.rebind(1, user("invalid"), 9),
        Err(ResumeError::InvalidGeneration)
    );
    assert_eq!(
        core.supersede(calls[0].key.model, 2, reply(StopReason::Stop, &[])),
        Err(ResumeError::WrongState)
    );
    assert_eq!(core.history(), history);
    assert_eq!(core.waiting_all(), [(calls[0].key, &WaitReason::Approval)]);
    assert!(core.tool_records().is_empty());
    assert!(core.finish_wait(&token));
}

#[test]
fn cancellation_clears_every_wait_and_is_idempotent() {
    let mut core = Loop::new(1, vec![]);
    let calls = batch(&mut core, &["a", "b"]);
    let a = core.begin_wait(calls[0].key, WaitReason::Approval).unwrap();
    core.wait_tool(calls[0].key, WaitReason::Other("legacy".into()))
        .unwrap();
    let b = core.begin_wait(calls[1].key, WaitReason::Approval).unwrap();
    assert_eq!(core.cancel(9).tools, [calls[0].key, calls[1].key]);
    assert!(core.waiting_all().is_empty());
    assert!(!core.finish_wait(&a));
    assert!(!core.finish_wait(&b));
    assert!(core.cancel(10).tools.is_empty());
    assert_eq!(core.tool_records().len(), 2);
    assert_eq!(core.status(), Status::Done(TerminalReason::Cancelled));
}

#[test]
fn rebind_and_supersede_fence_old_tokens_from_new_batches() {
    let mut core = Loop::new(1, vec![]);
    let first = batch(&mut core, &["same"]);
    let old = core.begin_wait(first[0].key, WaitReason::Approval).unwrap();
    assert_eq!(
        core.rebind(2, user("rebound"), 9).unwrap().tools,
        [first[0].key]
    );
    assert!(core.waiting_all().is_empty());
    let request = model(core.advance(vec![]).unwrap());
    core.supersede(request.ticket, 3, reply(StopReason::Stop, &[]))
        .unwrap();
    let next = batch(&mut core, &["same"]);
    let current = core.begin_wait(next[0].key, WaitReason::Approval).unwrap();
    assert!(!core.finish_wait(&old));
    assert_eq!(
        core.resume_tool(first[0].key, outcome(ToolStatus::Completed, "late")),
        Err(ResumeError::StaleGeneration)
    );
    assert_eq!(core.waiting_all(), [(next[0].key, &WaitReason::Approval)]);
    assert!(core.finish_wait(&current));
}
