//! Text as memory compares and stores it: JavaScript whitespace, NFKC
//! folding, UTF-16 clipping and local time stamps.

use std::sync::LazyLock;

use icu_normalizer::ComposingNormalizerBorrowed;
use pirc_config::js_space;
use tz::TimeZone;
use tz::timezone::TimeZoneSettings;

use crate::util::sha256_hex;

/// `text.replace(/\s+/g, ' ').trim()`.
pub fn squash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if js_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}

/// `text.split(/\s+/).filter(Boolean)`.
pub fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(js_space).filter(|word| !word.is_empty())
}

/// `text.normalize('NFKC').toLowerCase()`.
pub fn fold(text: &str) -> String {
    ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .to_lowercase()
}

/// Bump when [`index_terms`] changes: the gateway rebuilds the search
/// index at startup when the stored version differs.
pub const SEARCH_INDEX_VERSION: i64 = 1;

/// Phrases a search query becomes, at most.
const MAX_PHRASES: usize = 32;

/// Han, kana and Hangul: scripts written without spaces, indexed as
/// overlapping character pairs.
fn spaceless(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30ff}' // hiragana, katakana
        | '\u{31f0}'..='\u{31ff}' // katakana extensions
        | '\u{3400}'..='\u{4dbf}' // Han extension A
        | '\u{4e00}'..='\u{9fff}' // Han
        | '\u{f900}'..='\u{faff}' // Han compatibility
        | '\u{1100}'..='\u{11ff}' // Hangul jamo
        | '\u{3130}'..='\u{318f}' // Hangul compatibility jamo
        | '\u{ac00}'..='\u{d7af}' // Hangul syllables
        | '\u{20000}'..='\u{3134f}' // Han extensions B to H
    )
}

/// A folded text in runs of spaceless script and the rest.
fn runs(folded: &str) -> Vec<(bool, String)> {
    let mut runs: Vec<(bool, String)> = Vec::new();
    for c in folded.chars() {
        let cjk = spaceless(c);
        match runs.last_mut() {
            Some((kind, run)) if *kind == cjk => run.push(c),
            _ => runs.push((cjk, c.to_string())),
        }
    }
    runs
}

/// The overlapping pairs of a spaceless run (`資料庫` → `資料 料庫`).
fn bigrams(run: &str) -> Vec<String> {
    let chars: Vec<char> = run.chars().collect();
    chars.windows(2).map(|pair| pair.iter().collect()).collect()
}

/// The text the search index holds for `text`: folded, every spaceless
/// run as its overlapping pairs plus its last character alone (so each of
/// its characters starts some token, for one-character queries), the rest
/// as it is for FTS5's `unicode61` tokenizer to split on punctuation
/// (`foo_bar`, `src/db.rs`). Queries go through [`match_query`], built on
/// the same runs.
pub fn index_terms(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for (cjk, run) in runs(&fold(text)) {
        if !cjk {
            out.push_str(&run);
            continue;
        }
        out.push(' ');
        for pair in bigrams(&run) {
            out.push_str(&pair);
            out.push(' ');
        }
        out.extend(run.chars().last());
        out.push(' ');
    }
    out
}

/// An FTS5 string literal: double-quoted, inner quotes doubled, so nothing
/// in the user's query is FTS5 syntax.
fn phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// The FTS5 query for a search: every run of other script a phrase (its
/// words in order, so `search_in` is `search` then `in`), every pair of a
/// spaceless run a phrase of its own, and a lone spaceless character a
/// prefix (`"庫"*`), all joined with `OR` and ranked by BM25. A sentence
/// finds the notes sharing the most of its rare words and pairs. `None`
/// when the query holds nothing to search for.
pub fn match_query(query: &str) -> Option<String> {
    let phrases: Vec<String> = query_phrases(query)
        .iter()
        .map(|text| {
            let mut chars = text.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if spaceless(c) => format!("{}*", phrase(text)),
                _ => phrase(text),
            }
        })
        .collect();
    (!phrases.is_empty()).then(|| phrases.join(" OR "))
}

