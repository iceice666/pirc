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
//! Matching follows find-my-way as Fastify configures it: the method and
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

    /// The query as an object of strings (what zod saw as `request.query`;
    /// a repeated key keeps its first value).
    pub fn query_object(&self) -> Value {
        let mut object = Map::new();
        for (key, value) in &self.query {
            object
                .entry(key.clone())
                .or_insert_with(|| Value::String(value.clone()));
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

    /// The route for `method` and `path` (no query), with its parameters.
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
        let _ = (node, request);
        todo!("core: Fastify's request handling around Router::find")
    }
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
        assert_eq!(request.query_object(), serde_json::json!({ "a": "1" }));
        assert_eq!(request.json(), &Value::Null);
        assert_eq!(
            request.parse_body::<Map<String, Value>>(),
            Err(ApiError::invalid_input())
        );
    }
}
