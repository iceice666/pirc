//! Execution-time validation of capability arguments against the JSON
//! schema subset the tool definitions use (`agent/ptc/schema.ts`): type,
//! properties, required, additionalProperties, enum, const, items, numeric
//! and length bounds, pattern, oneOf/anyOf. Unknown keywords are ignored.

use serde_json::{Map, Value};

use crate::text as js;

const MAX_ERRORS: usize = 8;

/// A numeric bound: keyword, operator shown, whether a value fails it.
type Bound = (&'static str, &'static str, fn(f64, f64) -> bool);

fn is_integer(n: &serde_json::Number) -> bool {
    n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0)
}

/// `typeOf`.
fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) if is_integer(n) => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn matches_type(value: &Value, kind: &str) -> bool {
    let actual = type_of(value);
    if kind == "number" {
        return actual == "number" || actual == "integer";
    }
    actual == kind
}

/// `Object.is` for JSON values (objects and arrays are never the same).
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => a == b && a.is_sign_negative() == b.is_sign_negative(),
            _ => false,
        },
        _ => false,
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn number_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n)) => js::number_text(n),
        _ => String::new(),
    }
}

fn or<'a>(at: &'a str, fallback: &'a str) -> &'a str {
    if at.is_empty() { fallback } else { at }
}

fn check(value: &Value, schema: &Value, at: &str, errors: &mut Vec<String>) {
    if errors.len() >= MAX_ERRORS {
        return;
    }
    let empty = Map::new();
    let schema = match schema {
        Value::Object(map) => map,
        // `typeof [] === 'object'`: an array constrains nothing.
        Value::Array(_) => &empty,
        _ => return,
    };
    // Alternatives: exactly one (oneOf) or at least one (anyOf) must match.
    for keyword in ["oneOf", "anyOf"] {
        let Some(Value::Array(branches)) = schema.get(keyword) else {
            continue;
        };
        let matching = branches
            .iter()
            .filter(|branch| {
                let mut inner = Vec::new();
                check(value, branch, at, &mut inner);
                inner.is_empty()
            })
            .count();
        let failed = if keyword == "oneOf" {
            matching != 1
        } else {
            matching == 0
        };
        if failed {
            errors.push(format!(
                "{} matches {matching} of the {keyword} alternatives",
                or(at, "value")
            ));
            return;
        }
    }
    let types: Option<Vec<&str>> = match schema.get("type") {
        Some(Value::Array(items)) => Some(items.iter().filter_map(Value::as_str).collect()),
        Some(Value::String(kind)) => Some(vec![kind.as_str()]),
        _ => None,
    };
    if let Some(types) = &types
        && !types.iter().any(|kind| matches_type(value, kind))
    {
        errors.push(format!(
            "{} must be {}, got {}",
            or(at, "arguments"),
            types.join(" or "),
            type_of(value)
        ));
        return;
    }
    if let Some(Value::Array(options)) = schema.get("enum")
        && !options.iter().any(|item| same_value(item, value))
    {
        let listed = js::stringify(&Value::Array(options.clone()));
        errors.push(format!(
            "{} must be one of {}",
            or(at, "arguments"),
            js::head16(&listed, 200)
        ));
        return;
    }
    if let Some(constant) = schema.get("const")
        && !same_value(constant, value)
    {
        errors.push(format!("{at} must be {}", js::stringify(constant)));
        return;
    }
    if let Value::String(text) = value {
        let length = text.chars().count() as f64;
        if let Some(min) = number(schema.get("minLength"))
            && length < min
        {
            errors.push(format!(
                "{at} must have at least {} characters",
                number_text(schema.get("minLength"))
            ));
        }
        if let Some(max) = number(schema.get("maxLength"))
            && length > max
        {
            errors.push(format!(
                "{at} must have at most {} characters",
                number_text(schema.get("maxLength"))
            ));
        }
        if let Some(Value::String(pattern)) = schema.get("pattern") {
            match regress::Regex::with_flags(pattern, "u") {
                Err(_) => errors.push(format!("{at} has an unusable pattern in its schema")),
                Ok(regex) if regex.find(text).is_none() => {
                    errors.push(format!("{at} must match {pattern}"));
                }
                Ok(_) => {}
            }
        }
    }
    if let Value::Number(n) = value {
        let n = n.as_f64().unwrap_or(0.0);
        let bounds: [Bound; 4] = [
            ("minimum", ">=", |v, b| v < b),
            ("maximum", "<=", |v, b| v > b),
            ("exclusiveMinimum", ">", |v, b| v <= b),
            ("exclusiveMaximum", "<", |v, b| v >= b),
        ];
        for (keyword, op, fails) in bounds {
            if let Some(bound) = number(schema.get(keyword))
                && fails(n, bound)
            {
                errors.push(format!(
                    "{at} must be {op} {}",
                    number_text(schema.get(keyword))
                ));
            }
        }
    }
    if let Value::Array(items) = value {
        let length = items.len() as f64;
        if let Some(min) = number(schema.get("minItems"))
            && length < min
        {
            errors.push(format!(
                "{at} must have at least {} items",
                number_text(schema.get("minItems"))
            ));
        }
        if let Some(max) = number(schema.get("maxItems"))
            && length > max
        {
            errors.push(format!(
                "{at} must have at most {} items",
                number_text(schema.get("maxItems"))
            ));
        }
        if let Some(item_schema @ (Value::Object(_) | Value::Array(_))) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                check(item, item_schema, &format!("{at}[{index}]"), errors);
            }
        }
    }
    if let Value::Object(record) = value {
        let properties = match schema.get("properties") {
            Some(Value::Object(properties)) => properties,
            _ => &empty,
        };
        if let Some(Value::Array(required)) = schema.get("required") {
            for key in required {
                let key = js::string_of(key);
                if !record.contains_key(&key) {
                    let prefix = if at.is_empty() {
                        String::new()
                    } else {
                        format!("{at}.")
                    };
                    errors.push(format!("{prefix}{key} is required"));
                }
            }
        }
        for (key, item) in record {
            let path = if at.is_empty() {
                key.clone()
            } else {
                format!("{at}.{key}")
            };
            if let Some(property) = properties.get(key) {
                check(item, property, &path, errors);
            } else {
                match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => errors.push(format!("{path} is not allowed")),
                    Some(extra @ (Value::Object(_) | Value::Array(_))) => {
                        check(item, extra, &path, errors);
                    }
                    _ => {}
                }
            }
        }
    }
}

