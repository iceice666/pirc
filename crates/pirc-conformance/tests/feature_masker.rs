//! Stable feature snapshots even when random ids contain timestamp-shaped digits.
mod feature_support;

use feature_support::Masker;
use pirc_conformance::Normalizer;
use serde_json::json;

#[test]
fn timestamp_shaped_digits_do_not_corrupt_random_session_ids() {
    for id in ["1793089802517fd7", "abc1793089802517", "a1793089802517bc"] {
        let input = json!({"sessionId": id, "reference": format!("session {id}")});
        let masked = Masker::new().mask(input.clone());
        assert_eq!(
            masked, input,
            "session id {id} must survive feature masking"
        );
        assert_eq!(
            Normalizer::default().value(&masked),
            json!({"sessionId": "<hex16:1>", "reference": "session <hex16:1>"})
        );
    }
}

#[test]
fn timestamps_are_masked_in_script_json_but_not_inside_identifiers() {
    let mut masker = Masker::new();
    let script = json!({"text": r#"{"at":1793089802517,"times":[1793089802518, 1793089802519]}"#});
    assert_eq!(
        masker.mask(script),
        json!({"text": r#"{"at":<epoch-ms>,"times":[<epoch-ms>, <epoch-ms>]}"#})
    );
    for text in [
        "id_1793089802517",
        "1793089802517_suffix",
        "prefix1793089802517",
        "1793089802517suffix",
        "-1793089802517",
        "17930898025170",
        "1499999999999",
        "2500000000001",
    ] {
        assert_eq!(masker.mask(json!(text)), json!(text));
    }
}
