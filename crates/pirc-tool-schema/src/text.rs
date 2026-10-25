//! Private compatibility helpers, deliberately independent of pirc-config.
//! Keep the text/JSON behavior aligned with its equivalents (agent parity tests).

use serde_json::Value;

/// `Number.prototype.toString()` (`String(number)`).
pub fn float_text(value: f64) -> String {
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
            _ => out.push_str(&float_text(number.as_f64().unwrap_or(0.0))),
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

/// White space, including a byte-order mark (which editors leave at the
/// start of files and JSON strings).
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `text` without leading and trailing [`is_space`] characters.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// The length in UTF-16 code units.
pub fn len16(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte offset after the longest prefix of at most `units` code units.
fn byte_at_unit(text: &str, units: usize) -> usize {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return index;
        }
    }
    text.len()
}

/// The first `units` code units, never more (a character of two units
/// at the boundary is left out).
pub fn head16(text: &str, units: usize) -> &str {
    &text[..byte_at_unit(text, units)]
}

/// A JSON value as text: strings as they are, numbers as JavaScript prints
/// them (`2`, not `2.0`), arrays and objects as JSON.
pub fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n
            .as_i64()
            .map(|i| i.to_string())
            .or_else(|| n.as_u64().map(|u| u.to_string()))
            .unwrap_or_else(|| float_text(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => stringify(value),
    }
}

/// A bound as JavaScript prints it, preserving integer JSON values.
pub fn number_text(number: &serde_json::Number) -> String {
    string_of(&Value::Number(number.clone()))
}
