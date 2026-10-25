//! `node/browser.ts`'s pure helpers: `checkUrl`, `maskPasswords`, clipping
//! in UTF-16 code units, `cleanError`, the action descriptions, and
//! argument coercion.

use pirc_agent::tools::js::string_of;
use serde_json::Value;

use crate::chat::js_trim;
use crate::error::{ApiError, ApiResult};

/// What a password's value becomes in a snapshot.
pub const MASK: &str = "••••••";

pub use pirc_config::text::utf16_len;

/// `args[name]`: `undefined` unless `args` is an object (the runner passes
/// arrays through as TS did; their named properties are all `undefined`).
pub fn arg<'a>(args: &'a Value, name: &str) -> Option<&'a Value> {
    args.as_object().and_then(|args| args.get(name))
}

/// An argument as text, `(missing)` for an absent one.
pub fn js_string(value: Option<&Value>) -> String {
    pirc_agent::tools::js::shown(value)
}

/// `String(value ?? '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_of(value),
    }
}

/// `str(value, name, max)`: a non-empty string of at most `max` UTF-16 code
/// units (whitespace counts).
pub fn str_arg<'a>(value: Option<&'a Value>, name: &str, max: usize) -> ApiResult<&'a str> {
    match value {
        Some(Value::String(text)) if !text.is_empty() && utf16_len(text) <= max => Ok(text),
        _ => Err(ApiError::bad_request(format!(
            "{name} must be a non-empty string"
        ))),
    }
}

/// `ref(value)`: a snapshot reference such as `e12` or `f1e3`.
pub fn ref_arg(value: Option<&Value>) -> ApiResult<&str> {
    let text = str_arg(value, "ref", 40)?;
    if !text.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(ApiError::bad_request("ref must come from browser_snapshot"));
    }
    Ok(text)
}

/// `int(value, fallback, min, max)`: a finite number floored and clamped,
/// else `fallback`.
pub fn int_arg(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() => number.floor().clamp(min as f64, max as f64) as i64,
        _ => fallback,
    }
}

