use crate::js;
use serde_json::{Map, Value, json};
/// `parseToolArguments`: malformed JSON becomes `{}` plus a marker.
pub fn parse_tool_arguments(raw: &str) -> Map<String, Value> {
    if js::trim(raw).is_empty() {
        return Map::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(object)) => object,
        Ok(value) => {
            let mut object = Map::new();
            object.insert("value".to_owned(), value);
            object
        }
        Err(_) => {
            let mut object = Map::new();
            object.insert("__invalid_json".to_owned(), json!(raw));
            object
        }
    }
}
