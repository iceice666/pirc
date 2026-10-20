use serde_json::json;

use super::*;
use crate::db::Db;
use crate::db::rooms::GENERAL_ROOM_ID;

const ME: &str = "me@example.com";

fn new_wake(at: i64) -> NewWake<'static> {
    NewWake {
        kind: Kind::SelfScheduled,
        trigger: json!({ "at": at, "why": "look at the dotfiles" }),
        room_id: GENERAL_ROOM_ID,
        user: Some(ME),
        scheduled_at: at,
    }
}

#[test]
fn wakes_wait_start_end_and_come_back_once() {
    let db = Db::memory();
    let conn = db.lock();
    let now = 1_000_000;
    assert_eq!(next(&conn, now).unwrap(), (None, None));
    let later = enqueue(&conn, &new_wake(now + 5_000), now).unwrap();
    let first = enqueue(&conn, &new_wake(now - 1), now).unwrap();
    assert!(later.id.starts_with("wake_"));
    assert_eq!(
        (
            later.attempt,
            later.face_id.as_deref(),
            later.user.as_deref()
        ),
        (1, Some("host"), Some(ME))
    );
    let (due, _) = next(&conn, now).unwrap();
    assert_eq!(due.unwrap().id, first.id, "the one due first");
    let running = start(&conn, &first.id, "turn_1", now).unwrap();
    assert_eq!(
        (running.started_at, running.turn_id.as_deref()),
        (Some(now), Some("turn_1"))
    );
    assert_eq!(
        next(&conn, now).unwrap(),
        (None, Some(now + 5_000)),
        "a running wake is not due again"
    );
    assert_eq!(
        cancel(&conn, &first.id, now).unwrap_err().code,
        "wake_running"
    );

    // People took over: it ends, and comes back as a second attempt.
    let ended = end(&conn, &first.id, Outcome::Preempted, None, now + 1).unwrap();
    assert_eq!(ended.outcome.as_deref(), Some("preempted"));
    let again = put_back(&conn, &ended, now + 2).unwrap();
    assert_eq!(
        (again.attempt, again.scheduled_at, again.trigger.clone()),
        (2, now + 2, ended.trigger.clone())
    );
    assert_ne!(again.id, ended.id);
    // Ending twice keeps the first ending.
    let kept = end(&conn, &first.id, Outcome::Spoke, None, now + 3).unwrap();
    assert_eq!(kept.outcome.as_deref(), Some("preempted"));

    // Cancelled before it starts; cancelling again changes nothing.
    let (cancelled, unchanged) = cancel(&conn, &later.id, now + 4).unwrap();
    assert!(!unchanged);
    assert_eq!(cancelled.outcome.as_deref(), Some("cancelled"));
    assert!(cancel(&conn, &later.id, now + 5).unwrap().1);
    assert_eq!(
        cancel(&conn, "wake_none", now).unwrap_err().code,
        "not_found"
    );

    let pending = list(&conn, None, Status::Pending, 10).unwrap();
    assert_eq!(
        pending.iter().map(|w| &w.id).collect::<Vec<_>>(),
        [&again.id]
    );
    let ended = list(&conn, Some(GENERAL_ROOM_ID), Status::Ended, 10).unwrap();
    assert_eq!(
        ended.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
        [later.id.as_str(), first.id.as_str()],
        "the latest first"
    );
    assert!(
        list(&conn, Some("room_other"), Status::Ended, 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_restart_ends_the_running_wake() {
    let db = Db::memory();
    let conn = db.lock();
    let wake = enqueue(&conn, &new_wake(10), 10).unwrap();
    let waiting = enqueue(&conn, &new_wake(20), 10).unwrap();
    start(&conn, &wake.id, "turn_1", 11).unwrap();
    let closed = close_interrupted(&conn, 12).unwrap();
    assert_eq!(closed.len(), 1);
    assert_eq!(
        (closed[0].outcome.as_deref(), closed[0].note.as_deref()),
        (Some("failed"), Some("interrupted"))
    );
    assert_eq!(
        get(&conn, &waiting.id).unwrap().outcome,
        None,
        "still waiting"
    );
}

#[test]
fn only_the_due_time_of_an_auto_close_anchor_closes_its_loop() {
    let wake = |moment: &str, auto_close: bool, kind: &str| Wake {
        id: "w".into(),
        kind: kind.into(),
        trigger: json!({ "loopId": "l1", "moment": moment, "autoClose": auto_close }),
        room_id: GENERAL_ROOM_ID.into(),
        face_id: None,
        user: None,
        scheduled_at: 0,
        started_at: None,
        ended_at: None,
        outcome: None,
        note: None,
        attempt: 1,
        turn_id: None,
        created_at: 0,
    };
    assert!(wake(moment::DUE, true, "anchor").closes_loop());
    assert!(!wake(moment::EVE, true, "anchor").closes_loop());
    assert!(!wake(moment::DUE, false, "anchor").closes_loop());
    assert!(!wake(moment::DUE, true, "self").closes_loop());
    assert_eq!(wake(moment::DUE, true, "anchor").loop_id(), Some("l1"));
}

#[test]
fn why_is_one_short_line() {
    assert_eq!(
        why("  look at\nthe dotfiles ").unwrap(),
        "look at the dotfiles"
    );
    assert_eq!(why(" ").unwrap_err(), "`why` is required");
    assert!(why(&"x".repeat(301)).is_err());
}
