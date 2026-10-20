//! How many wakes a day (decision #3: 24, `PIRC_WAKES_PER_DAY`): counted
//! from the `wakes` table, per calendar day in the household's zone
//! (`PIRC_TIMEZONE`), so the count starts again at local midnight. A wake
//! counts once it starts; one a user turn took over does not (the wake put
//! back in its place counts when it starts).

use rusqlite::Connection;

use crate::error::ApiResult;
use crate::time::cron::{Wall, Zone, from_tz, to_tz};

/// The zone of a `PIRC_TIMEZONE` name; UTC for one that is not.
pub fn zone(name: &str) -> Zone {
    Zone::parse(name).unwrap_or(Zone::Fixed(0))
}

/// Local midnight that began the day of `now`.
pub fn day_start(now: i64, zone: Zone) -> i64 {
    let wall = to_tz(now, zone);
    from_tz(
        Wall {
            h: 0,
            i: 0,
            s: 0,
            ..wall
        },
        zone,
    )
}

/// The wakes started today.
pub fn used(conn: &Connection, now: i64, zone: Zone) -> ApiResult<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM wakes WHERE started_at IS NOT NULL AND started_at>=? AND (outcome IS NULL OR outcome<>'preempted')",
        [day_start(now, zone)],
        |row| row.get(0),
    )?)
}

/// Whether one more may start now.
pub fn allows(conn: &Connection, now: i64, zone: Zone, per_day: u32) -> ApiResult<bool> {
    Ok(used(conn, now, zone)? < i64::from(per_day))
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;
    use crate::db::Db;
    use crate::time::cron::date_utc;

    #[test]
    fn the_day_starts_at_local_midnight() {
        let taipei = zone("Asia/Taipei");
        // 2026-10-20 01:30 in Taipei is 2026-10-19 17:30 UTC.
        let now = date_utc(2026, 9, 19, 17, 30, 0, 0);
        assert_eq!(day_start(now, taipei), date_utc(2026, 9, 19, 16, 0, 0, 0));
        assert_eq!(
            day_start(now, zone("UTC")),
            date_utc(2026, 9, 19, 0, 0, 0, 0)
        );
        assert_eq!(zone("Nowhere/Else"), Zone::Fixed(0));
    }

    #[test]
    fn twenty_four_a_day() {
        let db = Db::memory();
        let conn = db.lock();
        let utc = zone("UTC");
        let now = date_utc(2026, 9, 20, 12, 0, 0, 0);
        let start = |n: usize, at: i64, outcome: Option<&str>| {
            conn.execute(
                "INSERT INTO wakes (id,kind,trigger_json,room_id,scheduled_at,started_at,outcome,created_at) VALUES (?,'self','{}','general',?,?,?,?)",
                params![format!("w{n}"), at, at, outcome, at],
            )
            .unwrap();
        };
        // Yesterday's do not count, nor one a user turn took over.
        start(0, now - 13 * 3_600_000, Some("spoke"));
        start(1, now - 60_000, Some("preempted"));
        for n in 2..25 {
            start(n, now - 1_000, Some("silent"));
        }
        assert_eq!(used(&conn, now, utc).unwrap(), 23);
        assert!(allows(&conn, now, utc, 24).unwrap(), "the 24th may start");
        start(25, now, None);
        assert!(!allows(&conn, now, utc, 24).unwrap(), "the 25th may not");
        let tomorrow = date_utc(2026, 9, 21, 0, 0, 1, 0);
        assert!(allows(&conn, tomorrow, utc, 24).unwrap(), "a new day");
        assert!(!allows(&conn, tomorrow, utc, 0).unwrap(), "none at all");
    }
}
