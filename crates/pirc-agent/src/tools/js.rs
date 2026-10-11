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

/// `String(value)` of a JSON value (as a JS value).
pub fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => string_of(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
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
    /// `new RegExp(source, flags)`; `Err` is the `SyntaxError` message.
    pub fn new(source: &str, flags: &str) -> Result<Self, String> {
        let invalid = || "Invalid flags supplied to RegExp constructor.".to_owned();
        let mut canonical = String::new();
        for flag in "dgimsuvy".chars() {
            match flags.chars().filter(|c| *c == flag).count() {
                0 => {}
                1 => canonical.push(flag),
                _ => return Err(invalid()),
            }
        }
        if flags.chars().any(|c| !"dgimsuvy".contains(c))
            || (canonical.contains('u') && canonical.contains('v'))
        {
            return Err(invalid());
        }
        let engine: String = canonical.chars().filter(|c| "imsuv".contains(*c)).collect();
        let regex = regress::Regex::with_flags(source, engine.as_str())
            .map_err(|error| syntax_error(source, &error.text))?;
        Ok(Self {
            regex,
            source: source.to_owned(),
            flags: canonical.clone(),
            sticky: canonical.contains('y'),
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

/// `String(regex)`: `/source/flags`, with `/` and line breaks escaped.
impl fmt::Display for JsRegex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut source = String::new();
        let mut escaped = false;
        let mut in_class = false;
        for c in self.source.chars() {
            match c {
                '\n' => source.push_str("\\n"),
                '\r' => source.push_str("\\r"),
                '\u{2028}' => source.push_str("\\u2028"),
                '\u{2029}' => source.push_str("\\u2029"),
                '/' if !escaped && !in_class => source.push_str("\\/"),
                _ => source.push(c),
            }
            if !escaped {
                if c == '[' {
                    in_class = true;
                } else if c == ']' {
                    in_class = false;
                }
            }
            escaped = !escaped && c == '\\';
        }
        if source.is_empty() {
            source.push_str("(?:)");
        }
        write!(f, "/{source}/{}", self.flags)
    }
}

/// The `SyntaxError` text JavaScriptCore gives for the common mistakes.
fn syntax_error(source: &str, engine: &str) -> String {
    let text = match engine {
        "Unbalanced parenthesis" => {
            let mut depth = 0i32;
            let mut escaped = false;
            let mut in_class = false;
            let mut unmatched = false;
            for c in source.chars() {
                if escaped {
                    escaped = false;
                    continue;
                }
                match c {
                    '\\' => escaped = true,
                    '[' => in_class = true,
                    ']' => in_class = false,
                    '(' if !in_class => depth += 1,
                    ')' if !in_class => {
                        depth -= 1;
                        if depth < 0 {
                            unmatched = true;
                        }
                    }
                    _ => {}
                }
            }
            if unmatched {
                "unmatched parentheses".to_owned()
            } else {
                "missing )".to_owned()
            }
        }
        "Unbalanced bracket" => "missing terminating ] for character class".to_owned(),
        "Incomplete escape" => "\\ at end of pattern".to_owned(),
        "Invalid character range" => "range out of order in character class".to_owned(),
        "Invalid braced quantifier" => "numbers out of order in {} quantifier".to_owned(),
        "Quantifier not allowed here" | "Invalid quantifier" | "Invalid atom character" => {
            "nothing to repeat".to_owned()
        }
        "Invalid named backreference syntax" => "invalid \\k<> named backreference".to_owned(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_lowercase().chain(chars).collect(),
                None => String::new(),
            }
        }
    };
    format!("Invalid regular expression: {text}")
}

/// A compiled pattern from the source, for fixed patterns ported from TS.
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
// Node/Bun error texts

/// The `code: description` libuv (and Bun) give an errno.
fn errno_text(code: i32) -> Option<(&'static str, &'static str)> {
    use nix::errno::Errno;
    let errno = Errno::from_raw(code);
    Some(match errno {
        Errno::EPERM => ("EPERM", "operation not permitted"),
        Errno::ENOENT => ("ENOENT", "no such file or directory"),
        Errno::ESRCH => ("ESRCH", "no such process"),
        Errno::EINTR => ("EINTR", "interrupted system call"),
        Errno::EIO => ("EIO", "i/o error"),
        Errno::ENXIO => ("ENXIO", "no such device or address"),
        Errno::E2BIG => ("E2BIG", "argument list too long"),
        Errno::ENOEXEC => ("ENOEXEC", "exec format error"),
        Errno::EBADF => ("EBADF", "bad file descriptor"),
        Errno::EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        Errno::ENOMEM => ("ENOMEM", "not enough memory"),
        Errno::EACCES => ("EACCES", "permission denied"),
        Errno::EFAULT => ("EFAULT", "bad address in system call argument"),
        Errno::EBUSY => ("EBUSY", "resource busy or locked"),
        Errno::EEXIST => ("EEXIST", "file already exists"),
        Errno::EXDEV => ("EXDEV", "cross-device link not permitted"),
        Errno::ENODEV => ("ENODEV", "no such device"),
        Errno::ENOTDIR => ("ENOTDIR", "not a directory"),
        Errno::EISDIR => ("EISDIR", "illegal operation on a directory"),
        Errno::EINVAL => ("EINVAL", "invalid argument"),
        Errno::ENFILE => ("ENFILE", "file table overflow"),
        Errno::EMFILE => ("EMFILE", "too many open files"),
        Errno::ENOTTY => ("ENOTTY", "inappropriate ioctl for device"),
        Errno::ETXTBSY => ("ETXTBSY", "text file is busy"),
        Errno::EFBIG => ("EFBIG", "file too large"),
        Errno::ENOSPC => ("ENOSPC", "no space left on device"),
        Errno::ESPIPE => ("ESPIPE", "invalid seek"),
        Errno::EROFS => ("EROFS", "read-only file system"),
        Errno::EMLINK => ("EMLINK", "too many links"),
        Errno::EPIPE => ("EPIPE", "broken pipe"),
        Errno::ERANGE => ("ERANGE", "result too large"),
        Errno::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        Errno::ENOSYS => ("ENOSYS", "function not implemented"),
        Errno::ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        Errno::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        Errno::EOVERFLOW => ("EOVERFLOW", "value too large for defined data type"),
        Errno::EILSEQ => ("EILSEQ", "illegal byte sequence"),
        Errno::ECANCELED => ("ECANCELED", "operation canceled"),
        _ => return None,
    })
}

/// A failed `fs` call as Node/Bun word it: `ENOENT: no such file or
/// directory, stat '/x'` (no path for `read`).
pub fn fs_error(error: &std::io::Error, syscall: &str, path: Option<&str>) -> String {
    let Some((code, description)) = error.raw_os_error().and_then(errno_text) else {
        return error.to_string();
    };
    match path {
        Some(path) => format!("{code}: {description}, {syscall} '{path}'"),
        None => format!("{code}: {description}, {syscall}"),
    }
}

// ---------------------------------------------------------------------------
// localeCompare (ICU root collation, simplified)

/// Collation elements of one character: (primary, secondary, tertiary).
fn elements(c: char, out: &mut Vec<(u32, u8, u8)>) {
    const PUNCTUATION: &str = "\t\n\u{0B}\u{0C}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if let Some(index) = PUNCTUATION.find(c) {
        out.push((1 + index as u32, 0, 0));
        return;
    }
    if c.is_ascii_digit() {
        out.push((100 + (c as u32 - '0' as u32), 0, 0));
        return;
    }
    if c.is_ascii_alphabetic() {
        let lower = c.to_ascii_lowercase();
        out.push((
            200 + (lower as u32 - 'a' as u32),
            0,
            u8::from(c.is_ascii_uppercase()),
        ));
        return;
    }
    // Latin-1 letters: base letter, accent (secondary), case (tertiary).
    let (base, accent, upper): (&str, u8, bool) = match c {
        'á' | 'Á' => ("a", 1, c == 'Á'),
        'à' | 'À' => ("a", 2, c == 'À'),
        'â' | 'Â' => ("a", 3, c == 'Â'),
        'å' | 'Å' => ("a", 4, c == 'Å'),
        'ä' | 'Ä' => ("a", 5, c == 'Ä'),
        'ã' | 'Ã' => ("a", 6, c == 'Ã'),
        'æ' | 'Æ' => ("ae", 0, c == 'Æ'),
        'ç' | 'Ç' => ("c", 7, c == 'Ç'),
        'é' | 'É' => ("e", 1, c == 'É'),
        'è' | 'È' => ("e", 2, c == 'È'),
        'ê' | 'Ê' => ("e", 3, c == 'Ê'),
        'ë' | 'Ë' => ("e", 5, c == 'Ë'),
        'í' | 'Í' => ("i", 1, c == 'Í'),
        'ì' | 'Ì' => ("i", 2, c == 'Ì'),
        'î' | 'Î' => ("i", 3, c == 'Î'),
        'ï' | 'Ï' => ("i", 5, c == 'Ï'),
        'ñ' | 'Ñ' => ("n", 6, c == 'Ñ'),
        'ó' | 'Ó' => ("o", 1, c == 'Ó'),
        'ò' | 'Ò' => ("o", 2, c == 'Ò'),
        'ô' | 'Ô' => ("o", 3, c == 'Ô'),
        'ö' | 'Ö' => ("o", 5, c == 'Ö'),
        'õ' | 'Õ' => ("o", 6, c == 'Õ'),
        'ø' | 'Ø' => ("o", 8, c == 'Ø'),
        'ú' | 'Ú' => ("u", 1, c == 'Ú'),
        'ù' | 'Ù' => ("u", 2, c == 'Ù'),
        'û' | 'Û' => ("u", 3, c == 'Û'),
        'ü' | 'Ü' => ("u", 5, c == 'Ü'),
        'ý' | 'Ý' => ("y", 1, c == 'Ý'),
        'ÿ' => ("y", 5, false),
        'ß' => ("ss", 0, false),
        _ => {
            out.push((1000 + c as u32, 0, 0));
            return;
        }
    };
    // Ligatures (æ, ß) sort right after their letters (ae, ss).
    let ligature = u8::from(base.len() > 1);
    for (index, letter) in base.chars().enumerate() {
        let primary = 200 + (letter as u32 - 'a' as u32);
        let secondary = if index == 0 { accent } else { 0 };
        out.push((primary, secondary, ligature + 2 * u8::from(upper)));
    }
}

