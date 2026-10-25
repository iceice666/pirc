//! Uses only the standalone crate's public API and JSON metadata.
use pirc_tool_schema::{
    Block, compact_signature_of, fit_signatures, signature_of, summary_of, ts_type, validate_schema,
};
use serde_json::{Value, json};

fn errors(value: Value, schema: Value) -> Vec<String> {
    validate_schema(&value, schema.as_object().unwrap())
}

#[test]
fn consumer_validates_and_documents_without_an_agent() {
    let input = json!({
        "type": "object", "properties": {
            "query": {"type": "string", "minLength": 1, "description": "Search text. More detail."}
        }, "required": ["query"], "additionalProperties": false
    });
    let parameters = input.as_object().unwrap();
    let result =
        json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]});
    assert!(validate_schema(&json!({"query": "hello"}), parameters).is_empty());
    assert_eq!(
        validate_schema(&json!({}), parameters),
        ["query is required"]
    );
    assert_eq!(
        signature_of(
            "api.search",
            parameters,
            &result,
            "Search records. More detail."
        ),
        "`api.search(args: { query: string }): { text: string }`\n  Search records. (query: Search text.)"
    );
    assert_eq!(
        compact_signature_of("search", parameters, "Search records."),
        "`search(args: { query: string })` — Search records."
    );
    assert_eq!(
        compact_signature_of(
            "noop",
            json!({"type": "object", "additionalProperties": false})
                .as_object()
                .unwrap(),
            "Do nothing."
        ),
        "`noop()` — Do nothing."
    );
    assert_eq!(ts_type(&result, 0), "{ text: string }");
}

#[test]
fn patterns_are_ecmascript_unicode_not_rust_regex() {
    for (pattern, value) in [
        (r"(?<=a)b", "ab"),
        (r"^(a)\1$", "aa"),
        (r"^\p{Letter}+$", "é"),
        (r"^.$", "😀"),
    ] {
        assert!(
            errors(json!(value), json!({"pattern": pattern})).is_empty(),
            "{pattern}"
        );
    }
    assert_eq!(
        errors(json!("a"), json!({"pattern": "["})),
        [" has an unusable pattern in its schema"]
    );
    assert_eq!(
        errors(json!("b"), json!({"pattern": "^a$"})),
        [" must match ^a$"]
    );
    assert!(errors(json!("😀"), json!({"minLength": 1, "maxLength": 1})).is_empty());
}

#[test]
fn compatibility_subset_is_intentionally_not_full_json_schema() {
    assert!(
        errors(
            json!(null),
            json!({"$ref": "#/missing", "allOf": [false], "not": {}, "format": "email"})
        )
        .is_empty()
    );
    // Non-object schemas and array-shaped schemas impose no constraints.
    assert!(errors(json!({"x": 1}), json!({"properties": {"x": false}})).is_empty());
    assert!(errors(json!([1]), json!({"items": []})).is_empty());
    // Object.is compatibility: compound enum/const values do not deep-compare.
    assert_eq!(errors(json!({}), json!({"const": {}})), [" must be {}"]);
    assert_eq!(
        errors(json!([]), json!({"enum": [[]]})),
        ["arguments must be one of [[]]"]
    );
    assert_eq!(errors(json!(-0.0), json!({"const": 0})), [" must be 0"]);
    assert!(errors(json!(2.0), json!({"type": "integer"})).is_empty());
    assert_eq!(
        errors(json!(1), json!({"oneOf": [{}, {}]})),
        ["value matches 2 of the oneOf alternatives"]
    );
    assert_eq!(
        errors(json!(1), json!({"anyOf": []})),
        ["value matches 0 of the anyOf alternatives"]
    );
    assert!(
        errors(
            json!({"x": 1}),
            json!({"additionalProperties": {"type": "integer"}})
        )
        .is_empty()
    );
    assert_eq!(
        errors(
            json!({"x": false}),
            json!({"additionalProperties": {"type": "integer"}})
        ),
        ["x must be integer, got boolean"]
    );
}

#[test]
fn documentation_budgets_count_utf16_and_do_not_split_a_scalar() {
    assert_eq!(summary_of("\u{feff} 😀abc", 2), "…");
    assert_eq!(summary_of("\u{feff} 😀abc", 3), "😀…");
    let blocks = [Block {
        name: "emoji".into(),
        block: "😀".into(),
    }];
    assert_eq!(fit_signatures(&blocks, &[], 2).unlisted, ["emoji"]);
    assert_eq!(fit_signatures(&blocks, &[], 3).core_listed, ["😀"]);
}
