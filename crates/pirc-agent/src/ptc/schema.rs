//! Execution-time compatibility-subset validation shared with standalone consumers.

pub use pirc_tool_schema::validate_schema;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::js;
    use serde_json::{Value, json};

    // The reusable crate cannot depend on pirc-config. Exercise its private
    // compatibility helpers through the public API against the original ones.
    #[test]
    fn standalone_validation_text_matches_agent_helpers() {
        let values = [
            json!(null),
            json!(true),
            json!("quotes\"\n😀"),
            json!(2.0),
            json!(-0.0),
            json!(1e-7),
            json!(1e-6),
            json!(1e21),
            json!(18446744073709551615u64),
            json!([1.0, {"x": 1e21}]),
            json!({"b": 2.0, "a": [true, null]}),
        ];
        for value in values {
            let schema = json!({"const": value});
            assert_eq!(
                validate_schema(&json!("different"), schema.as_object().unwrap()),
                [format!(" must be {}", js::stringify(&value))]
            );
            let schema = json!({"required": [value]});
            assert_eq!(
                validate_schema(&json!({}), schema.as_object().unwrap()),
                [format!("{} is required", js::string_of(&value))]
            );
        }
        for bound in [json!(2.0), json!(1e21), json!(18446744073709551615u64)] {
            let schema = json!({"minimum": bound});
            assert_eq!(
                validate_schema(&json!(0), schema.as_object().unwrap()),
                [format!(
                    " must be >= {}",
                    js::number_text(bound.as_number().unwrap())
                )]
            );
        }
        let options = Value::Array(vec![json!("😀".repeat(150)), json!(1e21)]);
        let schema = json!({"enum": options});
        assert_eq!(
            validate_schema(&json!(false), schema.as_object().unwrap()),
            [format!(
                "arguments must be one of {}",
                js::head16(&js::stringify(&options), 200)
            )]
        );
    }
}
