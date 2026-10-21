//! iCalendar (RFC 5545) as calendar sources need it: the `VEVENT`s of a
//! feed and their occurrences in a window. Recurrence covers what school
//! and personal calendars use (`FREQ` daily to yearly, `INTERVAL`,
//! `COUNT`, `UNTIL`, `BYDAY` with ordinals in months, `BYMONTHDAY`,
//! `BYMONTH`, `EXDATE`, overridden instances by `RECURRENCE-ID`); a rule
//! with other parts gives its first instance only and says so. Times step
//! in their own zone's wall clock (`TZID` as an IANA name; others, and
//! floating times, in the household's zone).

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Weekday};
use chrono_tz::Tz;

/// Occurrences listed per window, at most.
pub const MAX_OCCURRENCES: usize = 1000;
/// Periods a rule is stepped through, at most.
const MAX_STEPS: usize = 20_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub uid: String,
    pub summary: String,
    pub description: String,
    pub location: String,
    pub url: Option<String>,
    pub organizer: Option<String>,
    pub status: Option<String>,
    pub start: When,
    /// Milliseconds from start to end.
    pub length: i64,
    pub rule: Option<Rule>,
    /// The `RRULE` as written.
    pub rule_text: Option<String>,
    pub exdates: Vec<i64>,
    pub recurrence_id: Option<i64>,
}

impl Event {
    /// Its key among a feed's events: the UID, and the instance it
    /// overrides.
    pub fn key(&self) -> String {
        match self.recurrence_id {
            Some(at) => format!("{}#{at}", self.uid),
            None => self.uid.clone(),
        }
    }

    pub fn cancelled(&self) -> bool {
        self.status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED"))
    }

    /// What tells a change: all that is shown of it.
    pub fn fingerprint(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{:?}|{:?}",
            self.summary,
            self.start.ms,
            self.length,
            self.location,
            self.rule_text.as_deref().unwrap_or_default(),
            self.status.as_deref().unwrap_or_default(),
            self.exdates,
            self.url,
        )
    }
}

/// A start: the instant, and the wall-clock time in its zone that rules
/// step from.
#[derive(Clone, Debug, PartialEq)]
pub struct When {
    pub ms: i64,
    pub all_day: bool,
    pub local: NaiveDateTime,
    pub zone: Tz,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: u32,
    pub count: Option<u32>,
    pub until: Option<i64>,
    /// `(ordinal, weekday)`: `2TU` is `(Some(2), Tue)`.
    pub by_day: Vec<(Option<i32>, Weekday)>,
    pub by_month_day: Vec<i32>,
    pub by_month: Vec<u32>,
    pub week_start: Weekday,
    /// It has parts this reader does not follow: only its first instance.
    pub partial: bool,
}

/// One instance of an event.
#[derive(Clone, Debug, PartialEq)]
pub struct Occurrence {
    /// The event's index in the feed.
    pub event: usize,
    pub start: i64,
    pub end: i64,
}

/// A content line: its name, parameters and value.
struct Line {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Line {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Unfolded content lines.
fn lines(text: &str) -> Vec<Line> {
    let mut unfolded: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = unfolded.last_mut()
        {
            last.push_str(rest);
        } else if !raw.is_empty() {
            unfolded.push(raw.to_owned());
        }
    }
    unfolded
        .iter()
        .filter_map(|line| split_line(line))
        .collect()
}

fn split_line(line: &str) -> Option<Line> {
    // The value starts at the first ':' outside a quoted parameter value.
    let mut quoted = false;
    let colon = line.char_indices().find_map(|(at, c)| match c {
        '"' => {
            quoted = !quoted;
            None
        }
        ':' if !quoted => Some(at),
        _ => None,
    })?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| {
            (
                key.trim().to_ascii_uppercase(),
                value.trim_matches('"').to_owned(),
            )
        })
        .collect();
    Some(Line {
        name,
        params,
        value: value.to_owned(),
    })
}

