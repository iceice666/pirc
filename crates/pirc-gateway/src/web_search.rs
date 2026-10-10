//! Web search for agents (`web.search`; `apps/gateway/src/daemon/web-search.ts`),
//! run by the gateway so the search API key never reaches a node, where an
//! agent's shell could read it. Backed by Exa
//! (https://exa.ai/docs/search/quickstart): each result is a title, URL and
//! query-relevant highlights; agents read whole pages with `web_fetch`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::error::{ApiError, ApiResult};
use crate::util::now_ms;

pub const WEB_SEARCH_MAX_RESULTS: u32 = 10;
const DEFAULT_RESULTS: u32 = 5;
/// Highlight characters Exa returns per result.
const HIGHLIGHT_CHARS: usize = 1500;
const TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_TTL_MS: i64 = 15 * 60_000;
const CACHE_LIMIT: usize = 100;
const EXA_URL: &str = "https://api.exa.ai/search";

/// A parsed `web.*` operation.
pub enum Op {
    Search(SearchArgs),
}

/// `webSearchArgs`, parsed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SearchArgs {
    /// Trimmed.
    pub query: String,
    pub count: Option<u32>,
    pub include_domains: Option<Vec<String>>,
    pub exclude_domains: Option<Vec<String>>,
    pub published_after: Option<String>,
    pub published_before: Option<String>,
    pub category: Option<String>,
}

/// `None`: not a `web.*` operation this module knows; `Some(Err(()))`:
/// invalid arguments.
pub fn parse_op(op: &str, args: &Value) -> Option<Result<Op, ()>> {
    match op {
        "web.search" => Some(parse_args(args).map(Op::Search)),
        _ => None,
    }
}

