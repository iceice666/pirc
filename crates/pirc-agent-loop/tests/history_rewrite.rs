mod support;

use std::sync::Arc;

use pirc_agent_loop::{history::*, *};
use pirc_llm_types::*;
use support::*;

fn memory(text: &str) -> Message {
    Message::Custom {
        custom_type: "retrieved-memory".into(),
        content: text.into(),
        display: false,
        details: None,
        timestamp: 4,
    }
}

fn result(id: &str) -> Message {
    outcome(ToolStatus::Completed, id).message(id, "fake")
}

#[test]
fn memory_strategies_can_replace_insert_and_drop_without_mutating_sources() {
    let mut core = Loop::new(1, vec![user("old"), user("recent")]);
    let original = core.history_snapshot();
    core.rewrite_history(Rewrite::new(original.clone(), 0..1, vec![memory("facts")]))
        .unwrap();
    assert_eq!(core.history(), [memory("facts"), user("recent")]);
    assert_eq!(*original, [user("old"), user("recent")]);
    assert_eq!(core.status(), Status::Idle);
    let base = core.history_snapshot();
    core.rewrite_history(Rewrite::new(base, 1..1, vec![memory("RAG")]))
        .unwrap();
    assert_eq!(
        core.history(),
        [memory("facts"), memory("RAG"), user("recent")]
    );
    let base = core.history_snapshot();
    core.rewrite_history(Rewrite::new(base, 0..2, vec![]))
        .unwrap();
    assert_eq!(core.history(), [user("recent")]);
    assert!(core.tool_records().is_empty());
    assert!(core.failures().is_empty());
}

#[test]
fn stale_and_foreign_snapshot_rewrites_are_atomic() {
    let mut core = Loop::new(0, vec![user("first")]);
    let old = core.history_snapshot();
    core.rewrite_history(Rewrite::new(old.clone(), 0..0, vec![memory("one")]))
        .unwrap();
    let expected = core.history_snapshot();
    assert_eq!(
        core.rewrite_history(Rewrite::new(old, 0..1, vec![])),
        Err(RewriteError::StaleSnapshot)
    );
    let equal_but_foreign = Arc::new(core.history().to_vec());
    assert_eq!(
        core.rewrite_history(Rewrite::new(equal_but_foreign, 0..1, vec![])),
        Err(RewriteError::StaleSnapshot)
    );
    assert_eq!(
        core.rewrite_history(Rewrite::new(expected.clone(), 0..99, vec![])),
        Err(RewriteError::InvalidRange)
    );
    assert!(Arc::ptr_eq(&expected, &core.history_snapshot()));
    assert_eq!(core.status(), Status::Idle);
}

#[test]
fn ordinary_history_growth_and_rebinding_invalidate_old_plans() {
    let mut core = Loop::new(0, vec![user("old")]);
    let stale = core.history_snapshot();
    let pending = model(core.advance(vec![user("new")]).unwrap());
    core.finish_model(pending.ticket, text_reply(StopReason::Stop, "done"), None)
        .unwrap();
    assert_eq!(
        core.rewrite_history(Rewrite::new(stale, 0..1, vec![])),
        Err(RewriteError::StaleSnapshot)
    );
    let stale = core.history_snapshot();
    core.rebind(1, user("host notice"), 9).unwrap();
    assert_eq!(
        core.rewrite_history(Rewrite::new(stale, 0..0, vec![])),
        Err(RewriteError::StaleSnapshot)
    );
    assert_eq!(core.history().last(), Some(&user("host notice")));
}

#[test]
fn overlapping_tool_batches_have_safe_union_boundaries() {
    let messages = vec![
        Message::Assistant(reply(StopReason::ToolUse, &["a"])),
        Message::Assistant(reply(StopReason::ToolUse, &["b"])),
        result("a"),
        result("b"),
        user("tail"),
    ];
    assert_eq!(
        safe_boundaries(&messages).unwrap(),
        [true, false, false, false, true, true]
    );
    let base = Arc::new(messages);
    assert_eq!(
        Rewrite::new(base.clone(), 0..3, vec![]).apply(),
        Err(RewriteError::SplitToolGroup)
    );
    assert_eq!(
        Rewrite::new(base, 0..4, vec![]).apply().unwrap(),
        [user("tail")]
    );
}

#[test]
fn whole_multicall_groups_are_indivisible_including_interleaved_content() {
    let history = Arc::new(vec![
        user("start"),
        Message::Assistant(reply(StopReason::ToolUse, &["a", "b"])),
        result("b"),
        memory("interleaved"),
        result("a"),
        user("next"),
    ]);
    assert_eq!(
        safe_boundaries(&history).unwrap(),
        [true, true, false, false, false, true, true]
    );
    for range in [1..2, 2..5, 3..3, 4..6] {
        assert_eq!(
            Rewrite::new(history.clone(), range, vec![]).apply(),
            Err(RewriteError::SplitToolGroup)
        );
    }
    assert_eq!(
        Rewrite::new(history.clone(), 1..5, vec![memory("summary")])
            .apply()
            .unwrap(),
        [user("start"), memory("summary"), user("next")]
    );
    assert_eq!(history.len(), 6);
}

