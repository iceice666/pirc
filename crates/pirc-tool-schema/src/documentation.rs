//! Compact TypeScript documentation from schema and description metadata.

use serde_json::{Map, Value};

use crate::text as js;

const MAX_DEPTH: usize = 3;

/// `summaryOf`: the first sentence of a description, bounded. A sentence
/// ends at `.`, `!` or `?` before whitespace and a capital letter, or at a
/// line break.
pub fn summary_of(description: &str, max: usize) -> String {
    let text = js::trim(description);
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut end = text.len();
    for (index, &(offset, c)) in chars.iter().enumerate() {
        if c == '\n' {
            end = offset;
            break;
        }
        if index > 0 && matches!(chars[index - 1].1, '.' | '!' | '?') && js::is_space(c) {
            let next = chars[index..].iter().find(|(_, c)| !js::is_space(*c));
            if next.is_some_and(|(_, c)| c.is_ascii_uppercase()) {
                end = offset;
                break;
            }
        }
    }
    let first = &text[..end];
    if js::len16(first) > max {
        format!("{}…", js::head16(first, max.saturating_sub(1)))
    } else {
        first.to_owned()
    }
}

/// `/^[A-Za-z_$][\w$]*$/`.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        js::stringify(&Value::String(name.to_owned()))
    }
}

/// Parenthesize a union at its top level (not one nested in an object type).
fn wrap(kind: &str) -> String {
    let mut depth = 0i32;
    for c in kind.chars() {
        match c {
            '{' | '(' => depth += 1,
            '}' | ')' => depth -= 1,
            '|' if depth == 0 => return format!("({kind})"),
            _ => {}
        }
    }
    kind.to_owned()
}

fn unique(parts: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        if !out.contains(&part) {
            out.push(part);
        }
    }
    out
}

/// `tsType`: a TypeScript type for a JSON schema, simplified (no
/// descriptions, bounded depth).
pub fn ts_type(schema: &Value, depth: usize) -> String {
    let Value::Object(s) = schema else {
        return "unknown".to_owned();
    };
    // A nullable const or enum keeps its null.
    let or_null = match s.get("type") {
        Some(Value::Array(kinds)) if kinds.iter().any(|k| k == "null") => " | null",
        _ => "",
    };
    if let Some(constant) = s.get("const") {
        return format!("{}{or_null}", js::stringify(constant));
    }
    if let Some(Value::Array(options)) = s.get("enum") {
        let listed: Vec<String> = options.iter().map(js::stringify).collect();
        return format!("{}{or_null}", listed.join(" | "));
    }
    for union in ["oneOf", "anyOf"] {
        if let Some(Value::Array(items)) = s.get(union) {
            return unique(items.iter().map(|item| ts_type(item, depth))).join(" | ");
        }
    }
    if let Some(Value::Array(kinds)) = s.get("type") {
        return unique(kinds.iter().map(|kind| {
            let mut one = s.clone();
            one.insert("type".to_owned(), kind.clone());
            ts_type(&Value::Object(one), depth)
        }))
        .join(" | ");
    }
    match s.get("type").and_then(Value::as_str) {
        Some("string") => "string".to_owned(),
        Some("integer" | "number") => "number".to_owned(),
        Some("boolean") => "boolean".to_owned(),
        Some("null") => "null".to_owned(),
        Some("array") => format!(
            "{}[]",
            wrap(&ts_type(s.get("items").unwrap_or(&Value::Null), depth + 1))
        ),
        Some("object") => {
            let empty = Map::new();
            let properties = match s.get("properties") {
                Some(Value::Object(properties)) => properties,
                _ => &empty,
            };
            if properties.is_empty() {
                return if s.get("additionalProperties") == Some(&Value::Bool(false)) {
                    "{}".to_owned()
                } else {
                    "Record<string, unknown>".to_owned()
                };
            }
            if depth >= MAX_DEPTH {
                return "object".to_owned();
            }
            let required: Vec<&str> = match s.get("required") {
                Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
                _ => Vec::new(),
            };
            let mut members: Vec<String> = properties
                .iter()
                .map(|(name, schema)| {
                    format!(
                        "{}{}: {}",
                        key(name),
                        if required.contains(&name.as_str()) {
                            ""
                        } else {
                            "?"
                        },
                        ts_type(schema, depth + 1)
                    )
                })
                .collect();
            if s.get("additionalProperties") == Some(&Value::Bool(true)) {
                members.push("[key: string]: unknown".to_owned());
            }
            format!("{{ {} }}", members.join("; "))
        }
        _ => "unknown".to_owned(),
    }
}

/// Brief notes on parameters that carry a description.
fn parameter_notes(parameters: &Map<String, Value>) -> Vec<String> {
    let Some(Value::Object(properties)) = parameters.get("properties") else {
        return Vec::new();
    };
    properties
        .iter()
        .filter_map(|(name, schema)| match schema.get("description") {
            Some(Value::String(description)) if !js::trim(description).is_empty() => {
                Some(format!("{name}: {}", summary_of(description, 100)))
            }
            _ => None,
        })
        .collect()
}

fn call_args(parameters: &Map<String, Value>) -> String {
    let args = ts_type(&Value::Object(parameters.clone()), 0);
    let optional = match parameters.get("required") {
        Some(Value::Array(required)) => required.is_empty(),
        _ => true,
    };
    if args == "{}" {
        String::new()
    } else {
        format!("args{}: {args}", if optional { "?" } else { "" })
    }
}