pub async fn run_op(app: &AppState, _context: &OpContext, op: Op) -> ApiResult<Value> {
    match op {
        Op::Search(args) => {
            let (results, cached) = searcher(app).search(&args).await?;
            Ok(json!({ "results": results, "cached": cached }))
        }
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `max` UTF-16 units (`text.slice(0, max)`).
fn utf16_prefix(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(pirc_config::js_space)
}

/// `/^(?:\*\.)?[a-zA-Z0-9.-]+(?:\/[^\s]*)?$/`
fn domain_shape(text: &str) -> bool {
    let rest = text.strip_prefix("*.").unwrap_or(text);
    let host_end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    if host_end == 0 {
        return false;
    }
    let path = &rest[host_end..];
    path.is_empty() || (path.starts_with('/') && !path.chars().any(pirc_config::js_space))
}

/// `/^\d{4}-\d{2}-\d{2}$/`
fn date_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn domains(value: &Value) -> Result<Vec<String>, ()> {
    let items = value.as_array().ok_or(())?;
    if !(1..=20).contains(&items.len()) {
        return Err(());
    }
    items
        .iter()
        .map(|item| match item.as_str() {
            Some(text) if (1..=253).contains(&utf16_len(text)) && domain_shape(text) => {
                Ok(text.to_owned())
            }
            _ => Err(()),
        })
        .collect()
}

fn date(value: &Value) -> Result<String, ()> {
    match value.as_str() {
        Some(text) if date_shape(text) => Ok(text.to_owned()),
        _ => Err(()),
    }
}

/// `webSearchArgs.safeParse`: a strict object; `.optional()` fields may be
/// absent but not `null`.
pub fn parse_args(args: &Value) -> Result<SearchArgs, ()> {
    let object = args.as_object().ok_or(())?;
    let mut parsed = SearchArgs::default();
    let mut query = None;
    for (key, value) in object {
        match key.as_str() {
            "query" => {
                let text = js_trim(value.as_str().ok_or(())?);
                if !(1..=500).contains(&utf16_len(text)) {
                    return Err(());
                }
                query = Some(text.to_owned());
            }
            "count" => {
                let count = value.as_f64().ok_or(())?;
                if count.fract() != 0.0
                    || !(1.0..=f64::from(WEB_SEARCH_MAX_RESULTS)).contains(&count)
                {
                    return Err(());
                }
                parsed.count = Some(count as u32);
            }
            "includeDomains" => parsed.include_domains = Some(domains(value)?),
            "excludeDomains" => parsed.exclude_domains = Some(domains(value)?),
            "publishedAfter" => parsed.published_after = Some(date(value)?),
            "publishedBefore" => parsed.published_before = Some(date(value)?),
            "category" => match value.as_str() {
                Some(category @ ("news" | "publication")) => {
                    parsed.category = Some(category.to_owned());
                }
                _ => return Err(()),
            },
            _ => return Err(()),
        }
    }
    parsed.query = query.ok_or(())?;
    // "Use includeDomains or excludeDomains, not both"
    if parsed.include_domains.is_some() && parsed.exclude_domains.is_some() {
        return Err(());
    }
    Ok(parsed)
}

/// One search per `App`, with its key and cache (`WebSearch`).
fn searcher(app: &App) -> Arc<WebSearch> {
    app.slots
        .get_or_init(|| WebSearch::new(app.config.exa_api_key.clone()))
}

struct Cached {
    at: i64,
    results: Vec<Value>,
}

/// The search client with its 15-minute cache of answers.
pub struct WebSearch {
    api_key: Option<String>,
    url: String,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    cache: Mutex<IndexMap<String, Cached>>,
    client: reqwest::Client,
}

impl WebSearch {
    pub fn new(api_key: Option<String>) -> Self {
        Self::with(api_key, EXA_URL.to_owned(), Box::new(now_ms))
    }

    /// Another search service URL and clock (tests).
    fn with(api_key: Option<String>, url: String, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        // ring, not aws-lc (as pirc-providers).
        let _ = rustls::crypto::ring::default_provider().install_default();
        // Direct connections, as Node's fetch made them (no proxy variables).
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client builds with the ring provider installed");
        Self {
            api_key: api_key.filter(|key| !key.is_empty()),
            url,
            now,
            cache: Mutex::new(IndexMap::new()),
            client,
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, IndexMap<String, Cached>> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The results and whether they came from the cache.
    pub async fn search(&self, args: &SearchArgs) -> ApiResult<(Vec<Value>, bool)> {
        let Some(api_key) = &self.api_key else {
            return Err(ApiError::new(
                503,
                "runner_unavailable",
                "Web search is not configured on the gateway (set EXA_API_KEY)",
            ));
        };
        let count = args.count.unwrap_or(DEFAULT_RESULTS);
        let key = json!({
            "query": args.query.to_lowercase(),
            "count": count,
            "includeDomains": args.include_domains,
            "excludeDomains": args.exclude_domains,
            "publishedAfter": args.published_after,
            "publishedBefore": args.published_before,
            "category": args.category,
        })
        .to_string();
        {
            let mut cache = self.cache();
            if let Some(hit) = cache.get(&key) {
                if (self.now)() - hit.at < CACHE_TTL_MS {
                    return Ok((hit.results.clone(), true));
                }
                cache.shift_remove(&key);
            }
        }

        let mut body = Map::new();
        body.insert("query".into(), json!(args.query));
        body.insert("type".into(), json!("auto"));
        body.insert("numResults".into(), json!(count));
        body.insert(
            "contents".into(),
            json!({ "highlights": { "maxCharacters": HIGHLIGHT_CHARS } }),
        );
        if let Some(domains) = &args.include_domains {
            body.insert("includeDomains".into(), json!(domains));
        }
        if let Some(domains) = &args.exclude_domains {
            body.insert("excludeDomains".into(), json!(domains));
        }
        if let Some(after) = &args.published_after {
            body.insert(
                "startPublishedDate".into(),
                json!(format!("{after}T00:00:00.000Z")),
            );
        }
        if let Some(before) = &args.published_before {
            body.insert(
                "endPublishedDate".into(),
                json!(format!("{before}T23:59:59.999Z")),
            );
        }
        if let Some(category) = &args.category {
            body.insert("category".into(), json!(category));
        }
        let response = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("x-api-key", api_key)
            .body(Value::Object(body).to_string())
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                ApiError::new(
                    504,
                    "node_timeout",
                    if error.is_timeout() {
                        "Web search timed out"
                    } else {
                        "Web search could not reach the search service"
                    },
                )
            })?;
        let status = response.status().as_u16();
        // `redirect: 'error'`: fetch fails on a redirect it would follow.
        if matches!(status, 301 | 302 | 303 | 307 | 308)
            && response.headers().contains_key("location")
        {
            return Err(ApiError::new(
                504,
                "node_timeout",
                "Web search could not reach the search service",
            ));
        }
        // Never reflect upstream bodies: they may echo request headers.
        if !(200..300).contains(&status) {
            drop(response);
            return Err(match status {
                400 | 422 => ApiError::new(
                    400,
                    "invalid_input",
                    "The search service rejected these search options",
                ),
                401 | 403 => {
                    ApiError::new(502, "node_error", "The gateway web search key was rejected")
                }
                429 | 402 => ApiError::new(
                    429,
                    "too_many_requests",
                    "Web search rate limit or credit exceeded",
                ),
                _ => ApiError::new(
                    502,
                    "node_error",
                    format!("The search service failed (HTTP {status})"),
                ),
            });
        }
        let unexpected = || {
            ApiError::new(
                502,
                "node_error",
                "The search service returned an unexpected answer",
            )
        };
        let bytes = response.bytes().await.map_err(|_| unexpected())?;
        let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| unexpected())?;
        let items = exa_results(&parsed).ok_or_else(unexpected)?;
        let results: Vec<Value> = items
            .into_iter()
            .take(count as usize)
            .filter_map(shape_result)
            .collect();
        let mut cache = self.cache();
        cache.insert(
            key,
            Cached {
                at: (self.now)(),
                results: results.clone(),
            },
        );
        while cache.len() > CACHE_LIMIT {
            cache.shift_remove_index(0);
        }
        Ok((results, false))
    }
}

/// One Exa result (`exaResponse`'s item).
struct ExaResult<'a> {
    url: &'a str,
    title: Option<&'a str>,
    published_date: Option<&'a str>,
    author: Option<&'a str>,
    highlights: Vec<&'a str>,
}