/// The folded texts of [`match_query`]'s phrases, to count how many of
/// them a hit holds.
pub fn query_phrases(query: &str) -> Vec<String> {
    let mut phrases: Vec<String> = Vec::new();
    let mut add = |item: String| {
        if phrases.len() < MAX_PHRASES && !phrases.contains(&item) {
            phrases.push(item);
        }
    };
    for word in words(&fold(query)) {
        for (cjk, run) in runs(word) {
            if !cjk {
                if run.chars().any(char::is_alphanumeric) {
                    add(run);
                }
                continue;
            }
            if run.chars().count() == 1 {
                add(run);
                continue;
            }
            for pair in bigrams(&run) {
                add(pair);
            }
        }
    }
    phrases
}

/// Hash that ignores case, width and spacing (`contentHash`).
pub fn content_hash(text: &str) -> String {
    sha256_hex(squash(&fold(text)))
}

/// `text.slice(0, max - 1).trimEnd() + '…'` when longer than `max` UTF-16 units.
pub fn clip(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    let head = String::from_utf16_lossy(&units[..max.saturating_sub(1)]);
    format!("{}…", head.trim_end_matches(js_space))
}

/// `1234567` as `toLocaleString('en-US')` writes it: `1,234,567`.
pub fn grouped(number: i64) -> String {
    let digits = number.unsigned_abs().to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    if number < 0 { format!("-{out}") } else { out }
}

/// The process's time zone, as JavaScript's `Date` uses it: `$TZ` (a zone
/// name, `:path` or POSIX rule), else `/etc/localtime`, else UTC. Zone files
/// come from the system (`$TZDIR` first).
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
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Largest time a JavaScript `Date` holds, in ms either side of the epoch.
const DATE_RANGE_MS: i64 = 8_640_000_000_000_000;

/// "YYYY-MM-DD HH:MM" in local time (`localStamp` of the memory ledger).
pub fn local_stamp(ms: i64) -> String {
    if !(-DATE_RANGE_MS..=DATE_RANGE_MS).contains(&ms) {
        return "????-??-?? ??:??".to_owned();
    }
    let unix = ms.div_euclid(1000);
    let local = unix + offset_at(unix);
    let (year, month, day) = civil_from_days(local.div_euclid(86_400));
    let seconds = local.rem_euclid(86_400);
    format!(
        "{year}-{month:02}-{day:02} {:02}:{:02}",
        seconds / 3600,
        seconds % 3600 / 60
    )
}

static ISO: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
    regex_lite::Regex::new(
        r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$",
    )
    .expect("ISO date pattern")
});

