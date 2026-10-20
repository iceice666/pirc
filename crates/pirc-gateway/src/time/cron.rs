//! Fire times: a port of the parts of `croner` 10.0.1 (MIT, Hexagon) that
//! `daemon/schedules.ts` uses — `new Cron(pattern, {timezone}).nextRun(from)`
//! for a cron pattern or an ISO 8601 time — and the time zone handling
//! `Intl.DateTimeFormat` gave it. Ported line by line rather than replaced
//! by the Rust `croner` crate: croner's error messages reach users
//! (`Invalid cron "...": <message>`), and its daylight-saving behavior (a
//! wall time in a gap moves past it, one in an overlap takes the first
//! occurrence) must not drift.

use chrono::{DateTime, Offset, TimeZone};

/// A time zone as `Intl.DateTimeFormat` accepts it: an IANA name (any
/// case) or a UTC offset (`+05:00`, `+0500`, `+05`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zone {
    Named(chrono_tz::Tz),
    /// Seconds east of UTC.
    Fixed(i64),
}

impl Zone {
    pub fn parse(name: &str) -> Option<Self> {
        if let Some(offset) = fixed_offset(name) {
            return Some(Self::Fixed(offset));
        }
        chrono_tz::Tz::from_str_insensitive(name)
            .ok()
            .map(Self::Named)
    }

    /// Seconds east of UTC at the instant `ms`.
    fn offset_at(self, ms: i64) -> i64 {
        match self {
            Self::Fixed(offset) => offset,
            Self::Named(tz) => match DateTime::from_timestamp_millis(ms) {
                Some(utc) => i64::from(
                    tz.offset_from_utc_datetime(&utc.naive_utc())
                        .fix()
                        .local_minus_utc(),
                ),
                None => 0,
            },
        }
    }
}

/// `±HH:MM`, `±HHMM` or `±HH` (hours 0–23).
fn fixed_offset(name: &str) -> Option<i64> {
    let bytes = name.as_bytes();
    let sign = match bytes.first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = name.get(range)?;
        (part.len() == 2 && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    let hours = digits(1..3)?;
    let minutes = match bytes.len() {
        3 => 0,
        5 => digits(3..5)?,
        6 if bytes[3] == b':' => digits(4..6)?,
        _ => return None,
    };
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 3600 + minutes * 60))
}

/// Wall-clock components (`TimePoint`): month 1–12.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Wall {
    pub y: i64,
    pub m: i64,
    pub d: i64,
    pub h: i64,
    pub i: i64,
    pub s: i64,
}

impl Wall {
    fn ms(self) -> i64 {
        date_utc(self.y, self.m - 1, self.d, self.h, self.i, self.s, 0)
    }
}

const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1–12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1–12, day) of days since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        m,
        d,
    )
}

/// `Date.UTC(y, m0, d, h, i, s, ms)`: out-of-range parts carry over, and
/// years 0–99 mean 1900–1999.
pub fn date_utc(y: i64, m0: i64, d: i64, h: i64, i: i64, s: i64, ms: i64) -> i64 {
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    let year = y + m0.div_euclid(12);
    let month = m0.rem_euclid(12);
    let days = days_from_civil(year, month + 1, 1) + d - 1;
    days * DAY_MS + h * 3_600_000 + i * 60_000 + s * 1000 + ms
}

/// The UTC components of `ms` (`getUTC*`), milliseconds dropped.
fn utc_wall(ms: i64) -> Wall {
    let (y, m, d) = civil_from_days(ms.div_euclid(DAY_MS));
    let rest = ms.rem_euclid(DAY_MS) / 1000;
    Wall {
        y,
        m,
        d,
        h: rest / 3600,
        i: rest / 60 % 60,
        s: rest % 60,
    }
}

/// Day of the week (0 = Sunday) of `Date.UTC(y, m0, d)`.
fn weekday(y: i64, m0: i64, d: i64) -> i64 {
    (date_utc(y, m0, d, 0, 0, 0, 0).div_euclid(DAY_MS) + 4).rem_euclid(7)
}

/// What `ms` looks like on a wall clock in `zone` (croner's `toTZ`).
pub fn to_tz(ms: i64, zone: Zone) -> Wall {
    utc_wall(ms + zone.offset_at(ms) * 1000)
}

/// The instant a wall time in `zone` names (croner's `fromTZ`, never
/// throwing): in a gap, the time after it; in an overlap, the first.
pub fn from_tz(tp: Wall, zone: Zone) -> i64 {
    let target = tp.ms();
    let check0 = to_tz(target, zone);
    let guess = target + (target - check0.ms());
    let check1 = to_tz(guess, zone);
    if check1 == tp {
        let alt = guess - 3_600_000;
        if to_tz(alt, zone) == tp {
            return alt;
        }
        return guess;
    }
    let guess2 = guess + target - check1.ms();
    if to_tz(guess2, zone) == tp {
        return guess2;
    }
    guess.max(guess2)
}

