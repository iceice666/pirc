use super::*;

fn zone(name: &str) -> Zone {
    Zone::parse(name).unwrap()
}

fn iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn parse_ms(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .timestamp_millis()
}

fn next(pattern: &str, tz: &str, from: &str) -> Option<String> {
    Cron::new(pattern, zone(tz))
        .unwrap()
        .next_run(parse_ms(from), zone(tz))
        .map(iso)
}

fn message(pattern: &str) -> String {
    Pattern::parse(pattern).unwrap_err().0
}

#[test]
fn zones() {
    assert!(Zone::parse("asia/taipei").is_some());
    assert!(Zone::parse("UTC").is_some());
    assert!(Zone::parse("US/Eastern").is_some());
    assert!(Zone::parse("Etc/GMT+5").is_some());
    assert!(Zone::parse("Mars/Base").is_none());
    assert_eq!(Zone::parse("+05:30"), Some(Zone::Fixed(19800)));
    assert_eq!(Zone::parse("-0500"), Some(Zone::Fixed(-18000)));
    assert_eq!(Zone::parse("+05"), Some(Zone::Fixed(18000)));
    assert!(Zone::parse("+24:00").is_none());
    assert!(Zone::parse("+5:00").is_none());
    assert!(Zone::parse("GMT+5").is_none());
}

#[test]
fn formats_times() {
    assert_eq!(
        format_time(
            parse_ms("2026-09-30T01:30:00Z"),
            zone("Asia/Taipei"),
            "Asia/Taipei"
        ),
        "2026-09-30 09:30 (Asia/Taipei)"
    );
    assert_eq!(
        format_time(0, zone("asia/taipei"), "asia/taipei"),
        "1970-01-01 08:00 (asia/taipei)"
    );
    assert_eq!(
        format_time(
            parse_ms("2026-11-01T05:30:59Z"),
            zone("America/New_York"),
            "X"
        ),
        "2026-11-01 01:30 (X)"
    );
}

/// From `schedules.integration.test.ts`.
#[test]
fn fire_times_across_dst() {
    assert_eq!(
        next("30 9 * * 1-5", "Asia/Taipei", "2026-09-29T02:00:00Z").as_deref(),
        Some("2026-09-30T01:30:00.000Z")
    );
    assert_eq!(
        next("0 9 * * *", "America/New_York", "2026-03-07T15:00:00Z").as_deref(),
        Some("2026-03-08T13:00:00.000Z")
    );
}

/// Recorded from croner 10.0.1 under Bun.
#[test]
fn dst_gaps_and_overlaps() {
    // 02:30 does not exist on 2026-03-08 in New York: the time after the gap.
    assert_eq!(
        next("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z").as_deref(),
        Some("2026-03-08T07:30:00.000Z")
    );
    // 01:30 happens twice on 2026-11-01: the first.
    assert_eq!(
        next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z").as_deref(),
        Some("2026-11-01T05:30:00.000Z")
    );
    // From the first 01:30, the next is the following day's.
    assert_eq!(
        next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z").as_deref(),
        Some("2026-11-02T06:30:00.000Z")
    );
    // Every 15 minutes through the overlap: croner's wall-clock walk.
    assert_eq!(
        next("*/15 * * * *", "America/New_York", "2026-11-01T06:30:00Z").as_deref(),
        Some("2026-11-01T05:45:00.000Z")
    );
    assert_eq!(
        next("0 * * * *", "Europe/Berlin", "2026-03-29T00:30:00Z").as_deref(),
        Some("2026-03-29T01:00:00.000Z")
    );
}

