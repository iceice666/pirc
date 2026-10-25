//! The few zod checks memory's inputs use, on JSON values: lengths in
//! UTF-16 units, JavaScript integers, `.optional()` that refuses `null`,
//! and `.strict()` objects.

use serde_json::{Map, Value};

pub use pirc_config::text::utf16_len as len16;

/// `Number.isInteger(value)`, as an `i64` (saturating beyond its range).
pub fn int(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else {
        return None;
    };
    if let Some(int) = number.as_i64() {
        return Some(int);
    }
    if number.as_u64().is_some() {
        return Some(i64::MAX);
    }
    number
        .as_f64()
        .filter(|f| f.is_finite() && f.fract() == 0.0)
        .map(|f| f as i64)
}

/// `z.string().min(min).max(max)`.
pub fn string(value: &Value, min: usize, max: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|text| (min..=max).contains(&len16(text)))
}

/// An object, with no keys but `keys` (`.strict()`).
pub fn strict<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    value
        .as_object()
        .filter(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}

/// A field that may be absent (but not `null`): `Err` when present and
/// invalid.
pub fn optional<'a, T>(
    object: &'a Map<String, Value>,
    key: &str,
    check: impl FnOnce(&'a Value) -> Option<T>,
) -> Result<Option<T>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => check(value).map(Some).ok_or(()),
    }
}

/// A required field.
pub fn required<'a, T>(
    object: &'a Map<String, Value>,
    key: &str,
    check: impl FnOnce(&'a Value) -> Option<T>,
) -> Result<T, ()> {
    object.get(key).and_then(check).ok_or(())
}

/// `z.array(item).min(min).max(max)`.
pub fn array<'a, T>(
    value: &'a Value,
    min: usize,
    max: usize,
    item: impl Fn(&'a Value) -> Option<T>,
) -> Option<Vec<T>> {
    let items = value.as_array()?;
    if !(min..=max).contains(&items.len()) {
        return None;
    }
    items.iter().map(item).collect()
}

/// `/^[a-f0-9]{12}$/`.
pub fn hex12(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| id.len() == 12 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn checks() {
        assert_eq!(int(&json!(3)), Some(3));
        assert_eq!(int(&json!(3.0)), Some(3));
        assert_eq!(int(&json!(3.5)), None);
        assert_eq!(int(&json!("3")), None);
        assert_eq!(string(&json!("😀"), 2, 2), Some("😀"));
        assert_eq!(string(&json!(""), 1, 2), None);
        assert!(strict(&json!({ "a": 1 }), &["a"]).is_some());
        assert!(strict(&json!({ "b": 1 }), &["a"]).is_none());
        let object = json!({ "a": null });
        let object = object.as_object().unwrap();
        assert_eq!(optional(object, "a", Value::as_str), Err(()));
        assert_eq!(optional(object, "b", Value::as_str), Ok(None));
        assert_eq!(hex12(&json!("0123456789ab")), Some("0123456789ab"));
        assert_eq!(hex12(&json!("0123456789AB")), None);
    }
}
