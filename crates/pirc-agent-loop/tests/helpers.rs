//! The host helpers: error classification, history repair, the streamed
//! partial.
mod support;

use pirc_agent_loop::history::{Pairing, interrupted_result, issued, project};
use pirc_agent_loop::*;
use pirc_llm_types::*;
use support::*;

fn error_reply(message: &str) -> AssistantMessage {
    let mut reply = reply(StopReason::Error, &[]);
    reply.error_message = Some(message.into());
    reply
}

fn result(id: &str, name: &str, text: &str) -> Message {
    Message::ToolResult {
        tool_call_id: id.into(),
        tool_name: name.into(),
        content: vec![UserBlock::Text {
            text: text.into(),
            text_signature: None,
        }],
        details: None,
        is_error: false,
        timestamp: 4,
    }
}

#[test]
fn retryable_errors_are_the_transient_ones() {
    for text in [
        "Model request failed (HTTP 503)",
        "Inference request timed out",
        "rate limit",
        "fetch failed",
    ] {
        assert!(is_retryable(text), "{text}");
    }
    for text in ["Gateway inference is unavailable", "HTTP 400", ""] {
        assert!(!is_retryable(text), "{text}");
    }
}

#[test]
fn a_reply_is_classified_by_its_error_message() {
    assert_eq!(
        Failure::of_reply(&text_reply(StopReason::Stop, "fine")),
        None
    );
    let cases = [
        (
            "prompt is too long: 200000 tokens",
            FailureKind::ContextOverflow,
            false,
        ),
        ("HTTP 413", FailureKind::ContextOverflow, false),
        (
            "Model request failed (HTTP 429)",
            FailureKind::RateLimited,
            true,
        ),
        ("overloaded_error", FailureKind::RateLimited, true),
        (
            "Model request failed (HTTP 503)",
            FailureKind::Transport,
            true,
        ),
        ("ECONNRESET", FailureKind::Transport, true),
        ("HTTP 400 bad request", FailureKind::Other, false),
    ];
    for (message, kind, retryable) in cases {
        let reply = error_reply(message);
        assert_eq!(
            is_context_overflow(&reply),
            kind == FailureKind::ContextOverflow,
            "{message}"
        );
        assert_eq!(
            Failure::of_reply(&reply),
            Some(Failure {
                kind,
                message: message.into(),
                retryable,
                retry_after_ms: None,
                outcome_unknown: false,
            }),
            "{message}"
        );
    }
    // Only an error reply overflowed.
    let mut stopped = text_reply(StopReason::Stop, "context window");
    stopped.error_message = Some("context window".into());
    assert!(!is_context_overflow(&stopped));
    // No message: a failure of its own kind, not retryable.
    let mut bare = reply(StopReason::Error, &[]);
    bare.error_message = None;
    let failure = Failure::of_reply(&bare).unwrap();
    assert_eq!(
        (failure.kind, failure.retryable),
        (FailureKind::Other, false)
    );
    assert_eq!(failure.message, "");
}

#[test]
fn history_projection_repairs_calls_and_results() {
    let issued_two = reply(StopReason::ToolUse, &["a", "b"]);
    assert_eq!(
        issued(&Message::Assistant(issued_two.clone())),
        [("a", "fake"), ("b", "fake")]
    );
    // A reply that did not stop for tools issued nothing.
    assert!(issued(&Message::Assistant(reply(StopReason::Stop, &["a"]))).is_empty());
    assert!(issued(&user("hi")).is_empty());

    let history = vec![
        user("go"),
        // Both calls issued; b's result arrives first, a's never does.
        Message::Assistant(issued_two.clone()),
        result("b", "fake", "b done"),
        // A result of no call is dropped.
        result("ghost", "fake", "nobody asked"),
        // A result of the right id but the wrong tool is not a's.
        result("a", "other", "not a"),
        user("next"),
    ];
    let projected = project(&history, 9);
    assert_eq!(
        projected,
        [
            user("go"),
            Message::Assistant(issued_two),
            result("b", "fake", "b done"),
            interrupted_result("a".into(), "fake".into(), 9),
            user("next"),
        ]
    );
    assert!(matches!(
        &projected[3],
        Message::ToolResult {
            is_error: true,
            timestamp: 9,
            ..
        }
    ));
}

