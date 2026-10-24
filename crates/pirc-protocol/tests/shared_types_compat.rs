//! Compatibility of the original protocol imports and pirc-owned envelopes.
use pirc_protocol::{InferenceConfig, InferenceRequest, Models};
use serde::{Serialize, de::DeserializeOwned};

fn fixed<T: DeserializeOwned + Serialize>(bytes: &str) {
    let parsed: T = serde_json::from_str(bytes).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), bytes);
}

#[test]
fn legacy_imports_are_the_same_leaf_types() {
    // Both directions are checked at compile time; no conversions or DTO copies.
    macro_rules! identity {
        ($($name:ident),* $(,)?) => {$({
            let _: fn(pirc_protocol::$name) -> pirc_llm_types::$name = |v| v;
            let _: fn(pirc_llm_types::$name) -> pirc_protocol::$name = |v| v;
        })*};
    }
    identity!(
        AssistantContent,
        AssistantDelta,
        AssistantMessage,
        InferenceErrorCode,
        Message,
        Model,
        ModelApi,
        ModelRef,
        Provider,
        StopReason,
        ThinkingLevel,
        ToolChoice,
        ToolSpec,
        Usage,
        UserBlock,
        UserContent,
    );
}

#[test]
fn routing_request_keeps_exact_bytes_and_optionality() {
    fixed::<InferenceRequest>(
        r#"{"providerName":"p","modelId":"m","systemPrompt":"","messages":[],"tools":[],"thinking":"low","sessionId":"s"}"#,
    );
    fixed::<InferenceRequest>(
        r#"{"providerName":"p","modelId":"m","systemPrompt":"sys","messages":[{"role":"custom","customType":"note","content":"x","display":true,"details":null,"timestamp":1}],"tools":[{"name":"t","description":"d","parameters":{"z":{},"a":{}}}],"thinking":"off","sessionId":"s","maxTokens":10,"toolChoice":"none"}"#,
    );
    let nulls: InferenceRequest = serde_json::from_str(r#"{"providerName":"p","modelId":"m","systemPrompt":"","messages":[],"tools":[],"thinking":"low","sessionId":"s","maxTokens":null,"toolChoice":null}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&nulls).unwrap(),
        r#"{"providerName":"p","modelId":"m","systemPrompt":"","messages":[],"tools":[],"thinking":"low","sessionId":"s"}"#
    );
    assert!(serde_json::from_str::<InferenceRequest>(r#"{"providerName":"p","modelId":"m","systemPrompt":"","messages":[],"tools":[],"thinking":"low","sessionId":"s","extra":1}"#).is_err());
}

#[test]
fn model_catalog_socket_and_provider_order_are_unchanged() {
    fixed::<Models>(r#"{"providers":{}}"#);
    fixed::<Models>(
        r#"{"providers":{"z":{"api":"openai-chat","baseUrl":"z","headers":{},"compat":{},"models":[]},"a":{"api":"openai-responses","baseUrl":"a","headers":{},"compat":{},"models":[]}},"defaultModel":{"provider":"z","id":"m","thinking":"high"},"inference":{"socketPath":"/private/s","token":"secret"}}"#,
    );
    fixed::<InferenceConfig>(r#"{"socketPath":"/private/s","token":"secret"}"#);
    let catalog: Models =
        serde_json::from_str(r#"{"defaultModel":null,"inference":null}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&catalog).unwrap(),
        r#"{"providers":{}}"#
    );
}