/// A TEXT value: `\n`, `\,`, `\;`, `\\` unescaped.
fn text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// A zone by its `TZID`: an IANA name (some feeds prefix a path, like
/// `/mozilla.org/.../Asia/Taipei`), else the default.
fn zone(tzid: Option<&str>, default: Tz) -> Tz {
    let Some(tzid) = tzid else {
        return default;
    };
    if let Ok(zone) = tzid.parse::<Tz>() {
        return zone;
    }
    let parts: Vec<&str> = tzid.trim_matches('/').split('/').collect();
    for start in 0..parts.len() {
        if let Ok(zone) = parts[start..].join("/").parse::<Tz>() {
            return zone;
        }
    }
    default
}

/// The instant of a wall-clock time in a zone (a time in a DST gap moves
/// on by the gap).
pub fn instant(zone: Tz, local: NaiveDateTime) -> i64 {
    match zone.from_local_datetime(&local) {
        chrono::LocalResult::Single(at) | chrono::LocalResult::Ambiguous(at, _) => {
            at.timestamp_millis()
        }
        chrono::LocalResult::None => zone
            .from_local_datetime(&(local + Duration::hours(1)))
            .earliest()
            .map_or_else(
                || local.and_utc().timestamp_millis(),
                |at| at.timestamp_millis(),
            ),
    }
}

/// A DATE or DATE-TIME value.
fn when(value: &str, tzid: Option<&str>, is_date: bool, default: Tz) -> Option<When> {
    let value = value.trim();
    if is_date || value.len() == 8 {
        let date = NaiveDate::parse_from_str(value.get(..8)?, "%Y%m%d").ok()?;
        let local = date.and_time(NaiveTime::MIN);
        let zone = zone(tzid, default);
        return Some(When {
            ms: instant(zone, local),
            all_day: true,
            local,
            zone,
        });
    }
    let utc = value.ends_with('Z') || value.ends_with('z');
    let local =
        NaiveDateTime::parse_from_str(value.trim_end_matches(['Z', 'z']), "%Y%m%dT%H%M%S").ok()?;
    if utc {
        let ms = local.and_utc().timestamp_millis();
        // Rules step in the default zone's wall clock from a UTC start.
        let zone = default;
        let local = zone.timestamp_millis_opt(ms).single()?.naive_local();
        return Some(When {
            ms,
            all_day: false,
            local,
            zone,
        });
    }
    let zone = zone(tzid, default);
    Some(When {
        ms: instant(zone, local),
        all_day: false,
        local,
        zone,
    })
}

/// `P1W`, `PT1H30M`, `P1DT2H`, `-PT15M`: milliseconds.
fn duration(value: &str) -> Option<i64> {
    let (sign, rest) = match value.trim().strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, value.trim().trim_start_matches('+')),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total = 0i64;
    let mut number = String::new();
    let mut in_time = false;
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => number.push(c),
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                total += n * match (unit, in_time) {
                    ('W', _) => 7 * 86_400_000,
                    ('D', _) => 86_400_000,
                    ('H', true) => 3_600_000,
                    ('M', true) => 60_000,
                    ('S', true) => 1000,
                    _ => return None,
                };
            }
        }
    }
    Some(sign * total)
}

fn weekday(text: &str) -> Option<Weekday> {
    Some(match text {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

fn rule(value: &str, default: Tz) -> Option<Rule> {
    let mut rule = Rule {
        freq: Freq::Daily,
        interval: 1,
        count: None,
        until: None,
        by_day: Vec::new(),
        by_month_day: Vec::new(),
        by_month: Vec::new(),
        week_start: Weekday::Mon,
        partial: false,
    };
    let mut freq = None;
    for part in value.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim().to_ascii_uppercase();
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match value.as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => {
                        rule.partial = true;
                        Freq::Daily
                    }
                });
            }
            "INTERVAL" => rule.interval = value.parse().ok().filter(|n| *n >= 1)?,
            "COUNT" => rule.count = value.parse().ok(),
            "UNTIL" => {
                rule.until = when(&value, None, false, default).map(|until| {
                    // A date UNTIL includes its whole day.
                    if until.all_day {
                        until.ms + 86_400_000 - 1
                    } else {
                        until.ms
                    }
                })
            }
            "BYDAY" => {
                for day in value.split(',') {
                    let day = day.trim();
                    let (ordinal, name) = day.split_at(day.len().saturating_sub(2));
                    let Some(weekday) = weekday(name) else {
                        rule.partial = true;
                        continue;
                    };
                    let ordinal = if ordinal.is_empty() {
                        None
                    } else {
                        Some(ordinal.trim_start_matches('+').parse::<i32>().ok()?)
                    };
                    rule.by_day.push((ordinal, weekday));
                }
            }
            "BYMONTHDAY" => {
                rule.by_month_day = value
                    .split(',')
                    .filter_map(|day| day.trim().parse().ok())
                    .collect();
            }
            "BYMONTH" => {
                rule.by_month = value
                    .split(',')
                    .filter_map(|month| month.trim().parse().ok())
                    .collect();
            }
            "WKST" => rule.week_start = weekday(&value).unwrap_or(Weekday::Mon),
            _ => rule.partial = true,
        }
    }
    rule.freq = freq?;
    Some(rule)
}