/// `formatTime`: `2026-10-01 09:00 (Asia/Taipei)` (`Intl.DateTimeFormat`
/// in `en-CA`, 24 hours), with the zone as the user wrote it.
pub fn format_time(at: i64, zone: Zone, name: &str) -> String {
    let wall = to_tz(at, zone);
    format!(
        "{}-{:02}-{:02} {:02}:{:02} ({name})",
        wall.y, wall.m, wall.d, wall.h, wall.i
    )
}

// ---------- patterns (croner's pattern.ts) ----------

const LAST_OCCURRENCE: i64 = 0b100000;
const ANY_OCCURRENCE: i64 = 0b11111 | LAST_OCCURRENCE;
const OCCURRENCE_BITMASKS: [i64; 5] = [0b00001, 0b00010, 0b00100, 0b01000, 0b10000];

/// A croner error: its message.
#[derive(Clone, Debug, PartialEq)]
pub struct CronError(pub String);

fn err<T>(message: impl Into<String>) -> Result<T, CronError> {
    Err(CronError(message.into()))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Part {
    Second,
    Minute,
    Hour,
    Day,
    Month,
    DayOfWeek,
    Year,
    NearestWeekdays,
}

impl Part {
    fn name(self) -> &'static str {
        match self {
            Self::Second => "second",
            Self::Minute => "minute",
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Month => "month",
            Self::DayOfWeek => "dayOfWeek",
            Self::Year => "year",
            Self::NearestWeekdays => "nearestWeekdays",
        }
    }
}

/// The value a part is set to: the default (1, or every occurrence of a
/// weekday) or the text after `#`/the `L` of a weekday.
enum Nth {
    Default(i64),
    Text(String),
}

#[derive(Clone, Debug)]
pub struct Pattern {
    second: Vec<i64>,
    minute: Vec<i64>,
    hour: Vec<i64>,
    day: Vec<i64>,
    month: Vec<i64>,
    day_of_week: Vec<i64>,
    year: Vec<i64>,
    last_day_of_month: bool,
    last_weekday: bool,
    nearest_weekdays: Vec<i64>,
    star_dom: bool,
    star_dow: bool,
    star_year: bool,
    use_and_logic: bool,
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    pirc_config::js_space(c) || c == '\u{3000}' || c == '\u{feff}'
}

/// `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `parseInt(text, 10)`: `None` for `NaN`.
fn parse_int(text: &str) -> Option<f64> {
    let text = js_trim(text);
    let (sign, digits) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    let end = digits
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    digits[..end].parse::<f64>().ok().map(|value| sign * value)
}

/// `String(number)` for the integers croner prints.
fn js_number(value: f64) -> String {
    if value == 0.0 {
        "0".into()
    } else if value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        let text = format!("{value:e}");
        match text.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => text,
        }
    }
}

/// ASCII case-insensitive replace-all (`text.replace(/needle/gi, with)`).
fn replace_ci(text: &str, needle: &str, with: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut at = 0;
    while let Some(found) = lower[at..].find(needle) {
        let start = at + found;
        out.push_str(&text[last..start]);
        out.push_str(with);
        last = start + needle.len();
        at = last;
    }
    out.push_str(&text[last..]);
    out
}

impl Pattern {
    /// `new CronPattern(pattern)` in croner's defaults: `auto` mode, OR of
    /// day of month and day of week, no Quartz weekdays, strict stepping.
    pub fn parse(pattern: &str) -> Result<Self, CronError> {
        let mut this = Self {
            second: vec![0; 60],
            minute: vec![0; 60],
            hour: vec![0; 24],
            day: vec![0; 31],
            month: vec![0; 12],
            day_of_week: vec![0; 7],
            year: vec![0; 10000],
            last_day_of_month: false,
            last_weekday: false,
            nearest_weekdays: vec![0; 31],
            star_dom: false,
            star_dow: false,
            star_year: false,
            use_and_logic: false,
        };
        let mut pattern = pattern.to_owned();
        if pattern.contains('@') {
            pattern = js_trim(&handle_nicknames(&pattern)?).to_owned();
        }
        let mut parts: Vec<String> = pattern
            .split(js_space)
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect();
        if parts.is_empty() {
            parts.push(String::new());
        }
        if parts.len() < 5 || parts.len() > 7 {
            return err(format!(
                "CronPattern: invalid configuration format ('{pattern}'), exactly five, six, or seven space separated parts are required."
            ));
        }
        if parts.len() == 5 {
            parts.insert(0, "0".into());
        }
        if parts.len() == 6 {
            parts.push("*".into());
        }
        if parts[3].to_uppercase() == "LW" {
            this.last_weekday = true;
            parts[3] = String::new();
        } else if parts[3].to_uppercase().contains('L') {
            parts[3] = parts[3].replace(['L', 'l'], "");
            this.last_day_of_month = true;
        }
        if parts[3] == "*" {
            this.star_dom = true;
        }
        if parts[6] == "*" {
            this.star_year = true;
        }
        if parts[4].encode_utf16().count() >= 3 {
            parts[4] = replace_alpha_months(&parts[4]);
        }
        if parts[5].encode_utf16().count() >= 3 {
            parts[5] = replace_alpha_days(&parts[5]);
        }
        if let Some(rest) = parts[5].strip_prefix('+') {
            this.use_and_logic = true;
            parts[5] = rest.to_owned();
            if parts[5].is_empty() {
                return err("CronPattern: Day-of-week field cannot be empty after '+' modifier.");
            }
        }
        if parts[5] == "*" {
            this.star_dow = true;
        }
        if pattern.contains('?') {
            for part in parts.iter_mut() {
                *part = part.replace('?', "*");
            }
        }
        throw_at_illegal_characters(&parts)?;
        this.part_to_array(Part::Second, &parts[0], 0, 1)?;
        this.part_to_array(Part::Minute, &parts[1], 0, 1)?;
        this.part_to_array(Part::Hour, &parts[2], 0, 1)?;
        this.part_to_array(Part::Day, &parts[3], -1, 1)?;
        this.part_to_array(Part::Month, &parts[4], -1, 1)?;
        this.part_to_array(Part::DayOfWeek, &parts[5], 0, ANY_OCCURRENCE)?;
        this.part_to_array(Part::Year, &parts[6], 0, 1)?;
        Ok(this)
    }