/// `typeof value === 'number' && Number.isFinite(value) ? value : 0` (the
/// viewer's input numbers, neither floored nor clamped).
pub fn num_arg(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

/// `/^[a-z][a-z0-9+.-]*:/i`.
fn has_scheme(text: &str) -> bool {
    let mut bytes = text.bytes();
    if !bytes.next().is_some_and(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    for b in bytes {
        match b {
            b':' => return true,
            b if b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-' => {}
            _ => return false,
        }
    }
    false
}

/// `checkUrl`: only web pages (`file://` would bypass the agent's path
/// guard); a bare host gets `https://`; the canonical `href`.
pub fn check_url(raw: Option<&Value>) -> ApiResult<String> {
    let invalid = || ApiError::bad_request("url must be a non-empty string");
    let Some(Value::String(raw)) = raw else {
        return Err(invalid());
    };
    let trimmed = js_trim(raw);
    if trimmed.is_empty() || utf16_len(raw) > 8192 {
        return Err(invalid());
    }
    let candidate = if has_scheme(trimmed) {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&candidate)
        .map_err(|_| ApiError::bad_request(format!("Not a URL: {raw}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ApiError::bad_request(
            "Only http and https URLs can be opened",
        ));
    }
    Ok(url.into())
}

/// JS line terminators (what `$` matches before in a multiline regex).
fn line_end(rest: &str) -> bool {
    rest.is_empty() || rest.starts_with(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `text.replace(new RegExp(`${escape(needle)}$`, 'gm'), replacement)`.
fn replace_at_line_ends(text: &str, needle: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        if rest.starts_with(needle) && line_end(&rest[needle.len()..]) {
            out.push_str(replacement);
            index += needle.len();
            continue;
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        index += c.len_utf8();
    }
    out
}

/// `maskPasswords`: a password's value at the end of a snapshot line
/// (`: value` or `: "value"`) becomes [`MASK`]; nothing else is touched, so
/// a short password does not blank unrelated text.
pub fn mask_passwords(snapshot: &str, values: &[String]) -> String {
    let mut out = snapshot.to_owned();
    let mut seen = std::collections::HashSet::new();
    for value in values {
        if value.is_empty() || !seen.insert(value.as_str()) {
            continue;
        }
        out = replace_at_line_ends(&out, &format!(": {value}"), &format!(": {MASK}"));
        out = replace_at_line_ends(&out, &format!(": \"{value}\""), &format!(": \"{MASK}\""));
    }
    out
}

/// What [`clip`] returns (`clip` of `browser.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clip {
    pub content: String,
    pub offset: usize,
    pub total_chars: usize,
    pub truncated: bool,
}

/// `clip(text, offset, max)` in UTF-16 code units. A cut through a
/// surrogate pair leaves U+FFFD where JS would leave a lone surrogate
/// (which a Rust string cannot hold; JSON would escape it as `\udXXX`).
pub fn clip(text: &str, offset: usize, max: usize) -> Clip {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = offset.min(units.len());
    let end = start.saturating_add(max).min(units.len());
    Clip {
        content: String::from_utf16_lossy(&units[start..end]),
        offset: start,
        total_chars: units.len(),
        truncated: start.saturating_add(max) < units.len(),
    }
}

/// `cleanError`: Playwright's message without its call log, at most four
/// lines and 1000 UTF-16 code units.
pub fn clean_error(message: &str) -> String {
    let head = message.split("\nCall log:").next().unwrap_or_default();
    let lines = head.split('\n').take(4).collect::<Vec<_>>().join("\n");
    crate::util::head16(&lines, 1000).to_owned()
}

/// `describe(op, args)`: the action shown to viewers and in the log.
pub fn describe(op: &str, args: &Value) -> String {
    let target = match arg(args, "ref") {
        Some(Value::String(reference)) => format!(" {reference}"),
        _ => String::new(),
    };
    match op {
        "fetch" => format!("Fetch {}", string_or_empty(arg(args, "url"))),
        "navigate" => format!("Navigate to {}", string_or_empty(arg(args, "url"))),
        "type" => format!("Type into{target}"),
        "press" => format!("Press {}", string_or_empty(arg(args, "key"))),
        "wait_for" => "Wait".to_owned(),
        _ => {
            let mut chars = op.chars();
            let first = chars.next().map(|c| c.to_uppercase().to_string());
            format!(
                "{}{}{target}",
                first.unwrap_or_default(),
                chars.as_str().replacen('_', " ", 1)
            )
        }
    }
}

/// The recording's file name stamp: `new Date().toISOString()` with `:`
/// and `.` replaced by `-`.
pub fn file_stamp(epoch_ms: i64) -> String {
    pirc_agent::features::team::broker::iso_time(epoch_ms.max(0) as u64).replace([':', '.'], "-")
}

/// A recording's file name: `name` with runs of other characters than
/// `[a-zA-Z0-9_-]` replaced by `-`, cut to 60, else `recording`.
pub fn recording_name(name: &str) -> String {
    let mut safe = String::new();
    let mut run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            safe.push(c);
            run = false;
        } else if !run {
            safe.push('-');
            run = true;
        }
    }
    safe.truncate(60);
    if safe.is_empty() {
        "recording".to_owned()
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn message(result: ApiResult<String>) -> String {
        result.unwrap_err().message
    }

    #[test]
    fn only_opens_http_urls_and_adds_a_scheme_to_bare_hosts() {
        assert_eq!(
            check_url(Some(&json!("example.com/a"))).unwrap(),
            "https://example.com/a"
        );
        assert_eq!(
            check_url(Some(&json!("http://127.0.0.1:3000/"))).unwrap(),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            check_url(Some(&json!("  HTTP://Example.COM  "))).unwrap(),
            "http://example.com/"
        );
        assert!(
            message(check_url(Some(&json!("file:///etc/passwd")))).contains("Only http and https")
        );
        assert!(
            message(check_url(Some(&json!("javascript:alert(1)")))).contains("Only http and https")
        );
        assert_eq!(
            message(check_url(Some(&json!("")))),
            "url must be a non-empty string"
        );
        assert_eq!(
            message(check_url(Some(&json!("   ")))),
            "url must be a non-empty string"
        );
        assert_eq!(message(check_url(None)), "url must be a non-empty string");
        assert_eq!(
            message(check_url(Some(&json!(5)))),
            "url must be a non-empty string"
        );
        assert_eq!(
            message(check_url(Some(&json!(format!("a{}", "b".repeat(8192)))))),
            "url must be a non-empty string"
        );
        assert_eq!(
            message(check_url(Some(&json!("http://exa mple.com")))),
            "Not a URL: http://exa mple.com"
        );
        let error = check_url(Some(&json!("ftp://x"))).unwrap_err();
        assert_eq!((error.status, &*error.code), (400, "invalid_input"));
    }

    #[test]
    fn masks_password_values_in_snapshots() {
        let snapshot = "- textbox \"User\" [ref=e3]: alice\n- textbox \"Pass\" [ref=e4]: s3cr.t\n";
        assert_eq!(
            mask_passwords(snapshot, &["s3cr.t".into()]),
            "- textbox \"User\" [ref=e3]: alice\n- textbox \"Pass\" [ref=e4]: ••••••\n"
        );
        // A short password does not blank unrelated text.
        assert_eq!(
            mask_passwords("- text: a b a", &["a".into()]),
            "- text: a b a"
        );
        assert_eq!(
            mask_passwords(
                "- textbox: \"p$1\"\r\n- x: p$1",
                &["p$1".into(), "p$1".into(), String::new()]
            ),
            "- textbox: \"••••••\"\r\n- x: ••••••"
        );
    }

    #[test]
    fn clips_in_utf16_code_units() {
        let clipped = clip("a😀bc", 1, 2);
        assert_eq!(
            clipped,
            Clip {
                content: "😀".into(),
                offset: 1,
                total_chars: 5,
                truncated: true
            }
        );
        assert_eq!(clip("abc", 10, 5).offset, 3);
        assert!(!clip("abc", 0, 3).truncated);
        assert_eq!(clip("a😀", 0, 2).content, "a\u{fffd}");
    }

    #[test]
    fn cleans_playwright_errors() {
        assert_eq!(
            clean_error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting"),
            "locator.click: Timeout 10000ms exceeded."
        );
        assert_eq!(clean_error("1\n2\n3\n4\n5"), "1\n2\n3\n4");
        assert_eq!(utf16_len(&clean_error(&"é".repeat(2000))), 1000);
    }

    #[test]
    fn describes_actions() {
        assert_eq!(describe("fetch", &json!({ "url": "x" })), "Fetch x");
        assert_eq!(describe("fetch", &json!({})), "Fetch ");
        assert_eq!(describe("navigate", &json!({ "url": 5 })), "Navigate to 5");
        assert_eq!(describe("type", &json!({ "ref": "e1" })), "Type into e1");
        assert_eq!(describe("type", &json!({})), "Type into");
        assert_eq!(describe("press", &json!({ "key": "Enter" })), "Press Enter");
        assert_eq!(describe("wait_for", &json!({})), "Wait");
        assert_eq!(describe("click", &json!({ "ref": "e2" })), "Click e2");
        assert_eq!(describe("a_b_c", &json!([])), "A b_c");
        assert_eq!(describe("tabs", &json!({ "ref": 1 })), "Tabs");
    }

    #[test]
    fn coerces_arguments() {
        assert_eq!(int_arg(Some(&json!(5.7)), 1, 0, 10), 5);
        assert_eq!(int_arg(Some(&json!(-3)), 1, 0, 10), 0);
        assert_eq!(int_arg(Some(&json!(1e300)), 1, 0, 10), 10);
        assert_eq!(int_arg(Some(&json!("5")), 1, 0, 10), 1);
        assert_eq!(int_arg(None, 1, 0, 10), 1);
        assert_eq!(str_arg(Some(&json!(" ")), "key", 1).unwrap(), " ");
        assert_eq!(
            str_arg(Some(&json!("ab")), "key", 1).unwrap_err().message,
            "key must be a non-empty string"
        );
        assert_eq!(
            ref_arg(Some(&json!("e-1"))).unwrap_err().message,
            "ref must come from browser_snapshot"
        );
        assert_eq!(ref_arg(Some(&json!("f1E3"))).unwrap(), "f1E3");
        assert_eq!(js_string(None), "(missing)");
        assert_eq!(js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(num_arg(Some(&json!(2.5))), 2.5);
        assert_eq!(arg(&json!(["x"]), "0"), None);
    }

    #[test]
    fn names_recordings() {
        assert_eq!(recording_name("my demo!!"), "my-demo-");
        assert_eq!(recording_name(""), "recording");
        assert_eq!(recording_name(&"x".repeat(80)).len(), 60);
        assert_eq!(file_stamp(0), "1970-01-01T00-00-00-000Z");
    }
}
