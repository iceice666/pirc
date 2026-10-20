use super::*;
use crate::db::Db;
use crate::time::cron::date_utc;

const ME: &str = "me@example.com";

/// Tuesday 2026-10-20 10:00 UTC.
fn tuesday() -> i64 {
    date_utc(2026, 9, 20, 10, 0, 0, 0)
}

fn anchor(at: Option<&str>, cron: Option<&str>) -> AnchorInput {
    AnchorInput {
        at: at.map(str::to_owned),
        cron: cron.map(str::to_owned),
        ..Default::default()
    }
}

fn said<'a>(what: &'a str, anchor: Option<Anchor>) -> NewLoop<'a> {
    NewLoop {
        user: ME,
        room_id: Some("general"),
        face_id: Some("host"),
        what,
        why: "",
        origin: "user",
        anchor,
        next_check: None,
        source_entry_ids: &[],
    }
}

#[test]
fn anchors_are_checked_and_say_when_they_come() {
    let now = tuesday();
    let meeting = anchor(None, Some("0 18 * * 3"))
        .resolve("UTC", now)
        .unwrap();
    assert_eq!(meeting.due_at, date_utc(2026, 9, 21, 18, 0, 0, 0));
    assert_eq!(
        describe_anchor(&meeting.json, Some(meeting.due_at)),
        "next Wed 2026-10-21 18:00 (UTC), repeats `0 18 * * 3`"
    );
    let taipei = AnchorInput {
        zone: Some("Asia/Taipei".into()),
        ..anchor(Some("2026-10-24T23:59"), None)
    }
    .resolve("UTC", now)
    .unwrap();
    assert_eq!(taipei.due_at, date_utc(2026, 9, 24, 15, 59, 0, 0));
    assert_eq!(taipei.json["autoClose"], false);
    assert_eq!(
        describe_anchor(&taipei.json, Some(taipei.due_at)),
        "due Sat 2026-10-24 23:59 (Asia/Taipei)"
    );
    let until = AnchorInput {
        until: Some("2026-11-30T00:00".into()),
        ..anchor(None, Some("0 18 * * 3"))
    }
    .resolve("UTC", now)
    .unwrap();
    assert_eq!(until.json["until"], date_utc(2026, 10, 30, 0, 0, 0, 0));

    let refused = |input: AnchorInput| input.resolve("UTC", now).unwrap_err();
    assert_eq!(
        refused(anchor(Some("2026-10-19T10:00"), None)),
        "That time has passed"
    );
    assert_eq!(
        refused(anchor(None, None)),
        "An anchor has `at` (one time) or `cron` (a recurrence)"
    );
    assert_eq!(
        refused(anchor(Some("2026-10-22T18:00"), Some("0 18 * * 3"))),
        "An anchor has `at` (one time) or `cron` (a recurrence)"
    );
    assert!(refused(anchor(None, Some("0 25 * * *"))).starts_with("Invalid cron \"0 25 * * *\": "));
    assert_eq!(
        refused(anchor(Some("next wednesday"), None)),
        "`at` is a date and time like 2026-10-22T18:00"
    );
    assert_eq!(
        refused(AnchorInput {
            zone: Some("Mars/Base".into()),
            ..anchor(Some("2026-10-22T18:00"), None)
        }),
        "Unknown time zone `Mars/Base`"
    );
    assert_eq!(
        refused(AnchorInput {
            auto_close: Some(true),
            ..anchor(None, Some("0 18 * * 3"))
        }),
        "`autoClose` is for a one-time anchor (`at`); a recurrence ends at `until`"
    );
    assert_eq!(
        refused(AnchorInput {
            until: Some("2026-10-21T12:00".into()),
            ..anchor(None, Some("0 18 * * 3"))
        }),
        "It does not come before `until`"
    );
}