    fn array(&mut self, part: Part) -> &mut Vec<i64> {
        match part {
            Part::Second => &mut self.second,
            Part::Minute => &mut self.minute,
            Part::Hour => &mut self.hour,
            Part::Day => &mut self.day,
            Part::Month => &mut self.month,
            Part::DayOfWeek => &mut self.day_of_week,
            Part::Year => &mut self.year,
            Part::NearestWeekdays => &mut self.nearest_weekdays,
        }
    }

    fn part_to_array(
        &mut self,
        part: Part,
        conf: &str,
        offset: i64,
        default: i64,
    ) -> Result<(), CronError> {
        let modified_day = part == Part::Day && (self.last_day_of_month || self.last_weekday);
        if conf.is_empty() && !modified_day {
            return err(format!(
                "CronPattern: configuration entry {} ({conf}) is empty, check for trailing spaces.",
                part.name()
            ));
        }
        if conf == "*" {
            self.array(part).fill(default);
            return Ok(());
        }
        let split: Vec<&str> = conf.split(',').collect();
        if split.len() > 1 {
            for item in split {
                self.part_to_array(part, item, offset, default)?;
            }
        } else if conf.contains('-') && conf.contains('/') {
            self.handle_range_with_stepping(conf, part, offset, default)?;
        } else if conf.contains('-') {
            self.handle_range(conf, part, offset, default)?;
        } else if conf.contains('/') {
            self.handle_stepping(conf, part, default)?;
        } else if !conf.is_empty() {
            self.handle_number(conf, part, offset, default)?;
        }
        Ok(())
    }

    fn handle_number(
        &mut self,
        conf: &str,
        part: Part,
        offset: i64,
        default: i64,
    ) -> Result<(), CronError> {
        let (rest, nth) = extract_nth(conf, part)?;
        let nearest = conf.to_uppercase().contains('W');
        if part != Part::Day && nearest {
            return err("CronPattern: Nearest weekday modifier (W) only allowed in day-of-month.");
        }
        let part = if nearest { Part::NearestWeekdays } else { part };
        let Some(value) = parse_int(&rest) else {
            return err(format!(
                "CronPattern: {} is not a number: '{conf}'",
                part.name()
            ));
        };
        self.set_part(part, value + offset as f64, nth_or(nth, default))
    }

    fn set_part(&mut self, part: Part, index: f64, value: Nth) -> Result<(), CronError> {
        let invalid = |part: Part, index: f64| {
            err(format!(
                "CronPattern: Invalid value for {}: {}",
                part.name(),
                js_number(index)
            ))
        };
        if part == Part::DayOfWeek {
            let index = if index == 7.0 { 0.0 } else { index };
            if !(0.0..=6.0).contains(&index) {
                return invalid(part, index);
            }
            return self.set_nth_weekday_of_month(index as usize, value);
        }
        let length = match part {
            Part::Second | Part::Minute => 60.0,
            Part::Hour => 24.0,
            Part::Day | Part::NearestWeekdays => 31.0,
            Part::Month => 12.0,
            _ => 10000.0,
        };
        if part == Part::Year {
            if !(1.0..10000.0).contains(&index) {
                return err(format!(
                    "CronPattern: Invalid value for year: {} (supported range: 1-9999)",
                    js_number(index)
                ));
            }
        } else if !(0.0..length).contains(&index) {
            return invalid(part, index);
        }
        let value = match value {
            Nth::Default(value) => value,
            // Only a weekday has an nth text (extract_nth refuses others).
            Nth::Text(_) => 1,
        };
        self.array(part)[index as usize] = value;
        Ok(())
    }