/// `validateSchema(value, schema)`: the problems, empty when valid.
pub fn validate_schema(value: &Value, schema: &Map<String, Value>) -> Vec<String> {
    let mut errors = Vec::new();
    check(value, &Value::Object(schema.clone()), "", &mut errors);
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn errors(value: Value, schema: Value) -> Vec<String> {
        validate_schema(&value, schema.as_object().unwrap())
    }

    #[test]
    fn checks_the_keywords_tool_definitions_use() {
        let schema = json!({
            "type": "object",
            "properties": {
                "code": { "type": "string", "minLength": 1 },
                "timeout": { "type": "number", "exclusiveMinimum": 0, "maximum": 3600 },
                "names": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 8 },
                "mode": { "type": "string", "enum": ["a", "b"] },
                "id": { "type": "string", "pattern": "^[a-f0-9]{12}$" },
            },
            "required": ["code"],
            "additionalProperties": false,
        });
        assert!(errors(json!({ "code": "x", "timeout": 1.5 }), schema.clone()).is_empty());
        assert_eq!(
            errors(json!({ "code": "return 1", "extra": true }), schema.clone()),
            vec!["extra is not allowed"]
        );
        assert_eq!(errors(json!({}), schema.clone()), vec!["code is required"]);
        assert_eq!(
            errors(json!({ "code": "" }), schema.clone()),
            vec!["code must have at least 1 characters"]
        );
        assert_eq!(
            errors(json!({ "code": "x", "timeout": 0 }), schema.clone()),
            vec!["timeout must be > 0"]
        );
        assert_eq!(
            errors(json!({ "code": "x", "timeout": 4000 }), schema.clone()),
            vec!["timeout must be <= 3600"]
        );
        assert_eq!(
            errors(json!({ "code": 1 }), schema.clone()),
            vec!["code must be string, got integer"]
        );
        assert_eq!(
            errors(json!({ "code": "x", "names": [] }), schema.clone()),
            vec!["names must have at least 1 items"]
        );
        assert_eq!(
            errors(json!({ "code": "x", "names": ["a", 2] }), schema.clone()),
            vec!["names[1] must be string, got integer"]
        );
        assert_eq!(
            errors(json!({ "code": "x", "mode": "c" }), schema.clone()),
            vec![r#"mode must be one of ["a","b"]"#]
        );
        assert_eq!(
            errors(json!({ "code": "x", "id": "nope" }), schema.clone()),
            vec!["id must match ^[a-f0-9]{12}$"]
        );
        assert_eq!(
            errors(json!([1]), schema),
            vec!["arguments must be object, got array"]
        );
    }

    #[test]
    fn checks_alternatives_and_nullable_types() {
        let schema = json!({
            "oneOf": [
                { "type": "object", "properties": { "kind": { "const": "a" } }, "required": ["kind"] },
                { "type": "object", "properties": { "kind": { "const": "b" }, "n": { "type": ["integer", "null"] } }, "required": ["kind", "n"] },
            ]
        });
        assert!(errors(json!({ "kind": "a" }), schema.clone()).is_empty());
        assert!(errors(json!({ "kind": "b", "n": null }), schema.clone()).is_empty());
        assert_eq!(
            errors(json!({ "kind": "c" }), schema),
            vec!["value matches 0 of the oneOf alternatives"]
        );
        let number = json!({ "type": "number" });
        assert!(errors(json!(3), number).is_empty());
        assert_eq!(
            errors(json!(1.5), json!({ "type": "integer" })),
            vec!["arguments must be integer, got number"]
        );
        assert_eq!(errors(json!(1), json!({ "const": 2 })), vec![" must be 2"]);
    }

    #[test]
    fn stops_after_eight_problems() {
        let schema = json!({ "type": "object", "additionalProperties": false });
        let value: Map<String, Value> = (0..20).map(|i| (format!("k{i}"), json!(i))).collect();
        // One object check reports all its keys, as in TS; nested checks stop.
        assert_eq!(errors(Value::Object(value), schema).len(), 20);
        let nested = json!({ "type": "array", "items": { "type": "string" } });
        assert_eq!(
            errors(json!([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), nested).len(),
            8
        );
    }
}