/// The events of a feed (or of several `VCALENDAR`s one after another, as
/// a CalDAV report gives them).
pub fn parse(feed: &str, default: Tz) -> Vec<Event> {
    let mut events = Vec::new();
    let mut current: Option<Vec<Line>> = None;
    let mut depth = 0usize;
    for line in lines(feed) {
        match (
            line.name.as_str(),
            line.value.trim().to_ascii_uppercase().as_str(),
        ) {
            ("BEGIN", "VEVENT") if current.is_none() => {
                current = Some(Vec::new());
                depth = 0;
            }
            ("BEGIN", _) if current.is_some() => depth += 1,
            ("END", "VEVENT") if current.is_some() && depth == 0 => {
                if let Some(event) = current.take().and_then(|lines| event(&lines, default)) {
                    events.push(event);
                }
            }
            ("END", _) if current.is_some() => depth = depth.saturating_sub(1),
            _ => {
                if depth == 0
                    && let Some(lines) = current.as_mut()
                {
                    lines.push(line);
                }
            }
        }
    }
    events
}

fn event(lines: &[Line], default: Tz) -> Option<Event> {
    let get = |name: &str| lines.iter().find(|line| line.name == name);
    let is_date = |line: &Line| {
        line.param("VALUE")
            .is_some_and(|value| value.eq_ignore_ascii_case("DATE"))
    };
    let start_line = get("DTSTART")?;
    let start = when(
        &start_line.value,
        start_line.param("TZID"),
        is_date(start_line),
        default,
    )?;
    let end =
        get("DTEND").and_then(|line| when(&line.value, line.param("TZID"), is_date(line), default));
    let length = match (end, get("DURATION").and_then(|line| duration(&line.value))) {
        (Some(end), _) => (end.ms - start.ms).max(0),
        (None, Some(length)) => length.max(0),
        (None, None) if start.all_day => 86_400_000,
        (None, None) => 0,
    };
    let rule_text = get("RRULE").map(|line| line.value.trim().to_owned());
    let rule = rule_text.as_deref().and_then(|text| rule(text, default));
    let mut exdates = Vec::new();
    for line in lines.iter().filter(|line| line.name == "EXDATE") {
        for value in line.value.split(',') {
            if let Some(at) = when(value, line.param("TZID"), is_date(line), default) {
                exdates.push(at.ms);
            }
        }
    }
    let recurrence_id = get("RECURRENCE-ID")
        .and_then(|line| when(&line.value, line.param("TZID"), is_date(line), default))
        .map(|at| at.ms);
    let organizer = get("ORGANIZER").map(|line| {
        let address = line
            .value
            .trim_start_matches("mailto:")
            .trim_start_matches("MAILTO:");
        match line.param("CN") {
            Some(name) => format!("{name} <{address}>"),
            None => address.to_owned(),
        }
    });
    Some(Event {
        uid: get("UID").map_or_else(
            || format!("{}@{}", start.ms, lines.len()),
            |line| line.value.trim().to_owned(),
        ),
        summary: get("SUMMARY")
            .map(|line| text(&line.value))
            .unwrap_or_default(),
        description: get("DESCRIPTION")
            .map(|line| text(&line.value))
            .unwrap_or_default(),
        location: get("LOCATION")
            .map(|line| text(&line.value))
            .unwrap_or_default(),
        url: get("URL").map(|line| line.value.trim().to_owned()),
        organizer,
        status: get("STATUS").map(|line| line.value.trim().to_owned()),
        start,
        length,
        rule,
        rule_text,
        exdates,
        recurrence_id,
    })
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    next.and_then(|next| next.pred_opt())
        .map_or(28, |last| last.day())
}