    fn set_nth_weekday_of_month(&mut self, index: usize, nth: Nth) -> Result<(), CronError> {
        let (number, shown, kind) = match &nth {
            Nth::Text(text) if text.to_uppercase() == "L" => {
                self.day_of_week[index] |= LAST_OCCURRENCE;
                return Ok(());
            }
            Nth::Default(ANY_OCCURRENCE) => {
                self.day_of_week[index] = ANY_OCCURRENCE;
                return Ok(());
            }
            Nth::Default(value) => (*value as f64, value.to_string(), "number"),
            Nth::Text(text) => (js_to_number(text), text.clone(), "string"),
        };
        if number < 6.0 && number > 0.0 && number.fract() == 0.0 {
            self.day_of_week[index] |= OCCURRENCE_BITMASKS[number as usize - 1];
            return Ok(());
        }
        err(format!(
            "CronPattern: nth weekday out of range, should be 1-5 or L. Value: {shown}, Type: {kind}"
        ))
    }

    fn validate_range(
        &self,
        lower: f64,
        upper: f64,
        steps: Option<f64>,
        part: Part,
        conf: &str,
    ) -> Result<(), CronError> {
        if lower > upper {
            return err(format!(
                "CronPattern: From value is larger than to value: '{conf}'"
            ));
        }
        if let Some(steps) = steps {
            if steps == 0.0 {
                return err("CronPattern: Syntax error, illegal stepping: 0");
            }
            let length = self.length(part);
            if steps > length as f64 {
                return err(format!(
                    "CronPattern: Syntax error, steps cannot be greater than maximum value of part ({length})"
                ));
            }
        }
        Ok(())
    }

    fn length(&self, part: Part) -> usize {
        match part {
            Part::Second | Part::Minute => 60,
            Part::Hour => 24,
            Part::Day | Part::NearestWeekdays => 31,
            Part::Month => 12,
            Part::DayOfWeek => 7,
            Part::Year => 10000,
        }
    }

    fn handle_range_with_stepping(
        &mut self,
        conf: &str,
        part: Part,
        offset: i64,
        default: i64,
    ) -> Result<(), CronError> {
        if conf.to_uppercase().contains('W') {
            return err("CronPattern: Syntax error, W is not allowed in ranges with stepping.");
        }
        let (rest, nth) = extract_nth(conf, part)?;
        let Some((range, steps)) = rest.split_once('/') else {
            return illegal_range_with_stepping(conf);
        };
        let Some((lower, upper)) = range.split_once('-') else {
            return illegal_range_with_stepping(conf);
        };
        let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
        if !digits(lower) || !digits(upper) || !digits(steps) {
            return illegal_range_with_stepping(conf);
        }
        let lower = parse_int(lower).unwrap_or(f64::NAN) + offset as f64;
        let upper = parse_int(upper).unwrap_or(f64::NAN) + offset as f64;
        let steps = parse_int(steps).unwrap_or(f64::NAN);
        self.validate_range(lower, upper, Some(steps), part, conf)?;
        let mut i = lower;
        while i <= upper {
            self.set_part(part, i, nth_or(nth.clone(), default))?;
            i += steps;
        }
        Ok(())
    }

    fn handle_range(
        &mut self,
        conf: &str,
        part: Part,
        offset: i64,
        default: i64,
    ) -> Result<(), CronError> {
        if conf.to_uppercase().contains('W') {
            return err("CronPattern: Syntax error, W is not allowed in a range.");
        }
        let (rest, nth) = extract_nth(conf, part)?;
        let split: Vec<&str> = rest.split('-').collect();
        if split.len() != 2 {
            return err(format!(
                "CronPattern: Syntax error, illegal range: '{conf}'"
            ));
        }
        let Some(lower) = parse_int(split[0]) else {
            return err("CronPattern: Syntax error, illegal lower range (NaN)");
        };
        let Some(upper) = parse_int(split[1]) else {
            return err("CronPattern: Syntax error, illegal upper range (NaN)");
        };
        let (lower, upper) = (lower + offset as f64, upper + offset as f64);
        self.validate_range(lower, upper, None, part, conf)?;
        let mut i = lower;
        while i <= upper {
            self.set_part(part, i, nth_or(nth.clone(), default))?;
            i += 1.0;
        }
        Ok(())
    }

