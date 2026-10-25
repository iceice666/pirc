//! Text helpers the tools and features share: UTF-16 lengths and cuts
//! (re-exported from `pirc_config::text`), ECMAScript regular expressions
//! for user-written patterns, POSIX path helpers, error texts and ordering.

use std::cmp::Ordering;
use std::fmt;

use serde_json::Value;

// ---------------------------------------------------------------------------
// Strings (one implementation, in pirc_config::text)

pub use pirc_config::text::{
    is_space, trim, trim_end, truthy, utf16_head as head16, utf16_len as len16,
    utf16_tail as tail16, value_text as string_of,
};

/// What an absent field shows as in text meant for the model.
pub const MISSING: &str = "(missing)";

/// [`string_of`] of an optional field, [`MISSING`] when absent.
pub fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| MISSING.to_owned(), string_of)
}

/// A number as JavaScript prints it (integers without a fraction).
pub fn number_text(n: &serde_json::Number) -> String {
    string_of(&Value::Number(n.clone()))
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
// Numbers for people

/// A number with grouped thousands and at most three fraction digits
/// (`1,234,567`, `-1,234.5`).
pub fn grouped(n: f64) -> String {
    if !n.is_finite() {
        return n.to_string();
    }
    let text = format!("{:.3}", n.abs());
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let fraction = fraction.trim_end_matches('0');
    let mut out = String::new();
    if n.is_sign_negative() && text.bytes().any(|b| (b'1'..=b'9').contains(&b)) {
        out.push('-');
    }
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_thousands() {
        assert_eq!(grouped(1_234_567.0), "1,234,567");
        assert_eq!(grouped(100.0), "100");
        assert_eq!(grouped(0.0), "0");
        assert_eq!(grouped(-0.0), "0");
        assert_eq!(grouped(-1234.5), "-1,234.5");
        assert_eq!(grouped(1.23456), "1.235");
        assert_eq!(grouped(f64::NAN), "NaN");
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