/// `exaResponse.parse`: `None` when the answer does not have its shape.
fn exa_results(body: &Value) -> Option<Vec<ExaResult<'_>>> {
    // `.nullish()`: absent, null or a string.
    fn nullish<'a>(item: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, ()> {
        match item.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text)),
            Some(_) => Err(()),
        }
    }
    let items = body.as_object()?.get("results")?.as_array()?;
    items
        .iter()
        .map(|item| {
            let item = item.as_object()?;
            let highlights = match item.get("highlights") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(texts)) => texts
                    .iter()
                    .map(Value::as_str)
                    .collect::<Option<Vec<_>>>()?,
                Some(_) => return None,
            };
            Some(ExaResult {
                url: item.get("url")?.as_str()?,
                title: nullish(item, "title").ok()?,
                published_date: nullish(item, "publishedDate").ok()?,
                author: nullish(item, "author").ok()?,
                highlights,
            })
        })
        .collect()
}

/// `httpUrl`: the normalized URL if it is http(s), at most 2048 characters.
fn http_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| utf16_prefix(url.as_str(), 2048))
}

/// A result as agents see it; `None` for URLs that are not http(s).
fn shape_result(item: ExaResult<'_>) -> Option<Value> {
    let url = http_url(item.url)?;
    let mut result = Map::new();
    let title = utf16_prefix(js_trim(item.title.unwrap_or_default()), 300);
    result.insert(
        "title".into(),
        json!(if title.is_empty() { url.clone() } else { title }),
    );
    result.insert("url".into(), json!(url));
    if let Some(published) = item.published_date.map(|date| utf16_prefix(date, 10))
        && date_shape(&published)
    {
        result.insert("published".into(), json!(published));
    }
    if let Some(author) = item.author.map(js_trim).filter(|author| !author.is_empty()) {
        result.insert("author".into(), json!(utf16_prefix(author, 200)));
    }
    let highlights: Vec<String> = item
        .highlights
        .into_iter()
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .take(5)
        .map(|text| utf16_prefix(text, HIGHLIGHT_CHARS))
        .collect();
    result.insert("highlights".into(), json!(highlights));
    Some(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;

    use super::*;

    type Calls = Arc<Mutex<Vec<(HeaderMap, Value)>>>;
    type Replies = Arc<Mutex<Vec<(u16, Value)>>>;

    /// A fake search service answering with `replies` in order.
    async fn fake_exa(replies: Vec<(u16, Value)>) -> (String, Calls) {
        let calls: Calls = Arc::default();
        let replies: Replies = Arc::new(Mutex::new(replies));
        async fn handle(
            State((calls, replies)): State<(Calls, Replies)>,
            headers: HeaderMap,
            body: String,
        ) -> axum::response::Response {
            calls
                .lock()
                .unwrap()
                .push((headers, serde_json::from_str(&body).unwrap()));
            let (status, body) = replies.lock().unwrap().remove(0);
            (StatusCode::from_u16(status).unwrap(), body.to_string()).into_response()
        }
        let app = Router::new()
            .route("/search", post(handle))
            .with_state((calls.clone(), replies));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/search", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (url, calls)
    }

    fn exa_results() -> Value {
        json!({
            "results": [
                {
                    "url": "https://bun.sh/docs",
                    "title": "Bun docs",
                    "publishedDate": "2026-09-01T00:00:00.000Z",
                    "author": "Oven",
                    "highlights": ["  Bun is a fast runtime.  ", ""],
                },
                { "url": "javascript:alert(1)", "title": "bad" },
                { "url": "https://example.com/x", "title": null, "highlights": null },
            ],
            "costDollars": { "total": 0.007 },
        })
    }

    fn args(value: Value) -> SearchArgs {
        parse_args(&value).expect("valid arguments")
    }

    #[tokio::test]
    async fn sends_the_key_only_to_exa_and_normalizes_results() {
        let (url, calls) = fake_exa(vec![(200, exa_results())]).await;
        let search = WebSearch::with(Some("exa-key".into()), url, Box::new(now_ms));
        let answer = search
            .search(&args(json!({
                "query": "bun runtime", "count": 3, "includeDomains": ["bun.sh"],
                "publishedAfter": "2026-01-01", "category": "news",
            })))
            .await
            .unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0["x-api-key"], "exa-key");
        assert_eq!(
            calls[0].1.to_string(),
            json!({
                "query": "bun runtime", "type": "auto", "numResults": 3,
                "contents": { "highlights": { "maxCharacters": 1500 } },
                "includeDomains": ["bun.sh"],
                "startPublishedDate": "2026-01-01T00:00:00.000Z",
                "category": "news",
            })
            .to_string()
        );
        assert_eq!(
            json!({ "results": answer.0, "cached": answer.1 }),
            json!({
                "cached": false,
                "results": [
                    { "title": "Bun docs", "url": "https://bun.sh/docs", "published": "2026-09-01",
                        "author": "Oven", "highlights": ["Bun is a fast runtime."] },
                    { "title": "https://example.com/x", "url": "https://example.com/x",
                        "highlights": [] },
                ],
            })
        );
    }

    #[tokio::test]
    async fn caches_identical_searches_for_a_while() {
        let (url, calls) =
            fake_exa(vec![(200, exa_results()), (200, json!({ "results": [] }))]).await;
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = now.clone();
        let search = WebSearch::with(
            Some("k".into()),
            url,
            Box::new(move || clock.load(Ordering::Relaxed)),
        );
        search
            .search(&args(json!({ "query": "Bun" })))
            .await
            .unwrap();
        let again = search
            .search(&args(json!({ "query": "bun" })))
            .await
            .unwrap();
        assert!(again.1);
        assert_eq!(calls.lock().unwrap().len(), 1);
        now.fetch_add(16 * 60_000, Ordering::Relaxed);
        let fresh = search
            .search(&args(json!({ "query": "bun" })))
            .await
            .unwrap();
        assert_eq!(fresh, (vec![], false));
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn never_reflects_upstream_error_bodies() {
        let (url, _) = fake_exa(vec![
            (401, json!({ "error": "bad key exa-key" })),
            (429, json!({})),
            (500, json!({})),
            (200, json!({ "x": 1 })),
            (422, json!({})),
        ])
        .await;
        let search = WebSearch::with(Some("exa-key".into()), url, Box::new(now_ms));
        let fail = |query: &'static str| {
            let search = &search;
            async move {
                search
                    .search(&args(json!({ "query": query })))
                    .await
                    .unwrap_err()
            }
        };
        let unauthorized = fail("a").await;
        assert!(!unauthorized.message.contains("exa-key"));
        assert_eq!(unauthorized.status, 502);
        assert_eq!(fail("b").await.code, "too_many_requests");
        assert!(fail("c").await.message.contains("HTTP 500"));
        assert!(fail("d").await.message.contains("unexpected answer"));
        assert_eq!(fail("e").await.code, "invalid_input");
    }

    #[tokio::test]
    async fn is_off_without_a_key() {
        let search = WebSearch::with(None, "http://127.0.0.1:9/search".into(), Box::new(now_ms));
        assert!(search.api_key.is_none());
        let error = search
            .search(&args(json!({ "query": "x" })))
            .await
            .unwrap_err();
        assert_eq!(error.status, 503);
        assert!(error.message.contains("EXA_API_KEY"));
    }

    #[tokio::test]
    async fn unreachable_service() {
        let search = WebSearch::with(
            Some("k".into()),
            "http://127.0.0.1:9/search".into(),
            Box::new(now_ms),
        );
        let error = search
            .search(&args(json!({ "query": "x" })))
            .await
            .unwrap_err();
        assert_eq!(
            (error.status, error.message.as_str()),
            (504, "Web search could not reach the search service")
        );
    }

    #[test]
    fn validates_arguments() {
        let ok = |value: Value| parse_args(&value).is_ok();
        assert!(!ok(json!({ "query": " " })));
        assert!(!ok(json!({ "query": "x", "count": 11 })));
        assert!(!ok(json!({ "query": "x", "count": 1.5 })));
        assert!(ok(json!({ "query": "x", "count": 2.0 })));
        assert!(!ok(json!({ "query": "x", "publishedAfter": "yesterday" })));
        assert!(!ok(
            json!({ "query": "x", "includeDomains": ["a.com"], "excludeDomains": ["b.com"] })
        ));
        assert!(ok(
            json!({ "query": "x", "includeDomains": ["*.a.com/docs"] })
        ));
        assert!(!ok(
            json!({ "query": "x", "includeDomains": ["a.com/a b"] })
        ));
        assert!(!ok(json!({ "query": "x", "includeDomains": ["*."] })));
        assert!(!ok(json!({ "query": "x", "includeDomains": [] })));
        assert!(!ok(json!({ "query": "x", "category": "blog" })));
        assert!(!ok(json!({ "query": "x", "count": null })));
        assert!(!ok(json!({ "query": "x", "extra": 1 })));
        assert!(!ok(json!([])));
        assert_eq!(args(json!({ "query": "  bun\n" })).query, "bun");
    }
}