/// Recorded from croner 10.0.1 under Bun.
#[test]
fn day_of_month_and_week() {
    // Day of month OR day of week when both are restricted.
    assert_eq!(
        next("0 9 13 * 5", "UTC", "2026-10-01T00:00:00Z").as_deref(),
        Some("2026-10-02T09:00:00.000Z")
    );
    assert_eq!(
        next("0 9 13 * 5", "UTC", "2026-10-09T10:00:00Z").as_deref(),
        Some("2026-10-13T09:00:00.000Z")
    );
    // `+` asks for both.
    assert_eq!(
        next("0 9 13 * +5", "UTC", "2026-10-01T00:00:00Z").as_deref(),
        Some("2026-11-13T09:00:00.000Z")
    );
    // `?` is a wildcard, but not a star for the OR rule.
    assert_eq!(
        next("0 9 ? * 1", "UTC", "2026-10-01T00:00:00Z").as_deref(),
        Some("2026-10-01T09:00:00.000Z")
    );
    // Last day, last weekday, nearest weekday, nth and last weekday.
    assert_eq!(
        next("0 0 L * *", "UTC", "2026-02-01T00:00:00Z").as_deref(),
        Some("2026-02-28T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 LW * *", "UTC", "2026-05-01T00:00:00Z").as_deref(),
        Some("2026-05-29T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 1W * *", "UTC", "2026-08-01T00:00:01Z").as_deref(),
        Some("2026-08-03T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 15W * *", "UTC", "2026-08-01T00:00:00Z").as_deref(),
        Some("2026-08-14T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 * * FRI#2", "UTC", "2026-10-01T00:00:00Z").as_deref(),
        Some("2026-10-09T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 * * 5L", "UTC", "2026-10-01T00:00:00Z").as_deref(),
        Some("2026-10-30T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 31 * *", "UTC", "2026-04-01T00:00:00Z").as_deref(),
        Some("2026-05-31T00:00:00.000Z")
    );
    assert_eq!(
        next("0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z").as_deref(),
        Some("2028-02-29T00:00:00.000Z")
    );
    assert_eq!(next("0 0 30 2 *", "UTC", "2026-03-01T00:00:00Z"), None);
    assert_eq!(
        next("0 9 * * mon-fri", "UTC", "2026-10-02T10:00:00Z").as_deref(),
        Some("2026-10-05T09:00:00.000Z")
    );
    assert_eq!(
        next("0 9 * jan,jul sun", "UTC", "2026-10-02T10:00:00Z").as_deref(),
        Some("2027-01-03T09:00:00.000Z")
    );
    assert_eq!(
        next("@hourly", "UTC", "2026-10-02T10:00:00Z").as_deref(),
        Some("2026-10-02T11:00:00.000Z")
    );
    assert_eq!(
        next("30 0 9 * * *", "UTC", "2026-10-02T10:00:00Z").as_deref(),
        Some("2026-10-03T09:00:30.000Z")
    );
    assert_eq!(
        next("0 0 9 * * * 2030", "UTC", "2026-10-02T10:00:00Z").as_deref(),
        Some("2030-01-01T09:00:00.000Z")
    );
    assert_eq!(
        next("0 0 * * 1-5", "America/Sao_Paulo", "2026-10-02T10:00:00Z").as_deref(),
        Some("2026-10-05T03:00:00.000Z")
    );
    assert_eq!(
        next(
            "0 12 15W,L * 2#3",
            "Australia/Lord_Howe",
            "2026-10-02T10:00:00Z"
        )
        .as_deref(),
        Some("2026-10-15T01:00:00.000Z")
    );
    assert_eq!(
        next("0 2 * * 0", "Europe/London", "2026-03-28T10:00:00Z").as_deref(),
        Some("2026-03-29T01:00:00.000Z")
    );
    assert_eq!(
        next("30 1 * * *", "Europe/London", "2026-10-25T00:00:00Z").as_deref(),
        Some("2026-10-25T00:30:00.000Z")
    );
    assert_eq!(
        next("0 0 1 * *", "+05:30", "2026-10-02T10:00:00Z").as_deref(),
        Some("2026-10-31T18:30:00.000Z")
    );
}

/// Recorded from croner 10.0.1 under Bun.
#[test]
fn pattern_errors() {
    assert_eq!(
        message("61 9 * * *"),
        "CronPattern: Invalid value for minute: 61"
    );
    assert_eq!(
        message("0 9 * *"),
        "CronPattern: invalid configuration format ('0 9 * *'), exactly five, six, or seven space separated parts are required."
    );
    assert_eq!(
        message("*/0 * * * *"),
        "CronPattern: Syntax error, illegal stepping: 0"
    );
    assert_eq!(
        message("5-1 * * * *"),
        "CronPattern: From value is larger than to value: '5-1'"
    );
    assert_eq!(
        message("0/5 * * * *"),
        "CronPattern: Syntax error, stepping with numeric prefix ('0/5') is not allowed. Use wildcard (*/step) or range (min-max/step) instead."
    );
    assert_eq!(
        message("0 9 * * MON#6"),
        "CronPattern: nth weekday out of range, should be 1-5 or L. Value: 6, Type: string"
    );
    assert_eq!(
        message("0 9 * * x"),
        "CronPattern: configuration entry 5 (x) contains illegal characters."
    );
    assert_eq!(
        message("0 9 0 * *"),
        "CronPattern: Invalid value for day: -1"
    );
    assert_eq!(
        message("0 24 * * *"),
        "CronPattern: Invalid value for hour: 24"
    );
    assert_eq!(
        message("0 9 * 13 *"),
        "CronPattern: Invalid value for month: 12"
    );
    assert_eq!(
        message("0 9 * * 8"),
        "CronPattern: Invalid value for dayOfWeek: 8"
    );
    assert_eq!(
        message("0 9 1,,2 * *"),
        "CronPattern: configuration entry day () is empty, check for trailing spaces."
    );
    assert_eq!(
        message("0 9W * * *"),
        "CronPattern: configuration entry 2 (9W) contains illegal characters."
    );
    assert_eq!(
        message("0 9 * * #0"),
        "CronPattern: dayOfWeek is not a number: '#0'"
    );
    assert!(Pattern::parse("0 9 * * 1#").is_ok());
    assert!(Pattern::parse("0 0 * * 7").is_ok());
    assert_eq!(
        message("0 9 1-5/2W * *"),
        "CronPattern: Syntax error, W is not allowed in ranges with stepping."
    );
    assert_eq!(
        message("0 9 L-2 * *"),
        "CronPattern: Syntax error, illegal lower range (NaN)"
    );
    assert_eq!(
        message("0 9 * * 1-2-3"),
        "CronPattern: Syntax error, illegal range: '1-2-3'"
    );
    assert_eq!(
        message("0 9 * * 1#2L"),
        "CronPattern: nth weekday out of range, should be 1-5 or L. Value: 2L, Type: string"
    );
    assert_eq!(
        message("*/70 * * * *"),
        "CronPattern: Syntax error, steps cannot be greater than maximum value of part (60)"
    );
    assert_eq!(
        message("99999999999999999999999 * * * *"),
        "CronPattern: Invalid value for minute: 1e+23"
    );
    assert_eq!(
        message("@reboot"),
        "CronPattern: @reboot is not supported in this environment. This is an event-based trigger that requires system startup detection."
    );
}