    fn handle_stepping(&mut self, conf: &str, part: Part, default: i64) -> Result<(), CronError> {
        if conf.to_uppercase().contains('W') {
            return err("CronPattern: Syntax error, W is not allowed in parts with stepping.");
        }
        let (rest, nth) = extract_nth(conf, part)?;
        let split: Vec<&str> = rest.split('/').collect();
        if split.len() != 2 {
            return err(format!(
                "CronPattern: Syntax error, illegal stepping: '{conf}'"
            ));
        }
        if split[0].is_empty() {
            return err(format!(
                "CronPattern: Syntax error, stepping with missing prefix ('{conf}') is not allowed. Use wildcard (*/step) or range (min-max/step) instead."
            ));
        }
        if split[0] != "*" {
            return err(format!(
                "CronPattern: Syntax error, stepping with numeric prefix ('{conf}') is not allowed. Use wildcard (*/step) or range (min-max/step) instead."
            ));
        }
        let Some(steps) = parse_int(split[1]) else {
            return err("CronPattern: Syntax error, illegal stepping: (NaN)");
        };
        let length = self.length(part) as f64;
        self.validate_range(0.0, length - 1.0, Some(steps), part, conf)?;
        let mut i = 0.0;
        while i < length {
            self.set_part(part, i, nth_or(nth.clone(), default))?;
            i += steps;
        }
        Ok(())
    }
}

impl Clone for Nth {
    fn clone(&self) -> Self {
        match self {
            Self::Default(value) => Self::Default(*value),
            Self::Text(text) => Self::Text(text.clone()),
        }
    }
}

/// `result[1] || defaultValue`.
fn nth_or(nth: Option<String>, default: i64) -> Nth {
    match nth {
        Some(text) if !text.is_empty() => Nth::Text(text),
        _ => Nth::Default(default),
    }
}

/// `Number(text)` for the texts after `#` (digits, `L` or `l`).
fn js_to_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return trimmed.parse().unwrap_or(f64::NAN);
    }
    f64::NAN
}

fn illegal_range_with_stepping<T>(conf: &str) -> Result<T, CronError> {
    err(format!(
        "CronPattern: Syntax error, illegal range with stepping: '{conf}'"
    ))
}

/// Split off a weekday's `#n` or `L`; other parts may have neither.
fn extract_nth(conf: &str, part: Part) -> Result<(String, Option<String>), CronError> {
    if conf.contains('#') {
        if part != Part::DayOfWeek {
            return err("CronPattern: nth (#) only allowed in day-of-week field");
        }
        let mut split = conf.split('#');
        let rest = split.next().unwrap_or_default().to_owned();
        let nth = split.next().unwrap_or_default().to_owned();
        return Ok((rest, Some(nth)));
    }
    if conf.to_uppercase().ends_with('L') {
        if part != Part::DayOfWeek {
            return err(
                "CronPattern: L modifier only allowed in day-of-week field (use L alone for day-of-month)",
            );
        }
        return Ok((conf[..conf.len() - 1].to_owned(), Some("L".into())));
    }
    Ok((conf.to_owned(), None))
}

fn throw_at_illegal_characters(parts: &[String]) -> Result<(), CronError> {
    for (i, part) in parts.iter().enumerate() {
        let allowed = |c: char| {
            matches!(c, '/' | '*' | ',' | '-' | '0'..='9')
                || (i == 3 && matches!(c, 'W' | 'w' | 'L' | 'l'))
                || (i == 5 && matches!(c, '#' | 'L' | 'l'))
        };
        if !part.chars().all(allowed) {
            return err(format!(
                "CronPattern: configuration entry {i} ({part}) contains illegal characters."
            ));
        }
    }
    Ok(())
}

fn replace_alpha_days(conf: &str) -> String {
    let mut out = replace_ci(conf, "-sun", "-7");
    for (name, number) in [
        ("sun", "0"),
        ("mon", "1"),
        ("tue", "2"),
        ("wed", "3"),
        ("thu", "4"),
        ("fri", "5"),
        ("sat", "6"),
    ] {
        out = replace_ci(&out, name, number);
    }
    out
}

fn replace_alpha_months(conf: &str) -> String {
    let mut out = conf.to_owned();
    for (name, number) in [
        ("jan", "1"),
        ("feb", "2"),
        ("mar", "3"),
        ("apr", "4"),
        ("may", "5"),
        ("jun", "6"),
        ("jul", "7"),
        ("aug", "8"),
        ("sep", "9"),
        ("oct", "10"),
        ("nov", "11"),
        ("dec", "12"),
    ] {
        out = replace_ci(&out, name, number);
    }
    out
}

fn handle_nicknames(pattern: &str) -> Result<String, CronError> {
    let clean = js_trim(pattern).to_lowercase();
    Ok(match clean.as_str() {
        "@yearly" | "@annually" => "0 0 1 1 *".into(),
        "@monthly" => "0 0 1 * *".into(),
        "@weekly" => "0 0 * * 0".into(),
        "@daily" | "@midnight" => "0 0 * * *".into(),
        "@hourly" => "0 * * * *".into(),
        "@reboot" => {
            return err(
                "CronPattern: @reboot is not supported in this environment. This is an event-based trigger that requires system startup detection.",
            );
        }
        _ => pattern.to_owned(),
    })
}