#[test]
fn history_projection_drops_calls_of_a_reply_that_did_not_stop_for_them() {
    let not_issued = reply(StopReason::Stop, &["a"]);
    let history = vec![Message::Assistant(not_issued), result("a", "fake", "x")];
    let projected = project(&history, 0);
    assert_eq!(projected.len(), 1);
    let Message::Assistant(reply) = &projected[0] else {
        panic!("expected the reply")
    };
    assert!(reply.content.is_empty());
}

#[test]
fn pairing_identifies_calls_by_occurrence_so_ids_can_be_reused() {
    let first = Message::Assistant(reply(StopReason::ToolUse, &["x"]));
    let again = Message::Assistant(reply(StopReason::ToolUse, &["x"]));
    let events = [
        Some(&first),
        None, // some other event keeps its index
        Some(&again),
        None,
    ];
    // While x is unanswered, a second x is not a call of its own.
    let pairing = Pairing::collect(events);
    assert_eq!(pairing.calls.len(), 1);
    assert!(pairing.calls.contains_key(&(0, 0)));
    assert!(pairing.results.is_empty());

    let answered = result("x", "fake", "1");
    let events = [Some(&first), Some(&answered), None, Some(&again)];
    let pairing = Pairing::collect(events);
    assert_eq!(pairing.calls.len(), 2);
    assert_eq!(pairing.results.get(&(0, 0)).map(|(at, _)| *at), Some(1));
    assert!(pairing.calls.contains_key(&(3, 0)));
}

#[test]
fn a_call_not_run_is_an_interrupted_error_result() {
    let aborted = ToolOutcome::not_run(NotRun::Aborted, 7);
    assert_eq!(aborted.status, ToolStatus::Interrupted);
    let Message::ToolResult {
        tool_call_id,
        tool_name,
        content,
        is_error,
        timestamp,
        ..
    } = aborted.message("c1", "bash")
    else {
        panic!("expected a tool result")
    };
    assert_eq!((tool_call_id.as_str(), tool_name.as_str()), ("c1", "bash"));
    assert!(is_error);
    assert_eq!(timestamp, 7);
    assert!(matches!(&content[0], UserBlock::Text { text, .. }
        if text == "Aborted by the user before this tool ran."));
    let interrupted = ToolOutcome::not_run(NotRun::Interrupted, 7);
    assert!(
        matches!(&interrupted.content[0], UserBlock::Text { text, .. }
        if text == "Interrupted: the user sent a message before this tool ran.")
    );
    // A completed outcome is not an error.
    let ok = outcome(ToolStatus::Completed, "done").message("c2", "read");
    assert!(matches!(
        ok,
        Message::ToolResult {
            is_error: false,
            ..
        }
    ));
}

fn text(text: &str) -> AssistantContent {
    AssistantContent::Text {
        text: text.into(),
        text_signature: None,
    }
}

#[test]
fn a_partial_follows_block_boundaries_and_breaks_out_of_order() {
    let mut partial = Partial::new(text_reply(StopReason::Stop, "dropped skeleton content"));
    assert!(partial.message().content.is_empty());
    assert!(partial.apply(&AssistantDelta::ThinkingStart { content_index: 0 }));
    // Content deltas change nothing.
    assert!(!partial.apply(&AssistantDelta::ThinkingDelta {
        content_index: 0,
        delta: "hm".into(),
    }));
    assert!(partial.apply(&AssistantDelta::ThinkingEnd {
        content_index: 0,
        content: "hmm".into(),
    }));
    assert!(partial.apply(&AssistantDelta::TextStart { content_index: 1 }));
    assert!(!partial.apply(&AssistantDelta::TextDelta {
        content_index: 1,
        delta: "Hel".into(),
    }));
    assert_eq!(partial.message().content[1], text(""));
    assert!(partial.apply(&AssistantDelta::TextEnd {
        content_index: 1,
        content: "Hello".into(),
    }));
    assert!(partial.apply(&AssistantDelta::ToolcallStart {
        content_index: 2,
        id: "c1".into(),
        tool_name: "bash".into(),
    }));
    // Arguments stay empty until the call ends.
    assert!(matches!(&partial.message().content[2],
        AssistantContent::ToolCall { arguments, .. } if arguments.is_empty()));
    let call = AssistantContent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        arguments: serde_json::from_value(serde_json::json!({ "command": "ls" })).unwrap(),
        thought_signature: None,
    };
    assert!(partial.apply(&AssistantDelta::ToolcallEnd {
        content_index: 2,
        tool_call: call.clone(),
    }));
    assert_eq!(
        partial.message().content,
        [
            AssistantContent::Thinking {
                thinking: "hmm".into(),
                signature: None,
                redacted: None,
            },
            text("Hello"),
            call,
        ]
    );
    assert!(!partial.broken());

    // A start not at the end breaks it; nothing changes afterwards.
    assert!(!partial.apply(&AssistantDelta::TextStart { content_index: 7 }));
    assert!(partial.broken());
    assert!(!partial.apply(&AssistantDelta::TextStart { content_index: 3 }));
    assert_eq!(partial.message().content.len(), 3);

    // An end of no block breaks a fresh one too.
    let mut fresh = Partial::new(reply(StopReason::Stop, &[]));
    assert!(!fresh.apply(&AssistantDelta::TextEnd {
        content_index: 0,
        content: "x".into(),
    }));
    assert!(fresh.broken());
    assert_eq!(fresh.into_message().content, []);
}

