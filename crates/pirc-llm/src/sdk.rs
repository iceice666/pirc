//! Private compatibility mechanics shared across wire APIs.
#[cfg(any(feature = "openai-completions", feature = "openai-responses"))]
use crate::js::{get, truthy};
use crate::pi::PiModel;
#[cfg(any(feature = "openai-completions", feature = "openai-responses"))]
use serde_json::Value;
#[cfg(any(feature = "openai-completions", feature = "openai-responses"))]
use std::time::Duration;
#[cfg(any(feature = "openai-completions", feature = "openai-responses"))]
pub(crate) const SDK_USER_AGENT: &str = "OpenAI/JS 6.26.0";
/// The SDK's default request timeout, which ends once headers arrive.
#[cfg(any(feature = "openai-completions", feature = "openai-responses"))]
pub(crate) const SDK_TIMEOUT: Duration = Duration::from_secs(600);

/// `resolveCloudflareBaseUrl`: placeholders from an explicit host lookup.
/// The pirc adapter supplies environment policy; standalone callers need not.
pub(crate) fn cloudflare_base_url(
    model: &PiModel,
    resolve: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<String, String> {
    let url = &model.base_url;
    let mut out = String::with_capacity(url.len());
    let mut rest = url.as_str();
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}');
        let name = close.map(|close| &after[..close]).filter(|name| {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
                && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        });
        match (name, close) {
            (Some(name), Some(close)) => {
                let value = resolve(name).filter(|v| !v.is_empty());
                let Some(value) = value else {
                    return Err(format!(
                        "{name} is required for provider {} but is not set.",
                        model.provider
                    ));
                };
                out.push_str(&value);
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// `APIError.makeMessage`.
#[cfg(any(feature = "openai-completions", feature = "openai-responses"))]
pub(crate) fn api_error_message(
    status: Option<u16>,
    error: Option<&Value>,
    message: Option<&str>,
) -> String {
    let error = error.filter(|e| !e.is_null());
    let msg = match error {
        Some(error) if truthy(get(Some(error), "message")) => match &error["message"] {
            Value::String(text) => Some(text.clone()),
            other => Some(other.to_string()),
        },
        Some(error) if truthy(Some(error)) => Some(error.to_string()),
        _ => message.map(str::to_owned),
    }
    .filter(|msg| !msg.is_empty());
    match (status, msg) {
        (Some(status), Some(msg)) => format!("{status} {msg}"),
        (Some(status), None) => format!("{status} status code (no body)"),
        (None, Some(msg)) => msg,
        (None, None) => "(no status code or body)".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn cloudflare_substitution_uses_only_the_explicit_lookup_in_wire_order() {
        let mut model = PiModel {
            id: "m".to_owned(),
            api: "openai-completions".to_owned(),
            provider: "cloudflare-ai-gateway".to_owned(),
            base_url: "https://gateway/{ACCOUNT}/{GATEWAY}/{lower}/{BROKEN".to_owned(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            headers: Default::default(),
            compat: Default::default(),
        };
        let calls = Mutex::new(Vec::new());
        let resolved = cloudflare_base_url(&model, &|name| {
            calls.lock().unwrap().push(name.to_owned());
            Some(format!("explicit-{name}"))
        })
        .unwrap();
        assert_eq!(
            resolved,
            "https://gateway/explicit-ACCOUNT/explicit-GATEWAY/{lower}/{BROKEN"
        );
        assert_eq!(*calls.lock().unwrap(), ["ACCOUNT", "GATEWAY"]);
        model.base_url = "https://gateway/{MISSING}".to_owned();
        let expected = "MISSING is required for provider cloudflare-ai-gateway but is not set.";
        assert_eq!(
            cloudflare_base_url(&model, &|_| None).unwrap_err(),
            expected
        );
        assert_eq!(
            cloudflare_base_url(&model, &|_| Some(String::new())).unwrap_err(),
            expected
        );
    }
}
