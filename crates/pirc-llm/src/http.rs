//! Request plumbing shared by the transports.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

/// Header names are case-insensitive; a later value replaces an earlier one
/// (the merge order of the TS code).
#[derive(Clone, Default)]
pub struct Headers(Vec<(String, String)>);

/// Debug output shows names only: values carry keys and tokens.
impl std::fmt::Debug for Headers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.0.iter().map(|(name, _)| name))
            .finish()
    }
}

impl Headers {
    pub fn set(&mut self, name: &str, value: &str) {
        match self
            .0
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
        {
            Some(entry) => entry.1 = value.to_owned(),
            None => self.0.push((name.to_owned(), value.to_owned())),
        }
    }

    #[cfg(any(
        test,
        any(
            feature = "anthropic-messages",
            feature = "openai-completions",
            feature = "openai-responses"
        )
    ))]
    pub fn remove(&mut self, name: &str) {
        self.0
            .retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
    }

    #[cfg(test)]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// `None` when a name or value is not valid HTTP (fetch throws then).
    pub fn to_map(&self) -> Option<HeaderMap> {
        let mut map = HeaderMap::with_capacity(self.0.len());
        for (name, value) in &self.0 {
            let name = HeaderName::from_bytes(name.as_bytes()).ok()?;
            // `fetch` strips leading and trailing HTTP white space.
            let value = value.trim_matches([' ', '\t', '\r', '\n']);
            let value = HeaderValue::from_str(value).ok()?;
            map.insert(name, value);
        }
        Some(map)
    }
}

/// Whether `url` is one of OpenCode's hosted inference endpoints: Zen and Go,
/// under either the legacy `/zen/...` or the current `/inference/...` paths.
pub fn is_opencode_endpoint(url: &reqwest::Url) -> bool {
    let path = url.path();
    url.host_str() == Some("opencode.ai")
        && ["/zen", "/inference"].iter().any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
}

/// Routing headers for OpenCode Zen and Go (`x-opencode-session` plus a
/// product User-Agent), by flag or by their well-known endpoints. The flag
/// keeps its historical `opencodeGo` name in configuration.
pub fn opencode_headers(
    opencode_go: Option<bool>,
    base_url: &str,
    session_id: &str,
) -> Result<Vec<(&'static str, String)>, ()> {
    let url = reqwest::Url::parse(base_url).map_err(|_| ())?;
    let enabled = opencode_go == Some(true) || is_opencode_endpoint(&url);
    Ok(if enabled {
        vec![
            ("x-opencode-session", session_id.to_owned()),
            ("user-agent", format!("pirc/{}", env!("CARGO_PKG_VERSION"))),
        ]
    } else {
        Vec::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_case_insensitively() {
        let mut headers = Headers::default();
        headers.set("Authorization", "a");
        headers.set("authorization", "b");
        headers.set("X-One", "1");
        assert_eq!(headers.get("AUTHORIZATION"), Some("b"));
        headers.remove("x-one");
        assert_eq!(headers.to_map().unwrap().len(), 1);
        headers.set("bad\nname", "x");
        assert!(headers.to_map().is_none());
    }

    #[test]
    fn detects_opencode_endpoints() {
        let on = |url: &str, flag| !opencode_headers(flag, url, "s").unwrap().is_empty();
        assert!(on("https://opencode.ai/zen/go/v1", None));
        assert!(on("https://OPENCODE.ai/zen/go", None));
        assert!(on("https://opencode.ai/zen/v1", None));
        assert!(on("https://opencode.ai/zen", None));
        assert!(on("https://opencode.ai/inference/openai/v1", None));
        assert!(on("https://opencode.ai/inference/anthropic", None));
        assert!(on("https://opencode.ai/inference/go/openai/v1/", None));
        assert!(on("https://opencode.ai/inference/go/anthropic", None));
        assert!(!on("https://opencode.ai/zenith/v1", None));
        assert!(!on("https://opencode.ai/inferences", None));
        assert!(!on("https://opencode.ai/docs/go", None));
        assert!(!on("https://api.opencode.ai.example/zen/v1", None));
        assert!(on("https://proxy.example/v1", Some(true)));
        assert!(!on("https://proxy.example/v1", Some(false)));
        assert!(opencode_headers(None, "not a url", "s").is_err());
    }
}
