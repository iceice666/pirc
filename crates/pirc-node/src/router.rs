//! The node's request router, replacing Fastify and `app.inject`
//! (`node/app.ts`, `node/runtime.ts` `handleRequest`, `http.ts`): the
//! gateway replays browser requests over the link as `request` frames, and
//! the node answers each with a `response` frame.
//!
//! Layout: the route table, matching and request/response types are
//! implemented here; [`Router::handle`] (owner: **core**) is the Fastify
//! behavior around them. Routes are registered by the module that owns them
//! and merged by core: `app::routes()` (core) and `panels::routes()`
//! (panels), so neither edits the other's file.
//!
//! Matching follows find-my-way as Fastify configures it: the path is
//! decoded first (`decode_uri`; a bad escape is a 400), then the method and
//! every `/`-separated segment must match, `:name` matches one non-empty
//! segment (percent-decoded into [`Request::params`]), a static segment wins
//! over a parameter at the first place they differ, and a trailing slash is
//! a different path. Methods are matched per route: a path known for
//! another method is still a 404.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pirc_protocol::{HttpMethod, NodeHttpRequest, NodeHttpResponse};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::services::Node;

/// A request body as the route sees it.
#[derive(Clone, Debug, PartialEq)]
pub enum Body {
    /// No body (`payload` and `bodyBase64` absent).
    None,
    /// `payload`: the JSON value the gateway relayed (Fastify parsed it as
    /// `application/json`).
    Json(Value),
    /// `bodyBase64` decoded, with its `contentType` (default
    /// `application/octet-stream`): uploads. Fastify's raw parsers gave a
    /// `Buffer` for images, octet-stream, `text/plain` and anything else.
    Raw {
        bytes: Vec<u8>,
        content_type: String,
    },
}

/// One relayed request, matched to a route.
#[derive(Clone, Debug)]
pub struct Request {
    pub method: HttpMethod,
    /// The path without the query, as relayed (still percent-encoded).
    pub path: String,
    /// The query, `application/x-www-form-urlencoded` decoded, in order.
    pub query: Vec<(String, String)>,
    /// The route's `:name` segments, percent-decoded.
    pub params: Vec<(String, String)>,
    /// The `x-pirc-user` the link set from the frame's `user`; the router
    /// has already checked it is one of the node's allowed users.
    pub user: String,
    pub body: Body,
}

impl Request {
    /// A `:name` parameter of the matched route.
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// The first value of a query parameter.
    pub fn query(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// The query as an object (what zod saw as `request.query`): strings,
    /// and an array of them for a repeated key, as Fastify's parser gave,
    /// so a single-value schema refuses it.
    pub fn query_object(&self) -> Value {
        let mut object = Map::new();
        for (key, value) in &self.query {
            let value = Value::String(value.clone());
            match object.get_mut(key) {
                None => {
                    object.insert(key.clone(), value);
                }
                Some(Value::Array(values)) => values.push(value),
                Some(first) => *first = Value::Array(vec![first.take(), value]),
            }
        }
        Value::Object(object)
    }

    /// The JSON body (`Null` when there is none or it is raw).
    pub fn json(&self) -> &Value {
        match &self.body {
            Body::Json(value) => value,
            Body::None | Body::Raw { .. } => &Value::Null,
        }
    }

    /// The JSON body as `T`, or 400 `invalid_input` (`parse(schema, body)`).
    pub fn parse_body<T: DeserializeOwned>(&self) -> ApiResult<T> {
        parse(self.json())
    }
}

/// `parse(schema, value)` from `util.ts`: `T` or 400 `invalid_input`
/// "Invalid request". Checks serde cannot express (lengths, patterns,
/// trimming) are the caller's, after this.
pub fn parse<T: DeserializeOwned>(value: &Value) -> ApiResult<T> {
    T::deserialize(value).map_err(|_| ApiError::invalid_input())
}

/// A route's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    /// `None`: an empty body (204), relayed as `body: null`.
    pub body: Option<Value>,
}

impl Response {
    /// 200 with a JSON body.
    pub fn json(body: Value) -> Self {
        Self::status(200, body)
    }

    pub fn status(status: u16, body: Value) -> Self {
        Self {
            status,
            body: Some(body),
        }
    }

    /// No body (`reply.status(204).send()`).
    pub fn empty(status: u16) -> Self {
        Self { status, body: None }
    }
}

