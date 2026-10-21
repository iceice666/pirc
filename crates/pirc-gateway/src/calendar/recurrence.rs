//! Calendar recurrence follows local dates, never a 24-hour UTC stride.
//! Missing month days are skipped; DST gaps move forward, overlaps use the
//! first instant, matching the existing schedule time-zone implementation.
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

use super::{Event, Spec};
use crate::error::{ApiError, ApiResult};
use crate::schedules::cron::{self, Wall, Zone};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub frequency: String,
    #[serde(default = "one")]
    pub interval: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekdays: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}
fn one() -> u32 {
    1
}

#[derive(Clone, Debug)]
pub struct Occurrence {
    pub original_start: String,
    pub start_at: i64,
    pub end_at: i64,
    pub start_date: String,
    pub end_date: String,
}

pub fn date(value: &str) -> ApiResult<NaiveDate> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("Use a valid calendar date (YYYY-MM-DD)"))?;
    if !(1900..=2200).contains(&date.year()) || date.format("%Y-%m-%d").to_string() != value {
        return Err(invalid("Calendar dates must be between 1900 and 2200"));
    }
    Ok(date)
}

pub fn local(value: &str, all_day: bool) -> ApiResult<NaiveDateTime> {
    if all_day {
        return Ok(date(value)?.and_hms_opt(0, 0, 0).unwrap());
    }
    let parsed = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M")
        .map_err(|_| invalid("Use a local date and time (YYYY-MM-DDTHH:mm)"))?;
    date(&parsed.date().format("%Y-%m-%d").to_string())?;
    if parsed.format("%Y-%m-%dT%H:%M").to_string() != value {
        return Err(invalid("Invalid local date and time"));
    }
    Ok(parsed)
}

pub fn instant(local: NaiveDateTime, zone: Zone) -> i64 {
    use chrono::Timelike;
    cron::from_tz(
        Wall {
            y: i64::from(local.year()),
            m: i64::from(local.month()),
            d: i64::from(local.day()),
            h: i64::from(local.hour()),
            i: i64::from(local.minute()),
            s: 0,
        },
        zone,
    )
}

pub fn wall(at: i64, zone: Zone) -> ApiResult<NaiveDateTime> {
    let value = cron::to_tz(at, zone);
    NaiveDate::from_ymd_opt(value.y as i32, value.m as u32, value.d as u32)
        .and_then(|d| d.and_hms_opt(value.h as u32, value.i as u32, value.s as u32))
        .ok_or_else(|| invalid("Calendar range is outside supported dates"))
}

pub fn key(local: NaiveDateTime, all_day: bool) -> String {
    local
        .format(if all_day {
            "%Y-%m-%d"
        } else {
            "%Y-%m-%dT%H:%M"
        })
        .to_string()
}

pub fn invalid(message: &str) -> ApiError {
    ApiError::new(400, "invalid_calendar", message)
}

pub fn validate(spec: &Spec) -> ApiResult<()> {
    if spec.title.trim().is_empty()
        || spec.title.chars().count() > 200
        || spec.description.chars().count() > 20_000
        || spec.location.chars().count() > 1000
    {
        return Err(invalid(
            "Provide a title up to 200 characters, description up to 20000 and location up to 1000",
        ));
    }
    let zone = Zone::parse(&spec.timezone).ok_or_else(|| invalid("Unknown time zone"))?;
    let start = local(&spec.start, spec.all_day)?;
    let end = local(&spec.end, spec.all_day)?;
    if end <= start
        || end - start > Duration::days(366)
        || instant(end, zone) <= instant(start, zone)
    {
        return Err(invalid(
            "End must follow start; maximum event duration is 366 days",
        ));
    }
    if spec.reminder_minutes.len() > 5
        || spec
            .reminder_minutes
            .iter()
            .any(|m| !(0..=43_200).contains(m))
    {
        return Err(invalid(
            "Use at most five reminders, up to 30 days before start",
        ));
    }
    if let Some(rule) = &spec.recurrence {
        if !["daily", "weekly", "monthly", "yearly"].contains(&rule.frequency.as_str())
            || !(1..=1000).contains(&rule.interval)
            || rule.weekdays.len() > 7
            || rule.weekdays.iter().any(|d| *d > 6)
            || rule.count.is_some_and(|n| !(1..=200_000).contains(&n))
            || (rule.frequency != "weekly" && !rule.weekdays.is_empty())
        {
            return Err(invalid("Invalid recurrence rule"));
        }
        if let Some(until) = &rule.until
            && date(until)? < start.date()
        {
            return Err(invalid("Repeat end must not precede start"));
        }
    }
    Ok(())
}