// ---------- dates (croner's date.ts) ----------

const DAYS_OF_MONTH: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Month,
    Day,
    Hour,
    Minute,
    Second,
}

/// `[target, parent, offset]`, parent `None` for the year.
const STEPS: [(Target, Option<Target>, i64); 5] = [
    (Target::Month, None, 0),
    (Target::Day, Some(Target::Month), -1),
    (Target::Hour, Some(Target::Day), 0),
    (Target::Minute, Some(Target::Hour), 0),
    (Target::Second, Some(Target::Minute), 0),
];

/// croner's `CronDate`: wall time in a zone, month 0–11.
#[derive(Clone, Copy, Debug)]
struct CronDate {
    zone: Zone,
    ms: i64,
    second: i64,
    minute: i64,
    hour: i64,
    day: i64,
    month: i64,
    year: i64,
}

fn last_day_of_month(year: i64, month: i64) -> i64 {
    if month != 1 {
        DAYS_OF_MONTH[month as usize]
    } else {
        utc_wall(date_utc(year, month + 1, 0, 0, 0, 0, 0)).d
    }
}

fn last_weekday(year: i64, month: i64) -> i64 {
    let last = last_day_of_month(year, month);
    match weekday(year, month, last) {
        0 => last - 2,
        6 => last - 1,
        _ => last,
    }
}

fn nearest_weekday(year: i64, month: i64, day: i64) -> i64 {
    let days = last_day_of_month(year, month);
    if day > days {
        return -1;
    }
    match weekday(year, month, day) {
        0 if day == days => day - 2,
        0 => day + 1,
        6 if day == 1 => day + 2,
        6 => day - 1,
        _ => day,
    }
}

fn is_nth_weekday_of_month(year: i64, month: i64, day: i64, nth: i64) -> bool {
    let wd = weekday(year, month, day);
    let count = (1..=day).filter(|d| weekday(year, month, *d) == wd).count();
    if nth & ANY_OCCURRENCE != 0
        && count >= 1
        && OCCURRENCE_BITMASKS
            .get(count - 1)
            .is_some_and(|mask| mask & nth != 0)
    {
        return true;
    }
    if nth & LAST_OCCURRENCE != 0 {
        let days = last_day_of_month(year, month);
        return !((day + 1)..=days).any(|d| weekday(year, month, d) == wd);
    }
    false
}

impl CronDate {
    fn from_ms(ms: i64, zone: Zone) -> Self {
        let wall = to_tz(ms, zone);
        Self {
            zone,
            ms: ms.rem_euclid(1000),
            second: wall.s,
            minute: wall.i,
            hour: wall.h,
            day: wall.d,
            month: wall.m - 1,
            year: wall.y,
        }
    }

    fn get(&self, target: Target) -> i64 {
        match target {
            Target::Month => self.month,
            Target::Day => self.day,
            Target::Hour => self.hour,
            Target::Minute => self.minute,
            Target::Second => self.second,
        }
    }

    fn set(&mut self, target: Target, value: i64) {
        match target {
            Target::Month => self.month = value,
            Target::Day => self.day = value,
            Target::Hour => self.hour = value,
            Target::Minute => self.minute = value,
            Target::Second => self.second = value,
        }
    }

    /// Normalize parts that are (or could be) out of range; croner's
    /// checks, its `hour > 59` included.
    fn apply(&mut self) -> bool {
        let suspicious = self.month > 11
            || self.month < 0
            || self.day > DAYS_OF_MONTH.get(self.month as usize).copied().unwrap_or(0)
            || self.day < 1
            || self.hour > 59
            || self.minute > 59
            || self.second > 59
            || self.hour < 0
            || self.minute < 0
            || self.second < 0;
        if !suspicious {
            return false;
        }
        let at = date_utc(
            self.year,
            self.month,
            self.day,
            self.hour,
            self.minute,
            self.second,
            self.ms,
        );
        let wall = utc_wall(at);
        self.ms = at.rem_euclid(1000);
        self.second = wall.s;
        self.minute = wall.i;
        self.hour = wall.h;
        self.day = wall.d;
        self.month = wall.m - 1;
        self.year = wall.y;
        true
    }

    fn pattern_part(pattern: &Pattern, target: Target) -> &Vec<i64> {
        match target {
            Target::Month => &pattern.month,
            Target::Day => &pattern.day,
            Target::Hour => &pattern.hour,
            Target::Minute => &pattern.minute,
            Target::Second => &pattern.second,
        }
    }