/// The days of a month a rule picks.
fn month_days(rule: &Rule, year: i32, month: u32, start_day: u32) -> Vec<NaiveDate> {
    let last = days_in_month(year, month);
    let date = |day: u32| NaiveDate::from_ymd_opt(year, month, day);
    let mut days: Vec<NaiveDate> = Vec::new();
    if !rule.by_month_day.is_empty() {
        for day in &rule.by_month_day {
            let day = if *day < 0 {
                last as i32 + day + 1
            } else {
                *day
            };
            if (1..=last as i32).contains(&day) {
                days.extend(date(day as u32));
            }
        }
    } else if !rule.by_day.is_empty() {
        for (ordinal, weekday) in &rule.by_day {
            let matching: Vec<NaiveDate> = (1..=last)
                .filter_map(date)
                .filter(|day| day.weekday() == *weekday)
                .collect();
            match ordinal {
                None => days.extend(matching),
                Some(n) if *n > 0 => days.extend(matching.get(*n as usize - 1)),
                Some(n) => days.extend(
                    matching
                        .len()
                        .checked_sub(n.unsigned_abs() as usize)
                        .and_then(|at| matching.get(at)),
                ),
            }
        }
    } else if start_day <= last {
        days.extend(date(start_day));
    }
    days.sort();
    days.dedup();
    days
}

/// The local start times of a rule's instances, in order, from the
/// event's start, until `to` (and the rule's own end).
fn instances(event: &Event, rule: &Rule, to: i64) -> Vec<i64> {
    let start = &event.start;
    let time = start.local.time();
    let first = start.local.date();
    let interval = rule.interval.max(1) as i64;
    let mut out = Vec::new();
    let mut emitted = 0u32;
    let mut push = |date: NaiveDate, out: &mut Vec<i64>| -> bool {
        // Whether to go on.
        if date < first {
            return true;
        }
        if !rule.by_month.is_empty() && !rule.by_month.contains(&date.month()) {
            return true;
        }
        let at = instant(start.zone, date.and_time(time));
        if rule.until.is_some_and(|until| at > until) || at >= to {
            return false;
        }
        if rule.count.is_some_and(|count| emitted >= count) {
            return false;
        }
        emitted += 1;
        out.push(at);
        out.len() < MAX_STEPS
    };
    match rule.freq {
        Freq::Daily => {
            for step in 0..MAX_STEPS as i64 {
                let date = first + Duration::days(step * interval);
                if !rule.by_day.is_empty()
                    && !rule.by_day.iter().any(|(_, day)| *day == date.weekday())
                {
                    if instant(start.zone, date.and_time(time)) >= to {
                        break;
                    }
                    continue;
                }
                if !push(date, &mut out) {
                    break;
                }
            }
        }
        Freq::Weekly => {
            let mut days: Vec<Weekday> = rule.by_day.iter().map(|(_, day)| *day).collect();
            if days.is_empty() {
                days.push(first.weekday());
            }
            let offset = |day: Weekday| {
                (day.num_days_from_monday() as i64 - rule.week_start.num_days_from_monday() as i64)
                    .rem_euclid(7)
            };
            days.sort_by_key(|day| offset(*day));
            days.dedup();
            let week = first - Duration::days(offset(first.weekday()));
            'weeks: for step in 0..MAX_STEPS as i64 {
                let monday = week + Duration::weeks(step * interval);
                for day in &days {
                    if !push(monday + Duration::days(offset(*day)), &mut out) {
                        break 'weeks;
                    }
                }
            }
        }
        Freq::Monthly => {
            'months: for step in 0..MAX_STEPS as i64 {
                let months = first.month0() as i64 + step * interval;
                let year = first.year() + (months / 12) as i32;
                let month = (months % 12) as u32 + 1;
                if year > first.year() + 200 {
                    break;
                }
                for date in month_days(rule, year, month, first.day()) {
                    if !push(date, &mut out) {
                        break 'months;
                    }
                }
            }
        }
        Freq::Yearly => {
            let months = if rule.by_month.is_empty() {
                vec![first.month()]
            } else {
                let mut months = rule.by_month.clone();
                months.sort_unstable();
                months
            };
            'years: for step in 0..200i64 {
                let year = first.year() + (step * interval) as i32;
                for month in &months {
                    for date in month_days(rule, year, *month, first.day()) {
                        if !push(date, &mut out) {
                            break 'years;
                        }
                    }
                }
            }
        }
    }
    out
}

