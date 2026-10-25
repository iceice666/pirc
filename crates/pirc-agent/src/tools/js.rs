//! What the TS code got from JavaScript itself and the tools' outputs
//! depend on: UTF-16 string lengths and slices, `String.prototype.trim`,
//! ECMAScript regular expressions, Node's `path` helpers, Node/Bun error
//! texts and `localeCompare` (ICU root collation).

use std::cmp::Ordering;
use std::fmt;

use serde_json::Value;

// ---------------------------------------------------------------------------
// Strings

/// `s.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Byte offset of the first `units` UTF-16 code units (a split surrogate
/// pair stays whole on the side it started).
fn byte_at_unit(s: &str, units: usize) -> usize {
    let mut count = 0;
    for (index, c) in s.char_indices() {
        if count >= units {
            return index;
        }
        count += c.len_utf16();
    }
    s.len()
}

/// `s.slice(0, n)` in UTF-16 code units.
pub fn head16(s: &str, units: usize) -> &str {
    &s[..byte_at_unit(s, units)]
}

/// `s.slice(-n)` in UTF-16 code units.
pub fn tail16(s: &str, units: usize) -> &str {
    let total = len16(s);
    if units >= total {
        return s;
    }
    &s[byte_at_unit(s, total - units)..]
}

/// JavaScript's `\s` (WhiteSpace and LineTerminator).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.trimEnd()`.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// Whether a JSON value is truthy (`!!value`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A JSON value as text: strings as they are, scalars as JavaScript
/// prints them, arrays and objects as JSON.
pub fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => stringify(value),
    }
}

/// What an absent field shows as in text meant for the model.
pub const MISSING: &str = "(missing)";

/// [`string_of`] of an optional field, [`MISSING`] when absent.
pub fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| MISSING.to_owned(), string_of)
}

/// A number as JavaScript prints it (integers without a fraction).
pub fn number_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    float_text(f)
}

/// `String(f)`.
pub fn float_text(f: f64) -> String {
    crate::messages::js::number_text(f)
}

/// `JSON.stringify(value)`, numbers formatted as JavaScript does.
pub fn stringify(value: &Value) -> String {
    crate::messages::js::stringify(value)
}

// ---------------------------------------------------------------------------
// Regular expressions

/// A JavaScript `RegExp` (`new RegExp(source, flags)`), for `test`.
pub struct JsRegex {
    regex: regress::Regex,
    source: String,
    flags: String,
    sticky: bool,
}

impl fmt::Debug for JsRegex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}

impl JsRegex {
    /// A JavaScript regular expression with its flags (`dgimsuvy`, each at
    /// most once); `Err` says what is wrong with it.
    pub fn new(source: &str, flags: &str) -> Result<Self, String> {
        let mut seen = String::new();
        for flag in flags.chars() {
            if !"dgimsuvy".contains(flag) || seen.contains(flag) {
                return Err(format!("Invalid regular expression flags: {flags}"));
            }
            seen.push(flag);
        }
        if seen.contains('u') && seen.contains('v') {
            return Err(format!("Invalid regular expression flags: {flags}"));
        }
        let engine: String = seen.chars().filter(|c| "imsuv".contains(*c)).collect();
        let regex = regress::Regex::with_flags(source, engine.as_str())
            .map_err(|error| format!("Invalid regular expression: {}", error.text))?;
        Ok(Self {
            regex,
            source: source.to_owned(),
            sticky: seen.contains('y'),
            flags: seen,
        })
    }

    /// `regex.test(text)` from `lastIndex` 0.
    pub fn test(&self, text: &str) -> bool {
        match self.regex.find(text) {
            Some(found) => !self.sticky || found.start() == 0,
            None => false,
        }
    }

    /// Non-overlapping matches (`matchAll` of a global regex).
    pub fn find_iter<'r, 't>(
        &'r self,
        text: &'t str,
    ) -> impl Iterator<Item = regress::Match> + use<'r, 't> {
        self.regex.find_iter(text)
    }

    /// `text.replace(globalRegex, replacement)` with a literal replacement.
    pub fn replace_all(&self, text: &str, replacement: &str) -> String {
        let mut out = String::new();
        let mut last = 0;
        for found in self.regex.find_iter(text) {
            out.push_str(&text[last..found.start()]);
            out.push_str(replacement);
            last = found.end();
        }
        out.push_str(&text[last..]);
        out
    }

