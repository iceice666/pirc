use super::*;
use pirc_agent_loop::{FailureKind, TerminalReason};
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
    let not_a_result = Message::User {
        content: pirc_protocol::UserContent::Text("x".to_owned()),
        timestamp: 1,
    };
    assert!(
        run.tool_result(&calls[0], &not_a_result, CallEnd::Ran)
            .is_err()
    );
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
fn an_interrupted_reply_supersedes_and_the_run_goes_on() {
    let mut run = RunLoop::new();
    let first = run.request().unwrap();
    run.attempt(reply(StopReason::Stop, Vec::new()));
    run.delta(&AssistantDelta::TextStart { content_index: 0 });
    let aborted = reply(StopReason::Aborted, vec![text("Partial")]);
    assert_eq!(run.reply(first, &aborted, true).unwrap(), Reply::Nothing);
    assert_eq!(run.status(), Status::Idle);
    let second = run.request().unwrap();
    assert_ne!(first.generation(), second.generation());
    // A late answer to the old request is refused.
    assert!(run.reply(first, &aborted, false).is_err());
    run.reply(second, &reply(StopReason::Stop, vec![text("Ok")]), false)
        .unwrap();
    // The interrupted reply once, as the agent kept it, not its partial.
    assert_eq!(
        run.core.history(),
        [
            Message::Assistant(aborted),
            Message::Assistant(reply(StopReason::Stop, vec![text("Ok")]))
        ]
    );
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
        // Nothing of an unchecked batch is the running call.
        assert_eq!(run.running_call("a"), None);
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

#[test]
fn snapshots_follow_block_boundaries_and_restart_with_each_attempt() {
    let mut run = RunLoop::new();
    let ticket = run.request().unwrap();
    // Nothing before an attempt started.
    run.delta(&AssistantDelta::TextStart { content_index: 0 });
    assert_eq!(run.partial(), None);
    run.attempt(reply(StopReason::Stop, vec![text("ignored")]));
    run.delta(&AssistantDelta::ThinkingStart { content_index: 0 });
    run.delta(&AssistantDelta::ThinkingDelta {
        content_index: 0,
        delta: "hm".to_owned(),
    });
    run.delta(&AssistantDelta::ThinkingEnd {
        content_index: 0,
        content: "hmm".to_owned(),
    });
    run.delta(&AssistantDelta::TextStart { content_index: 1 });
    run.delta(&AssistantDelta::TextDelta {
        content_index: 1,
        delta: "Hel".to_owned(),
    });
    // A delta inside a block does not change the snapshot.
    let content = &run.partial().unwrap().content;
    assert_eq!(content.len(), 2);
    assert_eq!(content[1], text(""));
    run.delta(&AssistantDelta::TextEnd {
        content_index: 1,
        content: "Hello".to_owned(),
    });
    run.delta(&AssistantDelta::ToolcallStart {
        content_index: 2,
        id: "c1".to_owned(),
        tool_name: "read".to_owned(),
    });
    assert!(matches!(
        &run.partial().unwrap().content[2],
        AssistantContent::ToolCall { id, arguments, .. } if id == "c1" && arguments.is_empty()
    ));
    run.delta(&AssistantDelta::ToolcallEnd {
        content_index: 2,
        tool_call: call("c1"),
    });
    assert_eq!(
        run.partial().unwrap().content,
        [
            AssistantContent::Thinking {
                thinking: "hmm".to_owned(),
                signature: None,
                redacted: None,
            },
            text("Hello"),
            call("c1"),
        ]
    );
    assert!(run.core.history().is_empty());

    // A retry starts from nothing again; an out-of-order boundary stops
    // the attempt's snapshots.
    run.attempt(reply(StopReason::Stop, Vec::new()));
    run.delta(&AssistantDelta::TextStart { content_index: 0 });
    run.delta(&AssistantDelta::TextStart { content_index: 3 });
    run.delta(&AssistantDelta::TextEnd {
        content_index: 0,
        content: "late".to_owned(),
    });
    assert_eq!(run.partial().unwrap().content, [text("")]);

    // The final reply is what the core keeps.
    let done = reply(StopReason::Stop, vec![text("Final")]);
    run.reply(ticket, &done, false).unwrap();
    assert_eq!(run.core.history(), [Message::Assistant(done)]);
    assert_eq!(run.partial(), None);
    // After the reply, deltas are dropped.
    run.delta(&AssistantDelta::TextStart { content_index: 0 });
    assert_eq!(run.partial(), None);
}

#[test]
fn waits_belong_to_the_running_call_and_overlap() {
    let mut run = RunLoop::new();
    let calls = tools(&mut run, &["a", "b"]);
    assert_eq!(run.running_call("a"), None);
    run.start_call(&calls[0]);
    assert_eq!(run.running_call("a"), Some(calls[0].key));
    assert_eq!(run.running_call("b"), None);
    let approval = run.wait(calls[0].key, WaitReason::Approval).unwrap();
    let lease = run
        .wait(calls[0].key, WaitReason::Resource("write lease".to_owned()))
        .unwrap();
    assert_eq!(
        run.waiting(),
        [(calls[0].key, WaitReason::Resource("write lease".to_owned()))]
    );
    // The lease is acquired: the approval is still open.
    run.end_wait(&lease);
    assert_eq!(run.waiting(), [(calls[0].key, WaitReason::Approval)]);
    run.end_wait(&approval);
    assert!(run.waiting().is_empty());
    run.end_wait(&approval);

    // A wait still open when its call ends is closed with it.
    let open = run.wait(calls[0].key, WaitReason::Approval).unwrap();
    run.tool_result(&calls[0], &result("a", false), CallEnd::Ran)
        .unwrap();
    assert_eq!(run.running_call("a"), None);
    run.end_wait(&open);
    assert!(run.waiting().is_empty());
    // A token of another run ends nothing here.
    let mut other = RunLoop::new();
    let other_calls = tools(&mut other, &["x"]);
    let foreign = other
        .wait(other_calls[0].key, WaitReason::Approval)
        .unwrap();
    run.end_wait(&foreign);
    assert_eq!(other.waiting().len(), 1);
    // A call that already has its result cannot wait.
    assert_eq!(run.wait(calls[0].key, WaitReason::Approval), None);
    run.start_call(&calls[1]);
    run.wait(calls[1].key, WaitReason::Other("question".to_owned()))
        .unwrap();
    run.tool_result(&calls[1], &result("b", false), CallEnd::Ran)
        .unwrap();
    assert!(run.waiting().is_empty());
}

#[test]
fn a_dialog_from_a_closed_run_cannot_clear_the_next_runs_wait() {
    let mut old_run = RunLoop::new();
    let old_calls = tools(&mut old_run, &["same"]);
    let old_token = old_run
        .wait(old_calls[0].key, WaitReason::Approval)
        .unwrap();
    old_run.close(true, 9).unwrap();
    assert!(old_run.waiting().is_empty());
    old_run.end_wait(&old_token);

    let mut next_run = RunLoop::new();
    let calls = tools(&mut next_run, &["same"]);
    assert_eq!(old_calls[0].key, calls[0].key);
    let current = next_run.wait(calls[0].key, WaitReason::Approval).unwrap();
    next_run.end_wait(&old_token);
    assert_eq!(next_run.waiting(), [(calls[0].key, WaitReason::Approval)]);
    next_run.end_wait(&current);
    assert!(next_run.waiting().is_empty());
}

#[test]
fn malformed_or_stale_results_do_not_clear_the_running_calls_waits() {
    let mut run = RunLoop::new();
    let calls = tools(&mut run, &["a", "b"]);
    run.start_call(&calls[0]);
    let approval = run.wait(calls[0].key, WaitReason::Approval).unwrap();
    let not_a_result = Message::User {
        content: pirc_protocol::UserContent::Text("invalid".into()),
        timestamp: 4,
    };
    assert!(
        run.tool_result(&calls[0], &not_a_result, CallEnd::Ran)
            .is_err()
    );
    assert_eq!(run.running_call("a"), Some(calls[0].key));
    assert_eq!(run.waiting(), [(calls[0].key, WaitReason::Approval)]);

    let mut invalid = calls[0].clone();
    invalid.key.index = 99;
    assert!(
        run.tool_result(&invalid, &result("a", false), CallEnd::Ran)
            .is_err()
    );
    assert_eq!(run.running_call("a"), Some(calls[0].key));
    assert_eq!(run.waiting(), [(calls[0].key, WaitReason::Approval)]);

    run.tool_result(&calls[1], &result("b", false), CallEnd::Ran)
        .unwrap();
    assert!(
        run.tool_result(&calls[1], &result("b", false), CallEnd::Ran)
            .is_err()
    );
    assert_eq!(run.running_call("a"), Some(calls[0].key));
    assert_eq!(run.waiting(), [(calls[0].key, WaitReason::Approval)]);
    run.end_wait(&approval);
    assert!(run.waiting().is_empty());
}

#[test]
fn overlapping_waits_on_different_calls_are_owned_by_the_core() {
    let mut run = RunLoop::new();
    let calls = tools(&mut run, &["a", "b"]);
    let a = run.wait(calls[0].key, WaitReason::Approval).unwrap();
    let b = run
        .wait(calls[1].key, WaitReason::Other("question".into()))
        .unwrap();
    run.tool_result(&calls[0], &result("a", false), CallEnd::Ran)
        .unwrap();
    run.end_wait(&a);
    assert_eq!(
        run.waiting(),
        [(calls[1].key, WaitReason::Other("question".into()))]
    );
    run.close(false, 9).unwrap();
    assert!(run.waiting().is_empty());
    run.end_wait(&b);
    assert!(run.waiting().is_empty());
}