/// Zero-based position in the original recurrence (exceptions don't consume or
/// add positions). None for a date the rule doesn't include.
pub fn ordinal(seed: NaiveDate, day: NaiveDate, rule: &Rule) -> Option<u32> {
    if day < seed {
        return None;
    }
    let interval = i64::from(rule.interval);
    match rule.frequency.as_str() {
        "daily" => {
            let days = (day - seed).num_days();
            (days % interval == 0).then_some((days / interval) as u32)
        }
        "weekly" => {
            let seed_w = i64::from(seed.weekday().num_days_from_sunday());
            let wd = day.weekday().num_days_from_sunday();
            let weeks = ((day - seed).num_days() + seed_w) / 7;
            let mut days = if rule.weekdays.is_empty() {
                vec![seed_w as u32]
            } else {
                rule.weekdays.clone()
            };
            days.sort_unstable();
            days.dedup();
            if weeks % interval != 0 || !days.contains(&wd) {
                return None;
            }
            let before_seed = days.iter().filter(|d| i64::from(**d) < seed_w).count() as i64;
            let through_day = days.iter().filter(|d| **d <= wd).count() as i64;
            Some((weeks / interval * days.len() as i64 + through_day - before_seed - 1) as u32)
        }
        "monthly" => {
            let months = (day.year() - seed.year()) * 12 + day.month() as i32 - seed.month() as i32;
            if i64::from(months) % interval != 0 || day.day() != seed.day() {
                return None;
            }
            let mut count = 0;
            for m in (0..=months).step_by(rule.interval as usize) {
                let serial = seed.year() * 12 + seed.month0() as i32 + m;
                if NaiveDate::from_ymd_opt(serial / 12, (serial % 12 + 1) as u32, seed.day())
                    .is_some()
                {
                    count += 1;
                }
            }
            Some(count - 1)
        }
        "yearly" => {
            let years = day.year() - seed.year();
            if i64::from(years) % interval != 0
                || day.month() != seed.month()
                || day.day() != seed.day()
            {
                return None;
            }
            let count = (seed.year()..=day.year())
                .step_by(rule.interval as usize)
                .filter(|y| NaiveDate::from_ymd_opt(*y, seed.month(), seed.day()).is_some())
                .count();
            Some(count as u32 - 1)
        }
        _ => None,
    }
}

pub fn includes(spec: &Spec, candidate: NaiveDateTime) -> ApiResult<bool> {
    let seed = local(&spec.start, spec.all_day)?;
    if candidate.time() != seed.time() {
        return Ok(false);
    }
    let Some(rule) = &spec.recurrence else {
        return Ok(candidate == seed);
    };
    if let Some(until) = &rule.until
        && candidate.date() > date(until)?
    {
        return Ok(false);
    }
    Ok(ordinal(seed.date(), candidate.date(), rule)
        .is_some_and(|n| rule.count.is_none_or(|count| n < count)))
}

pub fn make(spec: &Spec, start: NaiveDateTime, original_start: String) -> ApiResult<Occurrence> {
    let zone = Zone::parse(&spec.timezone).ok_or_else(|| invalid("Unknown time zone"))?;
    let duration = local(&spec.end, spec.all_day)? - local(&spec.start, spec.all_day)?;
    let end = start + duration;
    let start_at = instant(start, zone);
    let mut end_at = instant(end, zone);
    // A gap may shift a recurring start past its nominal end. Keep a
    // positive intended duration rather than producing a backwards event.
    if end_at <= start_at {
        end_at = start_at + duration.num_milliseconds();
    }
    Ok(Occurrence {
        original_start,
        start_at,
        end_at,
        start_date: start.date().to_string(),
        end_date: end.date().to_string(),
    })
}

pub fn occurrences(event: &Event, from: i64, to: i64) -> ApiResult<Vec<Occurrence>> {
    let spec = &event.spec;
    let zone = Zone::parse(&spec.timezone).ok_or_else(|| invalid("Unknown time zone"))?;
    let seed = local(&spec.start, spec.all_day)?;
    let duration = local(&spec.end, spec.all_day)? - seed;
    let first = (wall(from, zone)? - duration).date().max(seed.date());
    let last = wall(to, zone)?.date();
    let mut result = Vec::new();
    let mut day = first;
    while day <= last {
        let candidate = day.and_time(seed.time());
        let original = key(candidate, spec.all_day);
        if event
            .end_before
            .as_ref()
            .is_some_and(|end| original >= *end)
        {
            break;
        }
        if includes(spec, candidate)? {
            let item = make(spec, candidate, original)?;
            if item.start_at < to && item.end_at > from {
                result.push(item);
            }
        }
        let Some(next) = day.succ_opt() else {
            break;
        };
        day = next;
    }
    Ok(result)
}