pub type HandlerFuture = Pin<Box<dyn Future<Output = ApiResult<Response>> + Send>>;
pub type Handler = Arc<dyn Fn(Node, Request) -> HandlerFuture + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Segment {
    Static(&'static str),
    Param(&'static str),
}

/// A match's rank and parameters.
type Matched = (Vec<bool>, Vec<(String, String)>);

/// A method, a path pattern (`/api/sessions/:id/git/status`) and its handler.
#[derive(Clone)]
pub struct Route {
    pub method: HttpMethod,
    pub pattern: &'static str,
    segments: Vec<Segment>,
    handler: Handler,
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?} {}", self.method, self.pattern)
    }
}

impl Route {
    pub fn new<F, Fut>(method: HttpMethod, pattern: &'static str, handler: F) -> Self
    where
        F: Fn(Node, Request) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ApiResult<Response>> + Send + 'static,
    {
        assert!(
            pattern.starts_with('/'),
            "route {pattern} must start with /"
        );
        let segments = pattern[1..]
            .split('/')
            .map(|part| match part.strip_prefix(':') {
                Some(name) => Segment::Param(name),
                None => Segment::Static(part),
            })
            .collect();
        Self {
            method,
            pattern,
            segments,
            handler: Arc::new(move |node, request| Box::pin(handler(node, request))),
        }
    }

    /// The same segments, whatever the parameters are called.
    fn same_path(&self, other: &Route) -> bool {
        self.segments.len() == other.segments.len()
            && self
                .segments
                .iter()
                .zip(&other.segments)
                .all(|pair| match pair {
                    (Segment::Static(a), Segment::Static(b)) => a == b,
                    (Segment::Param(_), Segment::Param(_)) => true,
                    _ => false,
                })
    }

    /// Run the handler.
    pub fn call(&self, node: Node, request: Request) -> HandlerFuture {
        (self.handler)(node, request)
    }

    /// The decoded parameters when `path` (no query) matches, with the
    /// route's rank: `true` where a parameter matched, compared
    /// lexicographically (static first).
    fn matches(&self, path: &str) -> Option<Matched> {
        let parts: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
        if parts.len() != self.segments.len() {
            return None;
        }
        let mut rank = Vec::with_capacity(parts.len());
        let mut params = Vec::new();
        for (segment, part) in self.segments.iter().zip(parts) {
            match segment {
                Segment::Static(text) if *text == part => rank.push(false),
                Segment::Param(name) if !part.is_empty() => {
                    rank.push(true);
                    params.push(((*name).to_owned(), percent_decode(part)));
                }
                _ => return None,
            }
        }
        Some((rank, params))
    }
}

pub fn get<F, Fut>(pattern: &'static str, handler: F) -> Route
where
    F: Fn(Node, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ApiResult<Response>> + Send + 'static,
{
    Route::new(HttpMethod::Get, pattern, handler)
}

pub fn post<F, Fut>(pattern: &'static str, handler: F) -> Route
where
    F: Fn(Node, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ApiResult<Response>> + Send + 'static,
{
    Route::new(HttpMethod::Post, pattern, handler)
}

pub fn patch<F, Fut>(pattern: &'static str, handler: F) -> Route
where
    F: Fn(Node, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ApiResult<Response>> + Send + 'static,
{
    Route::new(HttpMethod::Patch, pattern, handler)
}

pub fn put<F, Fut>(pattern: &'static str, handler: F) -> Route
where
    F: Fn(Node, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ApiResult<Response>> + Send + 'static,
{
    Route::new(HttpMethod::Put, pattern, handler)
}

pub fn delete<F, Fut>(pattern: &'static str, handler: F) -> Route
where
    F: Fn(Node, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ApiResult<Response>> + Send + 'static,
{
    Route::new(HttpMethod::Delete, pattern, handler)
}

/// `%XX` decoding of a path segment (`decodeURIComponent`); a segment that
/// does not decode to UTF-8 is kept as it is.
fn percent_decode(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
        match (bytes[index], hex(index + 1), hex(index + 2)) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                index += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// find-my-way's `safeDecodeURI` of a path (no query): `decodeURI`, except
/// that `%25` stays too. Escapes of `# $ % & + , / : ; = ? @` stay as
/// written (a parameter decodes them, [`percent_decode`]; no static segment
/// holds them), others decode, so `/api/%73essions` is `/api/sessions`.
/// `None` when an escape is malformed or does not decode to UTF-8, where
/// `decodeURI` threw. (find-my-way calls `decodeURI` only when an escape
/// outside that set is present, but a malformed escape is always outside
/// it, so the outcome is the same.)
fn decode_uri(path: &str) -> Option<String> {
    if !path.contains('%') {
        return Some(path.to_owned());
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
        let byte = (hex(index + 1)? * 16 + hex(index + 2)?) as u8;
        if b"#$%&+,/:;=?@".contains(&byte) {
            out.extend_from_slice(&bytes[index..index + 3]);
        } else {
            out.push(byte);
        }
        index += 3;
    }
    String::from_utf8(out).ok()
}

/// The node's routes.
#[derive(Default)]
pub struct Router {
    routes: Vec<Route>,
}

impl Router {
    /// Panics on a method and pattern registered twice (a programming error).
    pub fn new(routes: impl IntoIterator<Item = Route>) -> Self {
        let routes: Vec<Route> = routes.into_iter().collect();
        for (index, route) in routes.iter().enumerate() {
            assert!(
                !routes[..index]
                    .iter()
                    .any(|other| other.method == route.method && other.same_path(route)),
                "route {route:?} is registered twice"
            );
        }
        Self { routes }
    }

    /// The route for `method` and `path` (no query, through [`decode_uri`]),
    /// with its parameters.
    pub fn find(&self, method: HttpMethod, path: &str) -> Option<(&Route, Vec<(String, String)>)> {
        self.routes
            .iter()
            .filter(|route| route.method == method)
            .filter_map(|route| {
                route
                    .matches(path)
                    .map(|(rank, params)| (rank, route, params))
            })
            .min_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, route, params)| (route, params))
    }

    /// Answer one relayed request as Fastify and `handleRequest` did
    /// (owner: **core**):
    ///
    /// - `url` is a path and query (the gateway checked `/api/` and 8192
    ///   bytes); split it, decode the query, and match. No route: 404 with
    ///   Fastify's body `{"message":"Route <METHOD>:<url> not found",
    ///   "error":"Not Found","statusCode":404}`.
    /// - The `onRequest` hook first: `user` must be in
    ///   `config.allowed_users`, else 403 `forbidden` "User is not allowed
    ///   on this node". Fastify runs app-level `onRequest` hooks for its
    ///   404 handler too, so this precedes the 404 (confirm on a TS
    ///   recording).
    /// - Body: `bodyBase64` gives [`Body::Raw`] (base64-decoded; larger than
    ///   `config.upload_max_bytes`: 413 [`ApiError::payload_too_large`]),
    ///   else `payload` gives [`Body::Json`].
    /// - Handler errors become `{status, body: error.body()}`; anything that
    ///   is not an [`ApiError`] (a panic in the handler task) is 500
    ///   [`ApiError::internal`], logged.
    /// - The response body is relayed as is; `None` becomes `body: null`
    ///   (`body = null` for an empty Fastify reply).
    pub async fn handle(&self, node: &Node, request: NodeHttpRequest) -> NodeHttpResponse {
        let (path, query) = match request.url.split_once('?') {
            Some((path, query)) => (path, Some(query)),
            None => (request.url.as_str(), None),
        };
        // find-my-way decodes the path first; a bad escape is Fastify's
        // `onBadUrl` answer, before any hook runs. Its message quotes the
        // whole url, query included.
        let Some(decoded) = decode_uri(path) else {
            return reply(
                400,
                Some(serde_json::json!({
                    "error": "Bad Request",
                    "code": "FST_ERR_BAD_URL",
                    "message": format!("'{}' is not a valid url component", request.url),
                    "statusCode": 400,
                })),
            );
        };
        let found = self.find(request.method, &decoded);
        // find-my-way refuses a parameter over 100 characters before any
        // hook runs, quoting the decoded path.
        if let Some((route, _)) = &found
            && route.param_too_long(&decoded)
        {
            return reply(
                414,
                Some(serde_json::json!({
                    "error": "Bad Request",
                    "code": "FST_ERR_MAX_PARAM_LENGTH",
                    "message": format!("'{decoded}' is exceeding the max param length"),
                    "statusCode": 414,
                })),
            );
        }
        // The `onRequest` hook, which Fastify runs for its 404 handler too.
        if !node.config.allowed_users.contains(&request.user) {
            return error_reply(&ApiError::forbidden("User is not allowed on this node"));
        }
        let Some((route, params)) = found else {
            return reply(
                404,
                Some(serde_json::json!({
                    "message": format!("Route {}:{} not found", method_name(request.method), request.url),
                    "error": "Not Found",
                    "statusCode": 404,
                })),
            );
        };
        let body = match request_body(&request, node.config.upload_max_bytes) {
            Ok(body) => body,
            Err(error) => return error_reply(&error),
        };
        let routed = Request {
            method: request.method,
            path: path.to_owned(),
            query: query
                .map(|query| {
                    url::form_urlencoded::parse(query.as_bytes())
                        .into_owned()
                        .collect()
                })
                .unwrap_or_default(),
            params,
            user: request.user,
            body,
        };
        // In a task of its own: a panic is a 500, not a lost response, and
        // the handler runs to its end as Fastify's did.
        match tokio::spawn(route.call(node.clone(), routed)).await {
            Ok(Ok(response)) => reply(response.status, response.body),
            Ok(Err(error)) => error_reply(&error),
            Err(error) => {
                crate::log::error(&format!(
                    "{} {path} failed: {error}",
                    method_name(request.method)
                ));
                error_reply(&ApiError::internal())
            }
        }
    }
}

impl Route {
    /// Whether a parameter segment of `path` (this route's, decoded) is
    /// over find-my-way's `maxParamLength` (100), which it compares with the
    /// decoded parameter's JS length (UTF-16 units).
    fn param_too_long(&self, path: &str) -> bool {
        path.strip_prefix('/').is_some_and(|rest| {
            self.segments
                .iter()
                .zip(rest.split('/'))
                .any(|(segment, part)| {
                    matches!(segment, Segment::Param(_))
                        && percent_decode(part).encode_utf16().count() > 100
                })
        })
    }
}

fn reply(status: u16, body: Option<Value>) -> NodeHttpResponse {
    NodeHttpResponse {
        status,
        // An empty reply is relayed as `body: null` (`handleRequest`).
        body: Some(body.unwrap_or(Value::Null)),
    }
}

fn error_reply(error: &ApiError) -> NodeHttpResponse {
    reply(error.status, Some(error.body()))
}

fn method_name(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Patch => "PATCH",
        HttpMethod::Put => "PUT",
        HttpMethod::Delete => "DELETE",
    }
}

/// The body as Fastify gave it to the route (`app.inject` with the frame's
/// `payload` or `bodyBase64`):
///
/// - GET bodies are never parsed.
/// - `payload` was injected as JSON, so it is JSON (`null` is no body).
/// - `bodyBase64` goes through the parser of its content type: JSON for
///   `application/json` (empty or invalid: Fastify's parser error, which the
///   node's error handler answers as 500), raw bytes for anything else.
/// - Over `limit` bytes: 413, Fastify's `bodyLimit`.
fn request_body(request: &NodeHttpRequest, limit: usize) -> ApiResult<Body> {
    if request.method == HttpMethod::Get {
        return Ok(Body::None);
    }
    if let Some(encoded) = &request.body_base64 {
        let bytes = decode_base64(encoded);
        if bytes.len() > limit {
            return Err(ApiError::payload_too_large());
        }
        let content_type = request
            .content_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let media = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if media == "application/json" {
            return serde_json::from_slice(&bytes)
                .map(Body::Json)
                .map_err(|_| ApiError::internal());
        }
        return Ok(Body::Raw {
            bytes,
            content_type,
        });
    }
    match &request.payload {
        None | Some(Value::Null) => Ok(Body::None),
        Some(value) => {
            if value.to_string().len() > limit {
                return Err(ApiError::payload_too_large());
            }
            Ok(Body::Json(value.clone()))
        }
    }
}

/// `Buffer.from(text, 'base64')`: lenient, as Node's decoder is. Both
/// alphabets are accepted, other characters skipped, and decoding stops at
/// the first `=`; a trailing lone character is dropped.
fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: HttpMethod, pattern: &'static str) -> Route {
        Route::new(method, pattern, |_, _| async { Ok(Response::empty(204)) })
    }

    #[test]
    fn matches_static_before_parameters() {
        let router = Router::new([
            route(HttpMethod::Get, "/api/sessions/:id/snapshot"),
            route(HttpMethod::Get, "/api/sessions/:id/git/status"),
            route(HttpMethod::Get, "/api/sessions/:id/git/commits/:sha"),
            route(HttpMethod::Get, "/api/workspaces/:id/instructions"),
            route(HttpMethod::Get, "/api/workspaces/chats/instructions"),
            route(HttpMethod::Post, "/api/sessions"),
            route(HttpMethod::Delete, "/api/sessions/:id"),
        ]);
        let found = |method, path| {
            router
                .find(method, path)
                .map(|(route, params)| (route.pattern, params))
        };
        assert_eq!(
            found(HttpMethod::Get, "/api/sessions/s%20x/git/commits/abcd"),
            Some((
                "/api/sessions/:id/git/commits/:sha",
                vec![
                    ("id".to_owned(), "s x".to_owned()),
                    ("sha".to_owned(), "abcd".to_owned())
                ]
            ))
        );
        assert_eq!(
            found(HttpMethod::Get, "/api/workspaces/chats/instructions").map(|f| f.0),
            Some("/api/workspaces/chats/instructions")
        );
        assert_eq!(
            found(HttpMethod::Get, "/api/workspaces/w/instructions").map(|f| f.0),
            Some("/api/workspaces/:id/instructions")
        );
        assert_eq!(found(HttpMethod::Get, "/api/sessions"), None);
        assert_eq!(found(HttpMethod::Get, "/api/sessions/s/snapshot/"), None);
        assert_eq!(found(HttpMethod::Get, "/api/sessions//snapshot"), None);
        assert_eq!(found(HttpMethod::Post, "/api/sessions/s/snapshot"), None);
        assert!(found(HttpMethod::Delete, "/api/sessions/s").is_some());
        assert_eq!(percent_decode("%E4%BD%A0%zz%"), "你%zz%");
        assert_eq!(percent_decode("%FF"), "%FF");
    }

    fn relayed(
        method: HttpMethod,
        payload: Option<Value>,
        raw: Option<(&str, Option<&str>)>,
    ) -> NodeHttpRequest {
        NodeHttpRequest {
            method,
            url: "/api/x".into(),
            user: "u".into(),
            payload,
            body_base64: raw.map(|(body, _)| body.to_owned()),
            content_type: raw.and_then(|(_, content_type)| content_type.map(str::to_owned)),
        }
    }

    #[test]
    fn bodies_as_fastify_parsed_them() {
        use serde_json::json;
        let body = |request: NodeHttpRequest| request_body(&request, 10);
        assert_eq!(
            body(relayed(HttpMethod::Post, Some(json!({ "a": 1 })), None)),
            Ok(Body::Json(json!({ "a": 1 })))
        );
        assert_eq!(body(relayed(HttpMethod::Post, None, None)), Ok(Body::None));
        assert_eq!(
            body(relayed(HttpMethod::Post, Some(Value::Null), None)),
            Ok(Body::None)
        );
        assert_eq!(
            body(relayed(HttpMethod::Get, Some(json!({ "a": 1 })), None)),
            Ok(Body::None)
        );
        assert_eq!(
            body(relayed(
                HttpMethod::Post,
                Some(json!({ "a": "0123456789" })),
                None
            )),
            Err(ApiError::payload_too_large())
        );
        assert_eq!(
            body(relayed(HttpMethod::Post, None, Some(("aGVsbG8K", None)))),
            Ok(Body::Raw {
                bytes: b"hello\n".to_vec(),
                content_type: "application/octet-stream".into()
            })
        );
        assert_eq!(
            body(relayed(
                HttpMethod::Post,
                None,
                Some(("e30=", Some("application/json; charset=utf-8")))
            )),
            Ok(Body::Json(json!({})))
        );
        for broken in ["", "eyJ3"] {
            assert_eq!(
                body(relayed(
                    HttpMethod::Post,
                    None,
                    Some((broken, Some("application/json")))
                )),
                Err(ApiError::internal())
            );
        }
        assert_eq!(
            body(relayed(
                HttpMethod::Post,
                None,
                Some(("aGVsbG8gd29ybGQ=", Some("text/plain")))
            )),
            Err(ApiError::payload_too_large())
        );
        assert_eq!(decode_base64("aGVs\nbG8"), b"hello");
        assert_eq!(decode_base64("_-8="), [0xff, 0xef]);
        assert_eq!(decode_base64("YQ==YQ"), b"a");
        assert_eq!(method_name(HttpMethod::Patch), "PATCH");
        let route = Route::new(HttpMethod::Get, "/api/sessions/:id", |_, _| async {
            Ok(Response::empty(204))
        });
        assert!(!route.param_too_long(&format!("/api/sessions/{}", "s".repeat(100))));
        assert!(route.param_too_long(&format!("/api/sessions/{}", "s".repeat(101))));
    }

    #[test]
    fn decodes_paths_as_find_my_way() {
        // Golden cases from Fastify 5.12.5 / find-my-way 9.9.0 `inject`.
        assert_eq!(
            decode_uri("/api/%73essions/x").as_deref(),
            Some("/api/sessions/x")
        );
        assert_eq!(
            decode_uri("/api/sessions/a%2Fb%25c%3f%40/s").as_deref(),
            Some("/api/sessions/a%2Fb%25c%3f%40/s")
        );
        assert_eq!(
            decode_uri("/api/sessions/%E4%BD%A0").as_deref(),
            Some("/api/sessions/你")
        );
        for bad in [
            "/api/sessions/%FF/snapshot",
            "/api/sessions/%zz/snapshot",
            "/api/sessions/a%/snapshot",
            "/api/sessions/a%4",
            "/api/sessions/%C3%2F",
            "/api/sessions/%C3a",
        ] {
            assert_eq!(decode_uri(bad), None, "{bad}");
        }
        let router = Router::new([
            route(HttpMethod::Get, "/api/sessions/:id/snapshot"),
            route(HttpMethod::Get, "/api/sessions/chats/snapshot"),
        ]);
        let found = |path: &str| {
            router
                .find(HttpMethod::Get, &decode_uri(path).unwrap())
                .map(|(route, params)| (route.pattern, params))
        };
        assert_eq!(
            found("/api/%73essions/x/snapshot"),
            Some((
                "/api/sessions/:id/snapshot",
                vec![("id".to_owned(), "x".to_owned())]
            ))
        );
        assert_eq!(
            found("/api/sessions/%63hats/snapshot").map(|f| f.0),
            Some("/api/sessions/chats/snapshot")
        );
        assert_eq!(
            found("/api/sessions/a%2Fb%25c%3f/snapshot").map(|f| f.1),
            Some(vec![("id".to_owned(), "a/b%c?".to_owned())])
        );
        assert_eq!(
            found("/api/sessions/%2541/snapshot").map(|f| f.1),
            Some(vec![("id".to_owned(), "%41".to_owned())])
        );
        // `maxParamLength` counts the decoded parameter's UTF-16 units.
        let route = &router.routes[0];
        let long = |count| {
            decode_uri(&format!(
                "/api/sessions/{}/snapshot",
                "%E4%BD%A0".repeat(count)
            ))
            .unwrap()
        };
        assert!(!route.param_too_long(&long(100)));
        assert!(route.param_too_long(&long(101)));
        assert!(!route.param_too_long(&format!("/api/sessions/{}/snapshot", "%2F".repeat(100))));
        assert!(route.param_too_long(&format!("/api/sessions/{}/snapshot", "%2F".repeat(101))));
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn refuses_duplicates() {
        Router::new([
            route(HttpMethod::Get, "/api/sessions/:id"),
            route(HttpMethod::Get, "/api/sessions/:other"),
        ]);
    }

    #[test]
    fn requests() {
        let request = Request {
            method: HttpMethod::Get,
            path: "/x".into(),
            query: vec![("a".into(), "1".into()), ("a".into(), "2".into())],
            params: vec![("id".into(), "s".into())],
            user: "u".into(),
            body: Body::None,
        };
        assert_eq!(request.param("id"), Some("s"));
        assert_eq!(request.query("a"), Some("1"));
        assert_eq!(
            request.query_object(),
            serde_json::json!({ "a": ["1", "2"] })
        );
        let three = Request {
            query: vec![
                ("a".into(), "1".into()),
                ("b".into(), "x".into()),
                ("a".into(), "2".into()),
                ("a".into(), "3".into()),
            ],
            ..request.clone()
        };
        assert_eq!(
            three.query_object(),
            serde_json::json!({ "a": ["1", "2", "3"], "b": "x" })
        );
        assert_eq!(request.json(), &Value::Null);
        assert_eq!(
            request.parse_body::<Map<String, Value>>(),
            Err(ApiError::invalid_input())
        );
    }
}