#[test]
fn loops_open_once_change_close_and_reopen() {
    let db = Db::memory();
    let conn = db.lock();
    let now = tuesday();
    let (power, unchanged) =
        open(&conn, &said("Tune the laptop's power policy", None), now).unwrap();
    assert!(!unchanged);
    assert!(power.id.starts_with('l') && power.id.len() == 9);
    assert_eq!(
        (power.status.as_str(), power.anchor.clone()),
        ("open", None)
    );
    // The same thing again is the same loop, touched.
    let (again, unchanged) = open(
        &conn,
        &said("tune the laptop's  POWER policy", None),
        now + 5,
    )
    .unwrap();
    assert!(unchanged);
    assert_eq!(
        (again.id.as_str(), again.last_touched_at),
        (power.id.as_str(), now + 5)
    );

    let anchor = anchor(Some("2026-10-22T18:00"), None)
        .resolve("UTC", now)
        .unwrap();
    let changed = update(
        &conn,
        &power.id,
        &Changes {
            why: Some("battery dies by noon"),
            next_check: Some(Some("look at his TLP config")),
            anchor: Some(Some(anchor.clone())),
            ..Default::default()
        },
        now + 10,
    )
    .unwrap();
    assert_eq!(changed.why, "battery dies by noon");
    assert_eq!(
        changed.next_check.as_deref(),
        Some("look at his TLP config")
    );
    assert_eq!(changed.due_at, Some(anchor.due_at));
    assert_eq!(next_due(&conn).unwrap(), Some(anchor.due_at));

    let (closed, unchanged) = close(&conn, &power.id, "He switched to TLP", now + 20).unwrap();
    assert!(!unchanged);
    assert_eq!(
        (
            closed.status.as_str(),
            closed.closed_reason.as_deref(),
            closed.due_at
        ),
        ("closed", Some("He switched to TLP"), None)
    );
    assert_eq!(next_due(&conn).unwrap(), None);
    assert!(close(&conn, &power.id, "again", now + 21).unwrap().1);
    assert_eq!(
        touch(&conn, &power.id, now).unwrap_err().code,
        "loop_closed"
    );
    assert_eq!(list_closed(&conn, 10).unwrap().len(), 1);

    // Reopened before its time: the anchor comes again.
    let (reopened, unchanged) = reopen(&conn, &power.id, now + 30).unwrap();
    assert!(!unchanged);
    assert_eq!(
        (
            reopened.status.as_str(),
            reopened.closed_reason.clone(),
            reopened.due_at
        ),
        ("open", None, Some(anchor.due_at))
    );
    assert!(reopen(&conn, &power.id, now + 31).unwrap().1);
    assert_eq!(get(&conn, "l00000000").unwrap_err().code, "not_found");
    assert_eq!(
        open(&conn, &said("  ", None), now).unwrap_err().message,
        "`what` is required"
    );
}