/// Render a call/result signature, description summary and parameter notes.
///
/// `callable` is the complete callable expression (for example `api.read`);
/// no routing prefix, common result fields or tool-specific caveats are added.
/// The caller decides which fields to include in `result_schema`.
pub fn signature_of(
    callable: &str,
    parameters: &Map<String, Value>,
    result_schema: &Value,
    description: &str,
) -> String {
    let result = ts_type(result_schema, 0);
    let notes = parameter_notes(parameters);
    let mut second = format!("  {}", summary_of(description, 160));
    if !notes.is_empty() {
        second.push_str(&format!(" ({})", notes.join("; ")));
    }
    format!(
        "`{callable}({}): {result}`\n{second}",
        call_args(parameters)
    )
}

/// Render a one-line call signature (arguments only, then the summary).
/// `callable` is the complete callable expression, without inferred routing.
pub fn compact_signature_of(
    callable: &str,
    parameters: &Map<String, Value>,
    description: &str,
) -> String {
    format!(
        "`{callable}({})` — {}",
        call_args(parameters),
        summary_of(description, 120)
    )
}

/// One capability's prompt block.
pub struct Block {
    pub name: String,
    pub block: String,
}

/// `fitSignatures`'s result.
#[derive(Debug, PartialEq, Eq)]
pub struct Fitted {
    pub core_listed: Vec<String>,
    pub other_listed: Vec<String>,
    pub unlisted: Vec<String>,
}

/// `fitSignatures`: core blocks first, then the others in the given order,
/// while they fit `budget` characters (UTF-16 units); the names that do not
/// fit, sorted.
pub fn fit_signatures(core: &[Block], others: &[Block], budget: usize) -> Fitted {
    let mut used = 0;
    let mut unlisted = Vec::new();
    let mut fit = |items: &[Block]| {
        let mut listed = Vec::new();
        for Block { name, block } in items {
            let size = js::len16(block) + 1;
            if used + size <= budget {
                listed.push(block.clone());
                used += size;
            } else {
                unlisted.push(name.clone());
            }
        }
        listed
    };
    let core_listed = fit(core);
    let other_listed = fit(others);
    unlisted.sort();
    Fitted {
        core_listed,
        other_listed,
        unlisted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_json_schemas_as_compact_typescript_types() {
        let t = |schema: Value| ts_type(&schema, 0);
        assert_eq!(t(json!({ "type": "string" })), "string");
        assert_eq!(t(json!({ "type": "integer" })), "number");
        assert_eq!(t(json!({ "const": "text" })), "\"text\"");
        assert_eq!(
            t(json!({ "type": "string", "enum": ["a", "b"] })),
            "\"a\" | \"b\""
        );
        assert_eq!(t(json!({ "type": ["integer", "null"] })), "number | null");
        assert_eq!(
            t(json!({ "type": "array", "items": { "type": ["string", "null"] } })),
            "(string | null)[]"
        );
        assert_eq!(
            t(json!({
                "type": "object",
                "properties": { "a": { "type": "string" }, "b-c": { "type": "boolean" } },
                "required": ["a"],
                "additionalProperties": true,
            })),
            "{ a: string; \"b-c\"?: boolean; [key: string]: unknown }"
        );
        assert_eq!(
            t(json!({ "type": "object", "properties": {}, "additionalProperties": false })),
            "{}"
        );
        assert_eq!(t(json!({ "type": "object" })), "Record<string, unknown>");
        assert_eq!(
            t(json!({ "oneOf": [{ "type": "string" }, { "type": "string" }, { "type": "null" }] })),
            "string | null"
        );
        assert_eq!(t(json!({})), "unknown");
        assert_eq!(
            t(json!({ "type": ["string", "null"], "enum": ["a", "b"] })),
            "\"a\" | \"b\" | null"
        );
        assert_eq!(
            t(json!({
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": { "k": { "type": "string", "enum": ["x", "y"] } },
                    "required": ["k"],
                },
            })),
            "{ k: \"x\" | \"y\" }[]"
        );
        let mut schema = json!({ "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] });
        for _ in 0..4 {
            schema = json!({ "type": "object", "properties": { "n": schema }, "required": ["n"] });
        }
        assert_eq!(t(schema), "{ n: { n: { n: object } } }");
    }

    #[test]
    fn fits_core_blocks_first_then_others_in_order_and_names_the_rest_sorted() {
        let block = |name: &str, size: usize| Block {
            name: name.to_owned(),
            block: format!("{name:.<size$}"),
        };
        let result = fit_signatures(
            &[block("read", 40), block("bash", 40)],
            &[block("a_small", 10), block("c_big", 50), block("b_mid", 20)],
            100,
        );
        assert_eq!(
            result
                .core_listed
                .iter()
                .map(|b| &b[..4])
                .collect::<Vec<_>>(),
            vec!["read", "bash"]
        );
        assert_eq!(
            result
                .other_listed
                .iter()
                .map(|b| b.trim_end_matches('.'))
                .collect::<Vec<_>>(),
            vec!["a_small"]
        );
        assert_eq!(result.unlisted, vec!["b_mid", "c_big"]);
    }

    #[test]
    fn keeps_abbreviations_inside_the_first_sentence() {
        assert_eq!(
            summary_of("Find files by glob (e.g. `**/*.ts`). Skips .git.", 160),
            "Find files by glob (e.g. `**/*.ts`)."
        );
        assert_eq!(summary_of("One.\nTwo.", 160), "One.");
        assert_eq!(
            summary_of(&"x".repeat(200), 10),
            format!("{}…", "x".repeat(9))
        );
    }
}