#[test]
fn invalid_history_is_not_silently_repaired_and_ids_may_be_reused() {
    let valid = Arc::new(vec![
        Message::Assistant(reply(StopReason::ToolUse, &["same"])),
        result("same"),
        Message::Assistant(reply(StopReason::ToolUse, &["same"])),
        result("same"),
    ]);
    assert!(safe_boundaries(&valid).is_ok());
    assert_eq!(
        Rewrite::new(valid, 0..2, vec![memory("summary")])
            .apply()
            .unwrap()
            .len(),
        3
    );
    let mut wrong_name = result("a");
    if let Message::ToolResult { tool_name, .. } = &mut wrong_name {
        *tool_name = "other".into();
    }
    for invalid in [
        vec![result("orphan")],
        vec![Message::Assistant(reply(StopReason::ToolUse, &["a"]))],
        vec![
            Message::Assistant(reply(StopReason::ToolUse, &["a", "a"])),
            result("a"),
        ],
        vec![
            Message::Assistant(reply(StopReason::ToolUse, &[""])),
            result(""),
        ],
        vec![Message::Assistant(reply(StopReason::Stop, &["a"]))],
        vec![
            Message::Assistant(reply(StopReason::ToolUse, &["a"])),
            wrong_name,
        ],
    ] {
        assert_eq!(safe_boundaries(&invalid), Err(RewriteError::InvalidHistory));
    }
    let mut core = Loop::new(0, vec![user("keep")]);
    let base = core.history_snapshot();
    assert_eq!(
        core.rewrite_history(Rewrite::new(base.clone(), 0..0, vec![result("orphan")])),
        Err(RewriteError::InvalidHistory)
    );
    assert!(Arc::ptr_eq(&base, &core.history_snapshot()));
}

#[test]
fn tool_continuation_can_rewrite_its_undispatched_request_and_fence_old_ticket() {
    let mut core = Loop::new(1, vec![user("task")]);
    let first = model(core.advance(vec![]).unwrap());
    let calls = tools(
        core.finish_model(first.ticket, reply(StopReason::ToolUse, &["a"]), None)
            .unwrap(),
    );
    let pending = model(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "done"))
            .unwrap(),
    );
    let records = core.tool_records().to_vec();
    let next = core
        .rewrite_request(
            pending.ticket,
            Rewrite::new(pending.messages.clone(), 0..3, vec![memory("tool facts")]),
        )
        .unwrap();
    assert_ne!(next.ticket, pending.ticket);
    assert!(!core.is_current_model(pending.ticket));
    assert!(core.is_current_model(next.ticket));
    assert_eq!(*next.messages, [memory("tool facts")]);
    assert_eq!(core.tool_records(), records);
    assert_eq!(pending.messages.len(), 3);
    assert_eq!(
        core.finish_model(
            pending.ticket,
            reply(StopReason::ToolUse, &["must-not-run"]),
            None
        ),
        Err(ResumeError::StaleTicket)
    );
    assert_eq!(
        core.finish_model(next.ticket, text_reply(StopReason::Stop, "ok"), None)
            .unwrap(),
        Step::Idle
    );
    assert!(!core.is_current_model(next.ticket));
}

#[test]
fn started_streams_waiting_tools_failures_and_terminal_states_refuse_rewrites() {
    let mut core = Loop::new(0, vec![user("go")]);
    let request = model(core.advance(vec![]).unwrap());
    let plan = Rewrite::new(request.messages.clone(), 0..0, vec![memory("x")]);
    assert_eq!(
        core.rewrite_history(plan.clone()),
        Err(RewriteError::WrongState)
    );
    assert_eq!(
        core.rewrite_request(request.ticket, Rewrite::new(Arc::new(vec![]), 0..0, vec![])),
        Err(RewriteError::StaleSnapshot)
    );
    assert_eq!(
        core.rewrite_request(
            request.ticket,
            Rewrite::new(request.messages.clone(), 0..99, vec![])
        ),
        Err(RewriteError::InvalidRange)
    );
    core.stream_start(request.ticket, reply(StopReason::Stop, &[]))
        .unwrap();
    assert_eq!(
        core.rewrite_request(request.ticket, plan.clone()),
        Err(RewriteError::WrongState)
    );
    let calls = tools(
        core.finish_model(request.ticket, reply(StopReason::ToolUse, &["a"]), None)
            .unwrap(),
    );
    assert_eq!(
        core.rewrite_request(request.ticket, plan),
        Err(RewriteError::WrongState)
    );
    let base = core.history_snapshot();
    assert_eq!(
        core.rewrite_history(Rewrite::new(base, 0..0, vec![])),
        Err(RewriteError::WrongState)
    );
    let next = model(
        core.resume_tool(calls[0].key, outcome(ToolStatus::Completed, "x"))
            .unwrap(),
    );
    core.fail_model(next.ticket, failure(FailureKind::Transport))
        .unwrap();
    let failures = core.failures().to_vec();
    let base = core.history_snapshot();
    assert_eq!(
        core.rewrite_history(Rewrite::new(base, 0..0, vec![])),
        Err(RewriteError::WrongState)
    );
    assert_eq!(core.failures(), failures);
    core.recover(next.ticket, Recovery::Stop).unwrap();
    let base = core.history_snapshot();
    assert_eq!(
        core.rewrite_history(Rewrite::new(base, 0..0, vec![])),
        Err(RewriteError::WrongState)
    );
}

#[test]
fn host_projection_preserves_metadata_and_leaves_recovery_to_the_host() {
    let source = [("old", user("old")), ("retained", result("orphan"))];
    let prefix = [("memory-id", memory("any memory backend"))];
    let projected: Vec<_> = replace_prefix(source.iter(), 1, prefix.iter())
        .unwrap()
        .cloned()
        .collect();
    assert_eq!(projected, [prefix[0].clone(), source[1].clone()]);
    assert_eq!(source[0].0, "old");
    assert!(replace_prefix(source.iter(), 3, prefix.iter()).is_err());
    let messages: Vec<_> = projected.into_iter().map(|(_, message)| message).collect();
    assert_eq!(project(&messages, 10), [memory("any memory backend")]);
}