#[test]
fn the_core_builds_the_partial_from_deltas_per_attempt() {
    let mut core = Loop::new(0, vec![]);
    // Nothing streams before a request.
    let skeleton = reply(StopReason::Stop, &[]);
    let start = AssistantDelta::TextStart { content_index: 0 };
    let request = model(core.advance(vec![]).unwrap());
    // Deltas of no attempt are ignored, not errors.
    assert_eq!(core.stream_delta(request.ticket, &start), Ok(false));
    assert!(core.partial().is_none());

    core.stream_start(request.ticket, skeleton.clone()).unwrap();
    assert_eq!(core.partial().unwrap().content, []);
    assert_eq!(core.stream_delta(request.ticket, &start), Ok(true));
    assert_eq!(
        core.stream_delta(
            request.ticket,
            &AssistantDelta::TextDelta {
                content_index: 0,
                delta: "pa".into()
            }
        ),
        Ok(false)
    );
    assert_eq!(
        core.stream_delta(
            request.ticket,
            &AssistantDelta::TextEnd {
                content_index: 0,
                content: "partial".into()
            }
        ),
        Ok(true)
    );
    assert_eq!(core.partial().unwrap().content, [text("partial")]);
    assert!(core.history().is_empty());

    // A retry starts over.
    core.stream_start(request.ticket, skeleton.clone()).unwrap();
    assert_eq!(core.partial().unwrap().content, []);
    assert_eq!(core.stream_delta(request.ticket, &start), Ok(true));

    // A transport failure keeps the partial built so far.
    let step = core
        .fail_model(request.ticket, failure(FailureKind::Transport))
        .unwrap();
    let Step::Suspended(record) = step else {
        panic!("expected suspension, got {step:?}")
    };
    assert_eq!(record.partial.as_ref().unwrap().content, [text("")]);
    assert_eq!(
        core.stream_start(request.ticket, skeleton),
        Err(ResumeError::WrongState)
    );
    assert_eq!(
        core.stream_delta(request.ticket, &start),
        Err(ResumeError::WrongState)
    );
}

#[test]
fn a_stale_ticket_cannot_stream_into_the_current_attempt() {
    let mut core = Loop::new(0, vec![]);
    let first = model(core.advance(vec![]).unwrap());
    core.finish_model(first.ticket, text_reply(StopReason::Stop, "one"), None)
        .unwrap();
    let second = model(core.advance(vec![user("more")]).unwrap());
    core.stream_start(second.ticket, reply(StopReason::Stop, &[]))
        .unwrap();
    assert_eq!(
        core.stream_start(first.ticket, reply(StopReason::Stop, &[])),
        Err(ResumeError::StaleTicket)
    );
    assert_eq!(
        core.stream_delta(
            first.ticket,
            &AssistantDelta::TextStart { content_index: 0 }
        ),
        Err(ResumeError::StaleTicket)
    );
    assert_eq!(core.partial().unwrap().content, []);
    // The reply, not the partial, is what history gets.
    core.finish_model(second.ticket, text_reply(StopReason::Stop, "two"), None)
        .unwrap();
    assert!(core.partial().is_none());
    assert_eq!(core.history().len(), 3);
}