/// The instances of the feed's events that overlap `[from, to)`, by start.
pub fn occurrences(events: &[Event], from: i64, to: i64) -> Vec<Occurrence> {
    let overridden: std::collections::HashSet<(String, i64)> = events
        .iter()
        .filter_map(|event| event.recurrence_id.map(|at| (event.uid.clone(), at)))
        .collect();
    let mut found = Vec::new();
    for (index, event) in events.iter().enumerate() {
        if event.cancelled() {
            continue;
        }
        let starts = match (&event.rule, event.recurrence_id) {
            (Some(rule), None) if !rule.partial => instances(event, rule, to),
            _ => vec![event.start.ms],
        };
        for start in starts {
            if event.recurrence_id.is_none()
                && (event.exdates.contains(&start)
                    || overridden.contains(&(event.uid.clone(), start)))
            {
                continue;
            }
            let end = start + event.length;
            let overlaps = if event.length == 0 {
                start >= from && start < to
            } else {
                end > from && start < to
            };
            if overlaps {
                found.push(Occurrence {
                    event: index,
                    start,
                    end,
                });
            }
        }
    }
    found.sort_by_key(|occurrence| (occurrence.start, occurrence.event));
    found.truncate(MAX_OCCURRENCES);
    found
}

/// When an event comes next at or after `now` (its start when it has no
/// instance left), for the item a poll keeps.
pub fn next_start(events: &[Event], index: usize, now: i64) -> i64 {
    let event = &events[index];
    match &event.rule {
        Some(rule) if !rule.partial && event.recurrence_id.is_none() => {
            instances(event, rule, now + 400 * 86_400_000)
                .into_iter()
                .find(|at| *at + event.length > now && !event.exdates.contains(at))
                .unwrap_or(event.start.ms)
        }
        _ => event.start.ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAIPEI: Tz = chrono_tz::Asia::Taipei;

    fn at(text: &str) -> i64 {
        let local = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap();
        instant(TAIPEI, local)
    }

    const FEED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
BEGIN:VTIMEZONE\r\nTZID:Asia/Taipei\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nUID:db@school\r\nSUMMARY:資料庫系統\\, 期中\r\nLOCATION:EE-101\r\nDTSTART;TZID=Asia/Taipei:20261005T091000\r\nDTEND;TZID=Asia/Taipei:20261005T120000\r\n\
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T000000Z\r\nEXDATE;TZID=Asia/Taipei:20261026T091000\r\n\
DESCRIPTION:Bring a laptop\\nand a pen\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:not this\r\nEND:VALARM\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:db@school\r\nRECURRENCE-ID;TZID=Asia/Taipei:20261019T091000\r\nSUMMARY:資料庫系統 (moved)\r\nDTSTART;TZID=Asia/Taipei:20261020T140000\r\nDTEND;TZID=Asia/Taipei:20261020T170000\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:hw3\r\nSUMMARY:HW3 due\r\nDTSTART;VALUE=DATE:20261024\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:long\r\nSUMMARY:A long\r\n  folded title\r\nDTSTART:20261021T010000Z\r\nDURATION:PT1H30M\r\nEND:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn reads_a_feed() {
        let events = parse(FEED, TAIPEI);
        assert_eq!(events.len(), 4);
        let class = &events[0];
        assert_eq!(class.summary, "資料庫系統, 期中");
        assert_eq!(class.description, "Bring a laptop\nand a pen");
        assert_eq!(class.start.ms, at("2026-10-05 09:10"));
        assert_eq!(class.length, (2 * 60 + 50) * 60_000);
        assert_eq!(events[1].recurrence_id, Some(at("2026-10-19 09:10")));
        assert!(events[2].start.all_day);
        assert_eq!(events[2].length, 86_400_000);
        assert_eq!(events[3].summary, "A long folded title");
        assert_eq!(events[3].length, 90 * 60_000);
        assert_ne!(events[0].key(), events[1].key());
    }

    #[test]
    fn expands_a_window() {
        let events = parse(FEED, TAIPEI);
        let found = occurrences(&events, at("2026-10-12 00:00"), at("2026-11-03 00:00"));
        let seen: Vec<(usize, i64)> = found.iter().map(|o| (o.event, o.start)).collect();
        assert_eq!(
            seen,
            [
                (0, at("2026-10-12 09:10")),
                // 10/19 moved to the 20th; 10/26 excluded.
                (1, at("2026-10-20 14:00")),
                (3, at("2026-10-21 09:00")),
                (2, at("2026-10-24 00:00")),
                (0, at("2026-11-02 09:10")),
            ]
        );
        assert_eq!(
            next_start(&events, 0, at("2026-10-27 12:00")),
            at("2026-11-02 09:10")
        );
    }

    fn starts(rule: &str, start: &str, to: &str) -> Vec<i64> {
        let feed = format!(
            "BEGIN:VEVENT\nUID:x\nDTSTART;TZID=Asia/Taipei:{start}\nRRULE:{rule}\nEND:VEVENT\n"
        );
        let events = parse(&feed, TAIPEI);
        occurrences(&events, 0, at(to))
            .into_iter()
            .map(|o| o.start)
            .collect()
    }

    #[test]
    fn rules() {
        assert_eq!(
            starts(
                "FREQ=DAILY;INTERVAL=2;COUNT=3",
                "20261001T080000",
                "2027-01-01 00:00"
            ),
            [
                at("2026-10-01 08:00"),
                at("2026-10-03 08:00"),
                at("2026-10-05 08:00")
            ]
        );
        // Every other week on Tuesday and Thursday.
        assert_eq!(
            starts(
                "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
                "20261006T100000",
                "2026-10-25 00:00"
            ),
            [
                at("2026-10-06 10:00"),
                at("2026-10-08 10:00"),
                at("2026-10-20 10:00"),
                at("2026-10-22 10:00")
            ]
        );
        // The last Friday of the month, and the 31st only where there is one.
        assert_eq!(
            starts(
                "FREQ=MONTHLY;BYDAY=-1FR;COUNT=2",
                "20261030T090000",
                "2027-12-01 00:00"
            ),
            [at("2026-10-30 09:00"), at("2026-11-27 09:00")]
        );
        assert_eq!(
            starts(
                "FREQ=MONTHLY;COUNT=3",
                "20261031T090000",
                "2027-12-01 00:00"
            ),
            [
                at("2026-10-31 09:00"),
                at("2026-12-31 09:00"),
                at("2027-01-31 09:00")
            ]
        );
        assert_eq!(
            starts(
                "FREQ=YEARLY;BYMONTH=3",
                "20260315T000000",
                "2028-12-01 00:00"
            ),
            [
                at("2026-03-15 00:00"),
                at("2027-03-15 00:00"),
                at("2028-03-15 00:00")
            ]
        );
        // Parts it does not follow: the first instance only.
        assert_eq!(
            starts(
                "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU",
                "20261001T090000",
                "2027-12-01 00:00"
            ),
            [at("2026-10-01 09:00")]
        );
    }

    #[test]
    fn zones_and_values() {
        assert_eq!(
            zone(Some("/mozilla.org/20050126_1/Asia/Tokyo"), TAIPEI),
            chrono_tz::Asia::Tokyo
        );
        assert_eq!(zone(Some("Taipei Standard Time"), TAIPEI), TAIPEI);
        assert_eq!(duration("P1DT2H"), Some(26 * 3_600_000));
        assert_eq!(duration("-PT15M"), Some(-15 * 60_000));
        assert_eq!(duration("P2W"), Some(14 * 86_400_000));
        assert_eq!(duration("X"), None);
        // New York's DST gap: 02:30 does not exist on 2026-03-08.
        let new_york = chrono_tz::America::New_York;
        let local = NaiveDateTime::parse_from_str("2026-03-08 02:30", "%Y-%m-%d %H:%M").unwrap();
        let moved = NaiveDateTime::parse_from_str("2026-03-08 03:30", "%Y-%m-%d %H:%M").unwrap();
        assert_eq!(instant(new_york, local), instant(new_york, moved));
    }
}