    /// The capture groups of the first match.
    pub fn captures(&self, text: &str) -> Option<regress::Match> {
        self.regex.find(text)
    }
}

/// `/source/flags`, with an unescaped `/` in the source escaped.
impl fmt::Display for JsRegex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut source = String::new();
        let mut escaped = false;
        for c in self.source.chars() {
            match c {
                '\n' => source.push_str("\\n"),
                '/' if !escaped => source.push_str("\\/"),
                _ => source.push(c),
            }
            escaped = !escaped && c == '\\';
        }
        if source.is_empty() {
            source.push_str("(?:)");
        }
        write!(f, "/{source}/{}", self.flags)
    }
}

/// A compiled fixed pattern.
macro_rules! js_regex {
    ($source:literal) => {
        $crate::tools::js::js_regex!($source, "")
    };
    ($source:literal, $flags:literal) => {{
        static REGEX: std::sync::LazyLock<$crate::tools::js::JsRegex> =
            std::sync::LazyLock::new(|| {
                $crate::tools::js::JsRegex::new($source, $flags).expect("a valid regex")
            });
        &*REGEX
    }};
}
pub(crate) use js_regex;

// ---------------------------------------------------------------------------
// Paths (POSIX `path`)

/// `path.basename(p)`.
pub fn basename(p: &str) -> &str {
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    match trimmed.rfind('/') {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    }
}

/// `path.dirname(p)`.
pub fn dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".to_owned();
    }
    let absolute = p.starts_with('/');
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_owned();
    }
    match trimmed.rfind('/') {
        None => ".".to_owned(),
        Some(index) => {
            let dir = trimmed[..index].trim_end_matches('/');
            if dir.is_empty() {
                if absolute {
                    "/".to_owned()
                } else {
                    ".".to_owned()
                }
            } else {
                dir.to_owned()
            }
        }
    }
}

/// `path.extname(p)`.
pub fn extname(p: &str) -> &str {
    let base = basename(p);
    match base.rfind('.') {
        Some(0) | None => "",
        Some(index) if index == base.len() - 1 && base[..index].chars().all(|c| c == '.') => "",
        Some(index) => &base[index..],
    }
}

/// `path.join(a, b)` for an absolute or relative `a`.
pub fn join(a: &str, b: &str) -> String {
    let joined = if a.is_empty() {
        b.to_owned()
    } else if b.is_empty() {
        a.to_owned()
    } else {
        format!("{a}/{b}")
    };
    normalize(&joined)
}

/// `path.normalize(p)`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".to_owned();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let mut out = parts.join("/");
    if absolute {
        out.insert(0, '/');
    }
    if out.is_empty() {
        return ".".to_owned();
    }
    if trailing && out != "/" {
        out.push('/');
    }
    out
}

/// `path.relative(from, to)` for absolute, normalized paths.
pub fn relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|part| !part.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

// ---------------------------------------------------------------------------
// Error texts

/// A failed file system call as text: `stat '/x': No such file or
/// directory (os error 2)` (no path for `read`).
pub fn fs_error(error: &std::io::Error, syscall: &str, path: Option<&str>) -> String {
    crate::messages::js::node_error(error, syscall, path.map(std::path::Path::new))
}

// ---------------------------------------------------------------------------
// Ordering

/// The order names are listed in: case-insensitively by code point, a
/// lowercase name before its uppercase twin.
pub fn name_order(a: &str, b: &str) -> Ordering {
    a.chars()
        .flat_map(char::to_lowercase)
        .cmp(b.chars().flat_map(char::to_lowercase))
        .then_with(|| b.cmp(a))
}

// ---------------------------------------------------------------------------
// Dates and numbers

/// `new Date(ms).toISOString()`; `None` where it throws (an invalid date:
/// not finite, or more than 8.64e15 ms from the epoch).
pub fn iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    // TimeClip: toward zero.
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