    /// `_findMatch` forwards: 1 unchanged, 2 changed, 3 none.
    fn find_next(&mut self, target: Target, pattern: &Pattern, offset: i64) -> u8 {
        let original = self.get(target);
        let last_dom = pattern
            .last_day_of_month
            .then(|| last_day_of_month(self.year, self.month));
        let first_weekday =
            (!pattern.star_dow && target == Target::Day).then(|| weekday(self.year, self.month, 1));
        let values = Self::pattern_part(pattern, target);
        let mut i = original + offset;
        while i < values.len() as i64 {
            let mut matched = i >= 0 && values[i as usize] != 0;
            if target == Target::Day && !matched {
                for (with_w, set) in pattern.nearest_weekdays.iter().enumerate() {
                    if *set == 0 {
                        continue;
                    }
                    let day = nearest_weekday(self.year, self.month, with_w as i64 - offset);
                    if day == -1 {
                        continue;
                    }
                    if day == i - offset {
                        matched = true;
                        break;
                    }
                }
            }
            if target == Target::Day
                && pattern.last_weekday
                && i - offset == last_weekday(self.year, self.month)
            {
                matched = true;
            }
            if target == Target::Day && last_dom == Some(i - offset) {
                matched = true;
            }
            if target == Target::Day && !pattern.star_dow {
                let first = first_weekday.unwrap_or(0);
                let mut dow =
                    pattern.day_of_week[((first + (i - offset) - 1).rem_euclid(7)) as usize];
                if dow != 0 && dow & ANY_OCCURRENCE != 0 {
                    dow = i64::from(is_nth_weekday_of_month(
                        self.year,
                        self.month,
                        i - offset,
                        dow,
                    ));
                }
                let dow = dow != 0;
                matched = if pattern.use_and_logic || pattern.star_dom {
                    matched && dow
                } else {
                    matched || dow
                };
            }
            if matched {
                self.set(target, i - offset);
                return if original != i - offset { 2 } else { 1 };
            }
            i += 1;
        }
        3
    }

    /// `recurse`, as a loop (every call of it was a tail call).
    fn recurse(&mut self, pattern: &Pattern, mut doing: usize) -> bool {
        loop {
            if doing == 0 && !pattern.star_year {
                if self.year >= 0
                    && self.year < pattern.year.len() as i64
                    && pattern.year[self.year as usize] == 0
                {
                    let found = ((self.year + 1)..(pattern.year.len() as i64).min(10000))
                        .find(|y| pattern.year[*y as usize] == 1);
                    let Some(found) = found else {
                        return false;
                    };
                    self.year = found;
                    self.month = 0;
                    self.day = 1;
                    self.hour = 0;
                    self.minute = 0;
                    self.second = 0;
                    self.ms = 0;
                }
                if self.year >= 10000 {
                    return false;
                }
            }
            let (target, parent, offset) = STEPS[doing];
            let res = self.find_next(target, pattern, offset);
            if res > 1 {
                for (reset, _, reset_offset) in &STEPS[doing + 1..] {
                    self.set(*reset, -reset_offset);
                }
                if res == 3 {
                    match parent {
                        None => self.year += 1,
                        Some(parent) => self.set(parent, self.get(parent) + 1),
                    }
                    self.set(target, -offset);
                    self.apply();
                    if doing == 0 && !pattern.star_year {
                        while self.year >= 0
                            && self.year < pattern.year.len() as i64
                            && pattern.year[self.year as usize] == 0
                            && self.year < 10000
                        {
                            self.year += 1;
                        }
                        if self.year >= 10000 || self.year >= pattern.year.len() as i64 {
                            return false;
                        }
                    }
                    doing = 0;
                    continue;
                } else if self.apply() {
                    doing = doing.saturating_sub(1);
                    // croner recurses with `doing - 1`; from the month (0)
                    // that is -1, which then reads no step: it cannot
                    // happen, as a month never needs normalizing.
                    continue;
                }
            }
            doing += 1;
            if doing >= STEPS.len() {
                return true;
            }
            if if pattern.star_year {
                self.year >= 3000
            } else {
                self.year >= 10000
            } {
                return false;
            }
        }
    }

    fn increment(mut self, pattern: &Pattern) -> Option<Self> {
        self.second += 1;
        self.ms = 0;
        self.apply();
        self.recurse(pattern, 0).then_some(self)
    }

    fn time(&self) -> i64 {
        from_tz(
            Wall {
                y: self.year,
                m: self.month + 1,
                d: self.day,
                h: self.hour,
                i: self.minute,
                s: self.second,
            },
            self.zone,
        )
    }
}

/// What `new Cron(pattern, {timezone})` holds: a pattern, or a one-off time.
#[derive(Clone, Debug)]
pub enum Cron {
    Pattern(Box<Pattern>),
    Once(i64),
}

impl Cron {
    /// `new Cron(text, {timezone})`: a text with a `:` after its first
    /// character is a time (ISO 8601), anything else a pattern.
    pub fn new(text: &str, zone: Zone) -> Result<Self, CronError> {
        if text.find(':').is_some_and(|at| at > 0) {
            let once = parse_iso_local(text, zone)
                .ok_or_else(|| CronError("Invalid ISO8601 passed to timezone parser.".into()))?;
            // `new CronDate(string, tz)` keeps the wall time in the zone.
            return Ok(Self::Once(CronDate::from_ms(once, zone).time()));
        }
        Pattern::parse(text).map(|pattern| Self::Pattern(Box::new(pattern)))
    }

