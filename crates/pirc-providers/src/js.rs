//! JavaScript value semantics the ported code relies on (truthiness, optional
//! property access, `String.prototype.trim`), over `serde_json::Value`.

use serde_json::Value;

/// `value.key` on any JSON value: `None` for non-objects and missing keys.
pub fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `a ?? b` on property values: `null` counts as absent.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// JavaScript truthiness of an optional (`undefined`) JSON value.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// A non-empty string value, the common `typeof x === 'string' && x` check.
pub fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|text| !text.is_empty())
}

/// A JSON number as JavaScript sees it (`typeof x === 'number'`).
pub fn number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64()
}

/// `String(value)` for the values a template literal may meet.
pub fn to_js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => number_to_js(number),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn number_to_js(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(value) if value.fract() == 0.0 && value.abs() < 1e21 => format!("{value:.0}"),
        _ => number.to_string(),
    }
}

/// `String.prototype.trim`: Unicode white space plus the BOM.
pub fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A JSON number as the `u64` the wire types use (JavaScript would keep
/// fractions and negative values; the wire cannot carry them).
pub fn to_u64(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value as u64
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_javascript() {
        for value in [json!(0), json!(""), json!(null), json!(false)] {
            assert!(!truthy(Some(&value)), "{value}");
        }
        for value in [json!(1), json!("0"), json!([]), json!({}), json!(true)] {
            assert!(truthy(Some(&value)), "{value}");
        }
        assert!(!truthy(None));
    }

    #[test]
    fn stringifies_like_template_literals() {
        assert_eq!(to_js_string(&json!(5)), "5");
        assert_eq!(to_js_string(&json!(5.5)), "5.5");
        assert_eq!(to_js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(to_js_string(&json!({ "a": 1 })), "[object Object]");
    }
}
