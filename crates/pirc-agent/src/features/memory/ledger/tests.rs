//! The ledger cases of `agent-memory.test.ts`.

use std::cell::Cell;

use pirc_protocol::{AssistantMessage, StopReason, UserContent};
use serde_json::json;

use super::*;
use crate::messages::empty_usage;

thread_local! {
    static NEXT: Cell<u32> = const { Cell::new(0) };
}

fn next_id(prefix: &str) -> String {
    NEXT.with(|n| {
        n.set(n.get() + 1);
        format!("{prefix}{}", n.get())
    })
}

/// A message entry (`msg` of the TS tests).
pub fn msg(user: bool, text: &str) -> SessionEntry {
    let message = if user {
        Message::User {
            content: UserContent::Text(text.to_owned()),
            timestamp: 0,
        }
    } else {
        Message::Assistant(AssistantMessage {
            content: vec![pirc_protocol::AssistantContent::Text {
                text: text.to_owned(),
                text_signature: None,
            }],
            api: "openai-chat".to_owned(),
            provider: "p".to_owned(),
            model: "m".to_owned(),
            usage: empty_usage(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 0,
            completed_at: None,
            canonical_provider: None,
            response_id: None,
            response_model: None,
        })
    };
    entry(EntryData::Message(message))
}

pub fn entry(data: EntryData) -> SessionEntry {
    SessionEntry {
        id: next_id("m"),
        parent_id: None,
        timestamp: 0,
        data,
    }
}

pub fn custom(custom_type: &str, data: Value) -> SessionEntry {
    entry(EntryData::Custom {
        custom_type: custom_type.to_owned(),
        data,
    })
}

/// `obs(content, source, relevance)`.
pub fn obs(content: &str, source: &str, relevance: &str) -> Value {
    json!({ "id": hash_id(content), "content": content, "timestamp": "2026-01-01 10:00",
        "relevance": relevance, "sourceEntryIds": [source], "tokenCount": 10 })
}

#[test]
fn folds_first_wins_observations_with_drop_tombstones() {
    let a = msg(true, "hello");
    let o1 = obs("User said hello", &a.id, "medium");
    let branch = vec![
        a.clone(),
        custom(
            OBS_RECORDED,
            json!({ "observations": [o1, o1], "coversUpToId": a.id }),
        ),
        custom(
            OBS_DROPPED,
            json!({ "observationIds": [o1["id"], "ffffffffffff"], "coversUpToId": a.id }),
        ),
        custom(
            OBS_RECORDED,
            json!({ "observations": [{ "bogus": true }], "coversUpToId": a.id }),
        ),
    ];
    let folded = fold_ledger(&branch);
    assert_eq!(folded.observations.len(), 1);
    assert!(folded.active_observations.is_empty());
    assert_eq!(folded.dropped.len(), 2);
}

#[test]
fn keeps_reflections_frozen_until_a_full_fold() {
    let (a, b, c) = (msg(true, "one"), msg(true, "two"), msg(true, "three"));
    let o1 = obs("first fact", &a.id, "medium");
    let o2 = obs("second fact", &b.id, "medium");
    let durable = json!({ "id": hash_id("durable"), "content": "durable",
        "supportingObservationIds": [o1["id"]], "tokenCount": 2 });
    let branch = vec![
        a.clone(),
        b.clone(),
        c.clone(),
        custom(
            OBS_RECORDED,
            json!({ "observations": [o1], "coversUpToId": a.id }),
        ),
        custom(
            OBS_RECORDED,
            json!({ "observations": [o2], "coversUpToId": b.id }),
        ),
        custom(
            REF_RECORDED,
            json!({ "reflections": [durable], "coversUpToId": b.id }),
        ),
        custom(
            OBS_DROPPED,
            json!({ "observationIds": [o1["id"]], "coversUpToId": a.id }),
        ),
    ];
    let contents = |items: &[Observation]| -> Vec<String> {
        items.iter().map(|o| o.content.clone()).collect()
    };
    let normal = build_compaction_projection(&branch, &c.id, 1000.0);
    assert!(!normal.full_fold);
    assert_eq!(
        contents(&normal.observations),
        ["first fact", "second fact"]
    );
    assert!(normal.reflections.is_empty());
    let full = build_compaction_projection(&branch, &c.id, 15.0);
    assert!(full.full_fold);
    assert_eq!(contents(&full.observations), ["second fact"]);
    assert_eq!(full.reflections[0].content, "durable");
    // Observations after the cut are excluded (kept raw instead).
    let early = build_compaction_projection(&branch, &a.id, 1000.0);
    assert_eq!(contents(&early.observations), ["first fact"]);
    let summary = render_summary(&full.reflections, &full.observations);
    assert!(summary.contains(&format!(
        "## Reflections\n[{}] durable\n\n## Observations\n[{}] 2026-01-01 10:00 [medium] second fact",
        hash_id("durable"),
        o2["id"].as_str().unwrap()
    )));
    // The details round-trip as folded details.
    let details = full.to_value();
    assert_eq!(folded_details(Some(&details)), Some(full));
    assert!(!is_folded_details(Some(&json!({ "type": "om.folded" }))));
}

#[test]
fn validates_records_as_ts_does() {
    let good = obs("x", "m1", "low");
    assert!(is_observation(&good));
    for broken in [
        json!({ "id": "ABCDEFABCDEF" }),
        json!({ "id": hash_id("x"), "content": "x", "timestamp": "t", "relevance": "huge",
            "sourceEntryIds": ["m1"], "tokenCount": 1 }),
        json!({ "id": hash_id("x"), "content": "x", "timestamp": "t", "relevance": "low",
            "sourceEntryIds": [], "tokenCount": 1 }),
        json!({ "id": hash_id("x"), "content": "x", "timestamp": "t", "relevance": "low",
            "sourceEntryIds": ["m1"], "origins": [1], "tokenCount": 1 }),
    ] {
        assert!(!is_observation(&broken), "{broken}");
    }
    let reflection = |content: &str| {
        json!({ "id": hash_id(content), "content": content,
            "supportingObservationIds": ["a"], "tokenCount": 1 })
    };
    assert!(is_reflection(&reflection("one line")));
    assert!(!is_reflection(&reflection("two\nlines")));
}

#[test]
fn hashes_truncates_and_merges_origins() {
    assert_eq!(hash_id("durable").len(), 12);
    assert!(is_memory_id(&hash_id("durable")));
    let long = "x".repeat(10_050);
    let cut = truncate_content(&long);
    assert_eq!(js::len16(&cut), 10_000);
    assert!(cut.ends_with(" … [truncated 50 chars]"));
    let user = vec!["user".to_owned()];
    assert_eq!(
        merge_origins([Some(user.as_slice()), None]),
        ["unknown", "user"]
    );
}

#[test]
fn counts_tokens_since_coverage_from_usage() {
    let a = msg(true, "hello there");
    let mut reply = msg(false, "hi");
    if let EntryData::Message(Message::Assistant(message)) = &mut reply.data {
        message.usage.total_tokens = 150;
    }
    let branch = vec![a.clone(), reply.clone()];
    // Nothing covered and no compaction: the current context.
    assert_eq!(
        tokens_since_coverage(&branch, LedgerType::Observations, 160),
        160
    );
    let mut covered = branch.clone();
    covered.push(custom(
        OBS_RECORDED,
        json!({ "observations": [obs("x", &a.id, "low")], "coversUpToId": reply.id }),
    ));
    // Since the usage at the coverage point.
    assert_eq!(
        tokens_since_coverage(&covered, LedgerType::Observations, 170),
        20
    );
    // Below the baseline: the estimate.
    assert_eq!(
        tokens_since_coverage(&covered, LedgerType::Observations, 100),
        0
    );
    assert_eq!(raw_tokens_since_last_compaction(&branch), 3 + 1);
}