/// `a.localeCompare(b)`: ICU root collation for ASCII and Latin-1 names
/// (punctuation, then digits, then letters; accents, then case, break ties).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let keys = |s: &str| {
        let mut out = Vec::new();
        for c in s.chars() {
            elements(c, &mut out);
        }
        out
    };
    let (ka, kb) = (keys(a), keys(b));
    let primary = |k: &[(u32, u8, u8)]| k.iter().map(|e| e.0).collect::<Vec<_>>();
    let secondary = |k: &[(u32, u8, u8)]| k.iter().map(|e| e.1).collect::<Vec<_>>();
    let tertiary = |k: &[(u32, u8, u8)]| k.iter().map(|e| e.2).collect::<Vec<_>>();
    primary(&ka)
        .cmp(&primary(&kb))
        .then_with(|| secondary(&ka).cmp(&secondary(&kb)))
        .then_with(|| tertiary(&ka).cmp(&tertiary(&kb)))
        .then_with(|| a.cmp(b))
}

/// The default `Array.prototype.sort` order: UTF-16 code units.
pub fn compare16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
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
        assert_eq!(
            JsRegex::new("(", "i").unwrap_err(),
            "Invalid regular expression: missing )"
        );
        assert_eq!(
            JsRegex::new("[a", "").unwrap_err(),
            "Invalid regular expression: missing terminating ] for character class"
        );
        assert_eq!(
            JsRegex::new("*a", "").unwrap_err(),
            "Invalid regular expression: nothing to repeat"
        );
        assert_eq!(
            JsRegex::new("a", "gg").unwrap_err(),
            "Invalid flags supplied to RegExp constructor."
        );
        assert_eq!(JsRegex::new("a", "yi").unwrap().to_string(), "/a/iy");
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
    fn sorts_like_icu_root() {
        let mut names = vec![
            "b",
            "B",
            "a",
            "A",
            "_x",
            "-x",
            ".x",
            "1",
            "10",
            "2",
            "a_b",
            "a-b",
            "ab",
            "aB",
            "Ab",
            "a.b",
            "a b",
            "é",
            "e",
            "f",
            "z",
            "Z",
            "~x",
            "#x",
            "a1",
            "a_1",
            "README.md",
            "src",
            "node_modules",
            ".git",
            "_",
            "-",
            "..",
            ".",
            "ä",
            "Ä",
            "resume",
            "résumé",
            "x2",
            "X1",
            "0",
        ];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            names,
            vec![
                "_",
                "_x",
                "-",
                "-x",
                ".",
                "..",
                ".git",
                ".x",
                "#x",
                "~x",
                "0",
                "1",
                "10",
                "2",
                "a",
                "A",
                "ä",
                "Ä",
                "a b",
                "a_1",
                "a_b",
                "a-b",
                "a.b",
                "a1",
                "ab",
                "aB",
                "Ab",
                "b",
                "B",
                "e",
                "é",
                "f",
                "node_modules",
                "README.md",
                "resume",
                "résumé",
                "src",
                "X1",
                "x2",
                "z",
                "Z",
            ]
        );
    }

    #[test]
    fn errors_read_like_bun() {
        let error = std::io::Error::from_raw_os_error(2);
        assert_eq!(
            fs_error(&error, "stat", Some("/x")),
            "ENOENT: no such file or directory, stat '/x'"
        );
        let error = std::io::Error::from_raw_os_error(21);
        assert_eq!(
            fs_error(&error, "read", None),
            "EISDIR: illegal operation on a directory, read"
        );
    }
}