/// `n.toLocaleString('en-US')`: grouped thousands, at most three
/// fraction digits.
pub fn locale_string_en_us(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "∞" } else { "-∞" }.to_owned();
    }
    let text = format!("{:.3}", n.abs());
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let fraction = fraction.trim_end_matches('0');
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    // Intl keeps the sign of -0 and of what rounds to it.
    let sign = if n.is_sign_negative() { "-" } else { "" };
    if fraction.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_dates_and_numbers_as_javascript() {
        assert_eq!(iso_string(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(
            iso_string(1_767_830_400_123.9).as_deref(),
            Some("2026-01-08T00:00:00.123Z")
        );
        assert_eq!(
            iso_string(-1.0).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            iso_string(8.64e15).as_deref(),
            Some("+275760-09-13T00:00:00.000Z")
        );
        assert_eq!(
            iso_string(-62_198_755_200_000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(iso_string(8.64e15 + 1.0), None);
        assert_eq!(iso_string(f64::NAN), None);
        assert_eq!(locale_string_en_us(1_234_567.0), "1,234,567");
        assert_eq!(locale_string_en_us(100.0), "100");
        assert_eq!(locale_string_en_us(0.0), "0");
        assert_eq!(locale_string_en_us(-1234.5), "-1,234.5");
        assert_eq!(locale_string_en_us(1.23456), "1.235");
        assert_eq!(locale_string_en_us(f64::NAN), "NaN");
    }

    #[test]
    fn strings_count_utf16_units() {
        assert_eq!(len16("a😀b"), 4);
        assert_eq!(head16("a😀b", 3), "a😀");
        assert_eq!(head16("abc", 10), "abc");
        assert_eq!(tail16("abcdef", 2), "ef");
        assert_eq!(trim("\u{FEFF} x \n"), "x");
    }

    #[test]
    fn regexes_behave_like_javascript() {
        let regex = JsRegex::new("just\\s+switch", "").unwrap();
        assert!(regex.test("echo; just  switch"));
        assert_eq!(regex.to_string(), "/just\\s+switch/");
        assert_eq!(JsRegex::new("a/b", "gi").unwrap().to_string(), "/a\\/b/gi");
        assert!(JsRegex::new("(?<=a)b", "").unwrap().test("ab"));
        assert!(JsRegex::new("x", "y").unwrap().test("xa"));
        assert!(!JsRegex::new("x", "y").unwrap().test("ax"));
        assert!(
            JsRegex::new("(", "i")
                .unwrap_err()
                .starts_with("Invalid regular expression: ")
        );
        assert_eq!(
            JsRegex::new("a", "gg").unwrap_err(),
            "Invalid regular expression flags: gg"
        );
        assert_eq!(
            JsRegex::new("a", "x").unwrap_err(),
            "Invalid regular expression flags: x"
        );
        assert_eq!(JsRegex::new("a", "yi").unwrap().to_string(), "/a/yi");
    }

    #[test]
    fn paths_follow_node() {
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(extname("/x/a.PNG"), ".PNG");
        assert_eq!(extname(".png"), "");
        assert_eq!(extname("a."), ".");
        assert_eq!(join("/a/b", "../c"), "/a/c");
        assert_eq!(relative("/a/b", "/a/b/c/d"), "c/d");
        assert_eq!(relative("/a/b", "/a/c"), "../c");
        assert_eq!(relative("/a", "/a"), "");
        assert_eq!(relative("/", "/x/y"), "x/y");
    }

    #[test]
    fn orders_names_case_insensitively() {
        let mut names = vec![
            "b",
            "B",
            "a",
            "A",
            "README.md",
            "src",
            ".git",
            "_x",
            "node_modules",
            "é",
            "e",
        ];
        names.sort_by(|a, b| name_order(a, b));
        assert_eq!(
            names,
            vec![
                ".git",
                "_x",
                "a",
                "A",
                "b",
                "B",
                "e",
                "node_modules",
                "README.md",
                "src",
                "é"
            ]
        );
    }

    #[test]
    fn errors_name_the_call_and_path() {
        let error = std::io::Error::from_raw_os_error(2);
        assert_eq!(
            fs_error(&error, "stat", Some("/x")),
            format!("stat '/x': {error}")
        );
        assert_eq!(fs_error(&error, "read", None), format!("read: {error}"));
    }
}
