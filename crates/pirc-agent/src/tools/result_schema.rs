//! Helpers for `Tool::result_schema` (`agent/tools/result-schema.ts`): the
//! typed fields a capability's result carries for `ptc` scripts, besides
//! `text` and `images` (added by the registry). The shapes stay small: they
//! are documentation the model reads through `ptc_docs`.

use serde_json::{Map, Value, json};

fn described(mut schema: Map<String, Value>, description: Option<&str>) -> Value {
    if let Some(description) = description.filter(|d| !d.is_empty()) {
        schema.insert("description".to_owned(), json!(description));
    }
    Value::Object(schema)
}

fn typed(kind: &str, description: Option<&str>) -> Value {
    let mut schema = Map::new();
    schema.insert("type".to_owned(), json!(kind));
    described(schema, description)
}

pub fn str_(description: Option<&str>) -> Value {
    typed("string", description)
}

pub fn int(description: Option<&str>) -> Value {
    typed("integer", description)
}

pub fn num(description: Option<&str>) -> Value {
    typed("number", description)
}

pub fn bool_(description: Option<&str>) -> Value {
    typed("boolean", description)
}

pub fn arr(items: Value, description: Option<&str>) -> Value {
    let mut schema = Map::new();
    schema.insert("type".to_owned(), json!("array"));
    schema.insert("items".to_owned(), items);
    described(schema, description)
}

pub fn literal(value: &str) -> Value {
    json!({ "const": value })
}

pub fn one_of_strings(values: &[&str], description: Option<&str>) -> Value {
    let mut schema = Map::new();
    schema.insert("type".to_owned(), json!("string"));
    schema.insert("enum".to_owned(), json!(values));
    described(schema, description)
}

/// `schema` or null.
pub fn nullable(schema: Value) -> Value {
    let mut map = match schema {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let kind = map.get("type").cloned().unwrap_or(Value::Null);
    map.insert("type".to_owned(), json!([kind, "null"]));
    Value::Object(map)
}

/// Any JSON value (a record whose shape belongs to another service).
pub fn json(description: Option<&str>) -> Value {
    described(Map::new(), description)
}

/// A closed object; every property is required unless listed in `optional`.
pub fn obj(properties: Vec<(&str, Value)>, optional: &[&str]) -> Value {
    let required: Vec<&str> = properties
        .iter()
        .map(|(key, _)| *key)
        .filter(|key| !optional.contains(key))
        .collect();
    let properties: Map<String, Value> = properties
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// A record another component owns and may extend: the listed fields are
/// documented, others may appear.
pub fn record(properties: Vec<(&str, Value)>, optional: &[&str]) -> Value {
    let mut schema = obj(properties, optional);
    schema["additionalProperties"] = json!(true);
    schema
}

/// A capability result with these fields (`text`/`images` are added by the
/// registry).
pub fn fields(properties: Vec<(&str, Value)>, optional: &[&str]) -> Value {
    obj(properties, optional)
}

/// One action of [`by_action`]: its name, fields and optional fields.
pub type ActionFields<'a> = (&'a str, Vec<(&'a str, Value)>, &'a [&'a str]);

/// Results of an action-dependent capability: one alternative per action.
pub fn by_action(actions: Vec<ActionFields<'_>>) -> Value {
    let branches: Vec<Value> = actions
        .into_iter()
        .map(|(action, properties, optional)| {
            let mut all = vec![("action", literal(action))];
            all.extend(properties);
            obj(all, optional)
        })
        .collect();
    json!({ "oneOf": branches })
}
