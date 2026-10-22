//! Local times as JavaScript's `Date` gives them, for memory records:
//! `localStamp` and the `Date.parse` of a stamp (the same rules as the
//! gateway's memory, `pirc-gateway` `memory/text.rs`).

use std::sync::LazyLock;

use tz::TimeZone;
use tz::timezone::TimeZoneSettings;

/// The process's time zone: `$TZ` (a zone name, `:path` or POSIX rule),
/// else `/etc/localtime`, else UTC. Zone files come from the system
/// (`$TZDIR` first).
static LOCAL: LazyLock<Option<TimeZone>> = LazyLock::new(|| {
    let tzdir = std::env::var("TZDIR").ok();
    let mut directories: Vec<&str> = tzdir.iter().map(String::as_str).collect();
    directories.extend(TimeZoneSettings::DEFAULT_DIRECTORIES);
    let settings = TimeZoneSettings::new(&directories, TimeZoneSettings::DEFAULT_READ_FILE_FN);
    match std::env::var("TZ") {
        Ok(tz) => settings.parse_posix_tz(&tz).ok(),
        Err(_) => settings.parse_local().ok(),
    }
});

/// Seconds east of UTC of local time at `unix` seconds.
fn offset_at(unix: i64) -> i64 {
    LOCAL
        .as_ref()
        .and_then(|zone| zone.find_local_time_type(unix).ok())
        .map_or(0, |kind| i64::from(kind.ut_offset()))
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
#[cfg(test)]
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_era_days - 719_468
}

/// The date of a day since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let of_era = days - era * 146_097;
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 {
        shifted + 3
    } else {
        shifted - 9
    };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// Largest time a JavaScript `Date` holds, in ms either side of the epoch.
const DATE_RANGE_MS: f64 = 8_640_000_000_000_000.0;

/// `localStamp(time)`: "YYYY-MM-DD HH:MM" in local time.
pub fn local_stamp(ms: f64) -> String {
    if !ms.is_finite() || ms.abs() > DATE_RANGE_MS {
        return "????-??-?? ??:??".to_owned();
    }
    let unix = (ms.trunc() as i64).div_euclid(1000);
    let local = unix + offset_at(unix);
    let (year, month, day) = civil_from_days(local.div_euclid(86_400));
    let seconds = local.rem_euclid(86_400);
    format!(
        "{year}-{month:02}-{day:02} {:02}:{:02}",
        seconds / 3600,
        seconds % 3600 / 60
    )
}

/// `localStamp()`: now.
pub fn local_stamp_now() -> String {
    local_stamp(crate::now_ms() as f64)
}

/// `Date.parse("YYYY-MM-DDTHH:MM")` (a stamp with `T`): local time in ms,
/// or `None` (NaN). Other forms Bun's parser accepts are not read.
#[cfg(test)]
pub fn parse_local_minute(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let shape = bytes.len() == 16
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 => *b == b':',
            _ => b.is_ascii_digit(),
        });
    if !shape {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute) = (number(11..13)?, number(14..16)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month)
        || day < 1
        || day > month_days[(month - 1) as usize]
        || hour > 24
        || minute > 59
        || (hour == 24 && minute != 0)
    {
        return None;
    }
    let naive = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60;
    Some((naive - offset_at(naive - offset_at(naive))) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_and_parses_local_minutes() {
        assert_eq!(local_stamp(f64::NAN), "????-??-?? ??:??");
        assert_eq!(local_stamp(9e15), "????-??-?? ??:??");
        let ms = parse_local_minute("2026-01-01T10:00").unwrap();
        assert_eq!(local_stamp(ms as f64), "2026-01-01 10:00");
        assert!(
            parse_local_minute("2026-01-01T10:01").unwrap()
                > parse_local_minute("2026-01-01T10:00").unwrap()
        );
        assert_eq!(parse_local_minute("2026-02-30T10:00"), None);
        assert_eq!(parse_local_minute("2026-01-01 10:00"), None);
        assert_eq!(parse_local_minute("soon"), None);
    }
}