/// `Date.parse` of an ISO date or date-time: a date alone is UTC, a time
/// without an offset local. `None` for anything else.
pub fn parse_date(text: &str) -> Option<i64> {
    let parts = ISO.captures(text)?;
    let number = |index: usize| -> Option<i64> {
        parts
            .get(index)
            .map_or(Some(0), |part| part.as_str().parse().ok())
    };
    let (year, month, day) = (number(1)?, number(2)?, number(3)?);
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
    if !(1..=12).contains(&month) || day < 1 || day > month_days[(month - 1) as usize] {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if parts.get(4).is_none() {
        return Some(days * 86_400_000);
    }
    let (hour, minute, second) = (number(4)?, number(5)?, number(6)?);
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let millis: i64 = parts.get(7).map_or(Some(0), |fraction| {
        let digits: String = fraction
            .as_str()
            .chars()
            .chain("00".chars())
            .take(3)
            .collect();
        digits.parse().ok()
    })?;
    let naive = days * 86_400 + hour * 3600 + minute * 60 + second;
    let unix = match parts.get(8).map(|zone| zone.as_str()) {
        Some("Z") => naive,
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let hours: i64 = offset[1..3].parse().ok()?;
            let minutes: i64 = offset[4..6].parse().ok()?;
            naive - sign * (hours * 3600 + minutes * 60)
        }
        // The earliest instant showing this local time; in a gap (clocks
        // moved forward), the offset before it.
        None => {
            let before = offset_at(naive - 86_400);
            let after = offset_at(naive + 86_400);
            [before, after]
                .into_iter()
                .map(|offset| naive - offset)
                .filter(|unix| naive - offset_at(*unix) == *unix)
                .min()
                .unwrap_or(naive - before)
        }
    };
    Some(unix * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_and_hashes() {
        assert_eq!(squash("  a \n\u{a0} b\t"), "a b");
        assert_eq!(squash(""), "");
        assert_eq!(
            words(" a  b\u{3000}c ").collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!(
            content_hash("Ｈas  TWO cats."),
            content_hash("has two cats.")
        );
        assert_ne!(content_hash("two cats"), content_hash("three cats"));
        assert_eq!(fold("ＡＢＣ"), "abc");
    }

    #[test]
    fn index_terms_pair_up_spaceless_scripts() {
        assert_eq!(index_terms("資料庫"), " 資料 料庫 庫 ");
        assert_eq!(index_terms("OM的Dropper"), "om 的 dropper");
        assert_eq!(index_terms("ＡＢＣ src/db.rs"), "abc src/db.rs");
        assert_eq!(
            index_terms("遷移：舊的"),
            " 遷移 移 : 舊的 的 ",
            "punctuation ends a run"
        );
        assert_eq!(index_terms("ひらがな"), " ひら らが がな な ");
        assert_eq!(index_terms("한국어"), " 한국 국어 어 ");
    }

    #[test]
    fn queries_are_quoted_phrases() {
        assert_eq!(
            match_query("資料庫遷移問題").unwrap(),
            r#""資料" OR "料庫" OR "庫遷" OR "遷移" OR "移問" OR "問題""#
        );
        assert_eq!(match_query("庫").unwrap(), r#""庫"*"#);
        assert_eq!(
            match_query("search_in HostProfile::worker").unwrap(),
            r#""search_in" OR "hostprofile::worker""#
        );
        assert_eq!(
            match_query(r#"a" OR NEAR(b) *"#).unwrap(),
            r#""a""" OR "or" OR "near(b)""#,
            "FTS5 syntax is quoted"
        );
        assert_eq!(
            match_query("dropper 事實層").unwrap(),
            r#""dropper" OR "事實" OR "實層""#
        );
        assert_eq!(match_query("？ ， !"), None);
        assert_eq!(match_query("a a A"), Some(r#""a""#.to_owned()));
        let long = "word ".repeat(10) + &(0..40).map(|n| format!("w{n} ")).collect::<String>();
        assert_eq!(
            match_query(&long).unwrap().matches(" OR ").count(),
            MAX_PHRASES - 1
        );
    }

    #[test]
    fn clipping_and_numbers() {
        assert_eq!(clip("abcdef", 6), "abcdef");
        assert_eq!(clip("abc defg", 5), "abc…");
        assert_eq!(grouped(8000), "8,000");
        assert_eq!(grouped(123), "123");
        assert_eq!(grouped(1_234_567), "1,234,567");
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("2026-09-27"), Some(1_790_467_200_000));
        assert_eq!(parse_date("2026-09-27T10:00Z"), Some(1_790_503_200_000));
        assert_eq!(
            parse_date("2026-09-27T12:00+02:00"),
            Some(1_790_503_200_000)
        );
        assert_eq!(parse_date("2026-13-27T10:00"), None);
        assert_eq!(parse_date("yesterday"), None);
        assert!(parse_date("2026-09-27T10:00").is_some());
        assert_eq!(parse_date("2026-02-29"), None);
        assert_eq!(parse_date("2024-02-29"), Some(1_709_164_800_000));
        assert_eq!(parse_date("1969-12-31T23:59:59.5Z"), Some(-500));
        assert_eq!(local_stamp(0).len(), 16);
        assert_eq!(local_stamp(i64::MAX), "????-??-?? ??:??");
    }
}