/// Recorded from `Date.parse` + croner under Bun with `TZ=UTC`.
#[test]
fn iso_times() {
    let at = |text: &str, tz: &str| {
        Cron::new(text, zone(tz))
            .ok()
            .and_then(|cron| cron.next_run(0, zone(tz)))
            .map(iso)
    };
    assert_eq!(
        at("2026-10-01T09:00", "Asia/Taipei").as_deref(),
        Some("2026-10-01T01:00:00.000Z")
    );
    assert_eq!(
        at("2026-10-01 09:00:30.5", "UTC").as_deref(),
        Some("2026-10-01T09:00:30.000Z")
    );
    assert_eq!(
        at("2026-10-01T09:00+08:00", "UTC").as_deref(),
        Some("2026-10-01T01:00:00.000Z")
    );
    assert_eq!(
        at("2026-10-01T09:00Z", "Asia/Taipei").as_deref(),
        Some("2026-10-01T09:00:00.000Z")
    );
    assert_eq!(
        at("2026-02-30T09:00", "UTC").as_deref(),
        Some("2026-03-02T09:00:00.000Z")
    );
    assert_eq!(
        at("2026-10-01T24:00", "UTC").as_deref(),
        Some("2026-10-02T00:00:00.000Z")
    );
    // In a gap: after it; an offset in an overlap: the first one.
    assert_eq!(
        at("2026-03-08T02:30", "America/New_York").as_deref(),
        Some("2026-03-08T07:30:00.000Z")
    );
    assert_eq!(
        at("2026-11-01T01:30-05:00", "America/New_York").as_deref(),
        Some("2026-11-01T05:30:00.000Z")
    );
    assert_eq!(at("1969-12-31T23:59", "UTC"), None);
    assert_eq!(at("2026-10-01T9:00", "UTC"), None);
    assert_eq!(at("2026-13-01T09:00", "UTC"), None);
    assert_eq!(at("2026-10-01T09:00+08", "UTC"), None);
    // No `:`: a pattern, from 1970.
    assert_eq!(
        at("0 9 * * *", "UTC").as_deref(),
        Some("1970-01-01T09:00:00.000Z")
    );
    assert_eq!(
        Cron::new("tomorrow", zone("UTC")).unwrap_err().0,
        "CronPattern: invalid configuration format ('tomorrow'), exactly five, six, or seven space separated parts are required."
    );
    assert_eq!(
        Cron::new("2026-10-01T9:00", zone("UTC")).unwrap_err().0,
        "Invalid ISO8601 passed to timezone parser."
    );
    assert_eq!(
        at("2026-10T09:00", "UTC").as_deref(),
        Some("2026-10-01T09:00:00.000Z")
    );
    // A `-` from the tenth character on reads it in UTC (croner's check).
    assert_eq!(
        at("+002026-10-01T09:00", "Asia/Taipei").as_deref(),
        Some("2026-10-01T09:00:00.000Z")
    );
    // Date.UTC's two-digit years.
    assert_eq!(
        at("0080-01-01T00:00", "UTC").as_deref(),
        Some("1980-01-01T00:00:00.000Z")
    );
}