    /// `nextRun(new Date(from))`: strictly after `from`, whole seconds.
    pub fn next_run(&self, from: i64, zone: Zone) -> Option<i64> {
        let previous = CronDate::from_ms(from, zone);
        match self {
            Self::Once(at) => (*at > previous.time()).then_some(*at),
            Self::Pattern(pattern) => previous.increment(pattern).map(|next| next.time()),
        }
    }
}

/// croner's `parseISOLocal` + `fromTZ`: the instant of an ISO 8601 time
/// that `Date.parse` accepts. Without an offset it is wall time in `zone`.
/// One with an offset (or a `Z`, `+` or `-` from its tenth character on,
/// as croner checks) is read in UTC. Seconds only.
///
/// `Date.parse` read a time without an offset in the process's zone and
/// croner read it back the same way; this reads it as UTC, which is the
/// same unless that zone skips the time (a gap) or the text ends in a
/// lowercase `z`. Bun's non-ISO fallbacks (`Oct 1 2026 09:00`,
/// `2026/10/01 09:00`) are not accepted.
fn parse_iso_local(text: &str, zone: Zone) -> Option<i64> {
    let instant = parse_iso(text)?;
    let tail: String = text.chars().skip(9).collect();
    if tail.contains(['Z', '+', '-']) {
        let wall = utc_wall(instant.utc_ms);
        Some(from_tz(wall, Zone::Fixed(0)))
    } else {
        let wall = utc_wall(instant.local_ms);
        Some(from_tz(wall, zone))
    }
}

/// A parsed ISO time: its instant, and (without an offset) its wall time
/// read as if in UTC.
struct Parsed {
    utc_ms: i64,
    local_ms: i64,
}

/// JavaScriptCore's ISO 8601 `Date.parse`: `YYYY[-MM[-DD]]` (or `±YYYYYY`),
/// then `T`, `t` or a space, `HH:mm[:ss[.fff…]]` and an optional `Z`, `z`,
/// `±HH:MM` or `±HHMM`. Days 1–31 in any month carry over; `24:00` is the
/// next midnight.
fn parse_iso(text: &str) -> Option<Parsed> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let number = |at: &mut usize, digits: usize| -> Option<i64> {
        let part = bytes.get(*at..*at + digits)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *at += digits;
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = match bytes.first()? {
        b'+' | b'-' => {
            let sign = if bytes[0] == b'-' { -1 } else { 1 };
            at = 1;
            let year = number(&mut at, 6)?;
            if sign == -1 && year == 0 {
                return None;
            }
            sign * year
        }
        _ => number(&mut at, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if bytes.get(at) == Some(&b'-') {
        at += 1;
        month = number(&mut at, 2)?;
        if bytes.get(at) == Some(&b'-') {
            at += 1;
            day = number(&mut at, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if !matches!(bytes.get(at), Some(b'T' | b't' | b' ')) {
        return None;
    }
    at += 1;
    let hour = number(&mut at, 2)?;
    if bytes.get(at) != Some(&b':') {
        return None;
    }
    at += 1;
    let minute = number(&mut at, 2)?;
    let (mut second, mut millis) = (0, 0);
    if bytes.get(at) == Some(&b':') {
        at += 1;
        second = number(&mut at, 2)?;
        if bytes.get(at) == Some(&b'.') {
            at += 1;
            let start = at;
            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == start {
                return None;
            }
            let fraction = &text[start..at];
            let first: String = fraction.chars().take(3).collect();
            millis = format!("{first:0<3}").parse().ok()?;
        }
    }
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute, second, millis) != (0, 0, 0))
    {
        return None;
    }
    let offset = match bytes.get(at) {
        None => None,
        Some(b'Z' | b'z') if at + 1 == bytes.len() => Some(0),
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            at += 1;
            let hours = number(&mut at, 2)?;
            if bytes.get(at) == Some(&b':') {
                at += 1;
            }
            let minutes = number(&mut at, 2)?;
            if at != bytes.len() || hours > 23 || minutes > 59 {
                return None;
            }
            Some(sign * (hours * 60 + minutes))
        }
        Some(_) => return None,
    };
    let local = date_utc(year, month - 1, day, hour, minute, second, millis);
    // Beyond the range of a JavaScript date.
    if local.abs() > 8_640_000_000_000_000 + 24 * 3_600_000 {
        return None;
    }
    Some(match offset {
        Some(minutes) => Parsed {
            utc_ms: local - minutes * 60_000,
            local_ms: local - minutes * 60_000,
        },
        None => Parsed {
            utc_ms: local,
            local_ms: local,
        },
    })
}

#[cfg(test)]
mod tests {
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
}