#[test]
fn anchors_close_wait_or_move_on_when_they_come() {
    let db = Db::memory();
    let conn = db.lock();
    let now = tuesday();
    let resolve = |input: AnchorInput| Some(input.resolve("UTC", now).unwrap());
    let (meeting, _) = open(
        &conn,
        &said(
            "Dentist",
            resolve(AnchorInput {
                auto_close: Some(true),
                ..anchor(Some("2026-10-20T11:00"), None)
            }),
        ),
        now,
    )
    .unwrap();
    let (call, _) = open(
        &conn,
        &said(
            "Call the bank",
            resolve(anchor(Some("2026-10-20T11:00"), None)),
        ),
        now,
    )
    .unwrap();
    let (weekly, _) = open(
        &conn,
        &said(
            "Team meeting",
            resolve(AnchorInput {
                until: Some("2026-10-28T20:00".into()),
                ..anchor(None, Some("0 18 * * 3"))
            }),
        ),
        now,
    )
    .unwrap();
    assert_eq!(fire_due(&conn, now, false).unwrap(), []);
    assert_eq!(
        next_due(&conn).unwrap(),
        Some(date_utc(2026, 9, 20, 11, 0, 0, 0))
    );

    let fired = fire_due(&conn, date_utc(2026, 9, 20, 11, 0, 0, 0), false).unwrap();
    let mut kinds: Vec<(&str, Fired)> = fired.iter().map(|(l, f, _)| (l.id.as_str(), *f)).collect();
    kinds.sort_by_key(|(id, _)| *id != meeting.id);
    assert_eq!(
        kinds,
        [
            (meeting.id.as_str(), Fired::Elapsed),
            (call.id.as_str(), Fired::Passed)
        ]
    );
    let elapsed = get(&conn, &meeting.id).unwrap();
    assert_eq!(elapsed.closed_reason.as_deref(), Some(ELAPSED));
    let waiting = get(&conn, &call.id).unwrap();
    assert_eq!((waiting.status.as_str(), waiting.due_at), ("open", None));
    assert_eq!(waiting.anchor.as_ref().unwrap()["passed"], true);
    assert_eq!(
        describe_anchor(waiting.anchor.as_ref().unwrap(), None),
        "was due Tue 2026-10-20 11:00 (UTC)"
    );

    // Wednesday 18:00: on to the next Wednesday; the one after is past
    // `until`, so the recurrence ends there.
    let first = date_utc(2026, 9, 21, 18, 0, 0, 0);
    assert_eq!(next_due(&conn).unwrap(), Some(first));
    let fired = fire_due(&conn, first + 1_000, false).unwrap();
    assert_eq!(fired.len(), 1);
    assert_eq!((fired[0].1, fired[0].2), (Fired::Advanced, first));
    let second = date_utc(2026, 9, 28, 18, 0, 0, 0);
    assert_eq!(fired[0].0.due_at, Some(second));
    assert_eq!(fired[0].0.anchor.as_ref().unwrap()["nextAt"], second);
    let fired = fire_due(&conn, second, false).unwrap();
    assert_eq!(fired[0].1, Fired::Ended);
    let ended = get(&conn, &weekly.id).unwrap();
    assert_eq!(
        (ended.status.as_str(), ended.closed_reason.as_deref()),
        ("closed", Some(RECURRENCE_ENDED))
    );
    assert_eq!(next_due(&conn).unwrap(), None);
}

#[test]
fn a_time_that_is_the_thing_itself_comes_the_day_before_and_waits_for_its_wake() {
    let db = Db::memory();
    let conn = db.lock();
    let now = tuesday();
    let deadline = |at: &str, now: i64| {
        AnchorInput {
            auto_close: Some(true),
            ..anchor(Some(at), None)
        }
        .resolve("UTC", now)
        .unwrap()
    };
    let thursday = date_utc(2026, 9, 22, 11, 0, 0, 0);
    let wednesday = thursday - DAY_MS;
    let hw = deadline("2026-10-22T11:00", now);
    assert_eq!(hw.notice_at, Some(wednesday));
    // Less than a day before: no day before.
    assert_eq!(deadline("2026-10-21T09:00", now).notice_at, None);
    assert_eq!(
        anchor(Some("2026-10-22T11:00"), None)
            .resolve("UTC", now)
            .unwrap()
            .notice_at,
        None,
        "only a time that is the thing itself"
    );
    let (open_loop, _) = open(&conn, &said("HW3", Some(hw)), now).unwrap();
    assert_eq!(open_loop.notice_at, Some(wednesday));
    assert_eq!(next_due(&conn).unwrap(), Some(wednesday));

    let fired = fire_due(&conn, wednesday, true).unwrap();
    assert_eq!(fired.len(), 1);
    assert_eq!((fired[0].1, fired[0].2), (Fired::Eve, thursday));
    assert_eq!(
        (fired[0].0.notice_at, fired[0].0.due_at),
        (None, Some(thursday))
    );
    assert_eq!(next_due(&conn).unwrap(), Some(thursday));

    // The brain wakes for it: the loop waits, passed, for the wake to close it.
    let fired = fire_due(&conn, thursday, true).unwrap();
    assert_eq!((fired[0].1, fired[0].2), (Fired::Elapsed, thursday));
    let waiting = &fired[0].0;
    assert_eq!((waiting.status.as_str(), waiting.due_at), ("open", None));
    assert_eq!(waiting.anchor.as_ref().unwrap()["passed"], true);
    assert_eq!(next_due(&conn).unwrap(), None);

    // Closed and reopened before the day before: it comes again.
    let (other, _) = open(
        &conn,
        &said("Exam", Some(deadline("2026-10-30T09:00", now))),
        now,
    )
    .unwrap();
    close(&conn, &other.id, "moved", now + 1).unwrap();
    assert_eq!(get(&conn, &other.id).unwrap().notice_at, None);
    let (reopened, _) = reopen(&conn, &other.id, now + 2).unwrap();
    assert_eq!(reopened.notice_at, Some(date_utc(2026, 9, 29, 9, 0, 0, 0)));
}

