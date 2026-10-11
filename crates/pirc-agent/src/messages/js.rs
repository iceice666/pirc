//! JavaScript semantics the agent's observable output depends on: string
//! lengths in UTF-16 code units, `String.prototype.trim`, `Number#toString`
//! and `JSON.stringify` (whose number formatting differs from serde_json's).

use serde_json::Value;

/// `string.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `string.slice(0, units)`. A cut through a surrogate pair keeps U+FFFD in
/// place of the lone high surrogate JS would keep.
pub fn utf16_prefix(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let width = c.len_utf16();
        if used + width > units {
            if used < units {
                out.push('\u{fffd}');
            }
            break;
        }
        used += width;
        out.push(c);
    }
    out
}

/// JavaScript's white space and line terminators (`\s`, `trim`).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `String.prototype.trimStart`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

/// `String.prototype.trimEnd`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// `Number.prototype.toString()` (`String(number)`).
pub fn number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Shortest round-trip digits and the decimal exponent.
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// A number as JavaScript holds it, for JSON values: integral values within
/// the safe range as integers (so serde_json writes `2`, not `2.0`).
pub fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        if value == 0.0 {
            return Value::from(0);
        }
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => match (number.as_i64(), number.as_u64()) {
            (Some(int), _) if int.unsigned_abs() <= 9_007_199_254_740_991 => {
                out.push_str(&int.to_string());
            }
            _ => out.push_str(&number_text(number.as_f64().unwrap_or(0.0))),
        },
        Value::String(text) => out.push_str(&string_literal(text)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&string_literal(key));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(string)` (serde_json escapes exactly what JS does).
pub fn string_literal(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// Node's text for a failed file system call: `ENOENT: no such file or
/// directory, open '/x'` (without the path for `read`-style calls).
pub fn node_error(error: &std::io::Error, syscall: &str, path: Option<&std::path::Path>) -> String {
    let (code, description) = match error.raw_os_error() {
        Some(1) => ("EPERM", "operation not permitted"),
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(16) => ("EBUSY", "resource busy or locked"),
        Some(17) => ("EEXIST", "file already exists"),
        Some(18) => ("EXDEV", "cross-device link not permitted"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(21) => ("EISDIR", "illegal operation on a directory"),
        Some(24) => ("EMFILE", "too many open files"),
        Some(28) => ("ENOSPC", "no space left on device"),
        Some(30) => ("EROFS", "read-only file system"),
        Some(36) => ("ENAMETOOLONG", "name too long"),
        Some(40) => ("ELOOP", "too many symbolic links encountered"),
        _ => return format!("{error}, {syscall}"),
    };
    match path {
        Some(path) => format!("{code}: {description}, {syscall} '{}'", path.display()),
        None => format!("{code}: {description}, {syscall}"),
    }
}

/// `readFileSync(file, 'utf8')` with Node's error text.
pub fn read_text(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) if error.raw_os_error() == Some(21) => Err(node_error(&error, "read", None)),
        Err(error) => Err(node_error(&error, "open", Some(path))),
    }
}

/// `path.normalize` (POSIX): `.` and empty parts dropped, `..` resolved
/// (kept at the start of a relative path), a trailing slash kept.
pub fn path_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() && !absolute {
        out.push('.');
    }
    if trailing && !out.is_empty() {
        out.push('/');
    }
    if absolute {
        out.insert(0, '/');
    }
    out
}

/// `path.join(...parts)` (POSIX).
pub fn path_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".to_owned();
    }
    path_normalize(&joined)
}

/// `path.resolve(...parts)` (POSIX) against the process's working directory.
pub fn path_resolve(parts: &[&str]) -> String {
    let mut resolved = String::new();
    for part in parts.iter().rev() {
        if part.is_empty() {
            continue;
        }
        resolved = if resolved.is_empty() {
            (*part).to_owned()
        } else {
            format!("{part}/{resolved}")
        };
        if part.starts_with('/') {
            break;
        }
    }
    if !resolved.starts_with('/') {
        let cwd = std::env::current_dir()
            .map(|dir| dir.display().to_string())
            .unwrap_or_else(|_| "/".to_owned());
        resolved = if resolved.is_empty() {
            cwd
        } else {
            format!("{cwd}/{resolved}")
        };
    }
    let normalized = path_normalize(&resolved);
    if normalized.len() > 1 && normalized.ends_with('/') {
        normalized[..normalized.len() - 1].to_owned()
    } else {
        normalized
    }
}

/// `os.homedir()`: `$HOME` of this process.
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_owned())
}

/// `readdirSync(dir).sort()`: names in UTF-16 code unit order.
pub fn sorted_dir_names(dir: &std::path::Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|a, b| compare_utf16(a, b));
    Ok(names)
}

/// `a < b` for JavaScript strings: UTF-16 code unit order.
pub fn compare_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_numbers_like_javascript() {
        for (value, text) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.5, "0.5"),
            (1.5e-7, "1.5e-7"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1e21, "1e+21"),
            (1.2345e22, "1.2345e+22"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.1 + 0.2, "0.30000000000000004"),
            (-42.25, "-42.25"),
            (f64::INFINITY, "Infinity"),
            (f64::NAN, "NaN"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(number_text(value), text, "{value}");
        }
    }

    #[test]
    fn stringifies_like_json_stringify() {
        let value = json!({"a": 1.0, "b": [0.5, 1e21, "x\n\u{1f}\"", null, true], "c": {}});
        assert_eq!(
            stringify(&value),
            r#"{"a":1,"b":[0.5,1e+21,"x\n\u001f\"",null,true],"c":{}}"#
        );
        assert_eq!(
            stringify(&json!(18446744073709551615u64)),
            "18446744073709552000"
        );
    }

    #[test]
    fn handles_paths_like_node() {
        assert_eq!(path_join(&["/a/", "b"]), "/a/b");
        assert_eq!(path_join(&["/a", "../b", ""]), "/b");
        assert_eq!(path_join(&["a", "..", "..", "c/"]), "../c/");
        assert_eq!(path_join(&["", ""]), ".");
        assert_eq!(path_join(&["/", ".."]), "/");
        assert_eq!(path_resolve(&["/x", "y/", "../z"]), "/x/z");
        assert_eq!(path_resolve(&["/x", "/abs/"]), "/abs");
        assert_eq!(path_resolve(&["/"]), "/");
    }

    #[test]
    fn measures_and_trims_like_javascript() {
        assert_eq!(utf16_len("a😀é"), 4);
        assert_eq!(utf16_prefix("a😀b", 2), "a\u{fffd}");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        assert_eq!(trim("\u{feff} x \u{a0}\n"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
        assert_eq!(compare_utf16("\u{ffff}", "😀"), std::cmp::Ordering::Greater);
    }
}
