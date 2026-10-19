//! JavaScript number and JSON formatting used by Bun-compatible front matter.

use serde_json::Value;

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
}