#[test]
fn past_the_limit_the_oldest_without_a_time_become_facts() {
    let (app, _dir) = crate::memory::tests::app();
    let now = tuesday();
    {
        let conn = app.db.lock();
        // The oldest has a time: it stays.
        let at = anchor(Some("2026-11-01T09:00"), None)
            .resolve("UTC", now)
            .unwrap();
        open(&conn, &said("Renew the passport", Some(at)), now).unwrap();
        let sources = ["e1".to_owned()];
        open(
            &conn,
            &NewLoop {
                why: "the Moodle page said so",
                origin: "tool:web_search",
                source_entry_ids: &sources,
                ..said("Read chapter 7 of the networking book", None)
            },
            now + 1,
        )
        .unwrap();
        for n in 0..39 {
            open(
                &conn,
                &said(&format!("Thing number {n}"), None),
                now + 2 + n,
            )
            .unwrap();
        }
        assert_eq!(list_open(&conn).unwrap().len(), 41);
    }
    let demoted = demote_overflow(&app.db.lock(), now + 100).unwrap();
    assert_eq!(demoted.len(), 1);
    let gone = &demoted[0].open_loop;
    assert_eq!(gone.what, "Read chapter 7 of the networking book");
    assert_eq!(
        (gone.status.as_str(), gone.closed_reason.as_deref()),
        ("closed", Some(DEMOTED))
    );
    assert_eq!(list_open(&app.db.lock()).unwrap().len(), OPEN_LIMIT);
    assert!(
        demote_overflow(&app.db.lock(), now + 101)
            .unwrap()
            .is_empty()
    );

    // A fact now, searchable, with the loop's origin and id.
    let hits = crate::memory_records::search_facts(
        &app,
        &[ME.to_owned()],
        "networking chapter",
        8,
        crate::memory_records::Scopes::Person,
    )
    .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["origin"], "tool:web_search");
    assert_eq!(hits[0]["openLoopId"], json!(gone.id));
    assert_eq!(
        hits[0]["content"],
        "Read chapter 7 of the networking book (the Moodle page said so)"
    );
    let fact_id = demoted[0].fact_id.clone().unwrap();
    let fact = person::get(&app.db.lock(), ME, &fact_id).unwrap();
    assert_eq!(fact.source_entry_ids, json!([gone.id, "e1"]));

    // Not done after all: open again, and the fact is taken back (no
    // tombstone: the same text may be demoted again later).
    let (reopened, _) = reopen(&app.db.lock(), &gone.id, now + 200).unwrap();
    assert_eq!(
        (reopened.status.as_str(), reopened.last_touched_at),
        ("open", now + 200)
    );
    assert_eq!(
        person::get(&app.db.lock(), ME, &fact_id).unwrap_err().code,
        "not_found"
    );
    let demoted = demote_overflow(&app.db.lock(), now + 300).unwrap();
    assert_eq!(demoted[0].open_loop.what, "Thing number 0");
}
