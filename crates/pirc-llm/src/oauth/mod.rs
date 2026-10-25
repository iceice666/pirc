//! pi-ai 0.73.1's subscription logins (`utils/oauth/{anthropic,openai-codex,
//! github-copilot,pkce,oauth-page}.js`): Anthropic and Codex authorization
//! code + PKCE with their fixed localhost callback servers (raced with a
//! pasted callback URL), GitHub Copilot's device flow and token minting, and
//! each provider's token refresh.
//!
//! The caller injects an HTTP client, endpoints and presentation hooks. No
//! credential persistence, browser opening or backend/catalog lookup occurs.
//! Calling a code-login future explicitly starts the configured local callback
//! listener; merely constructing endpoints or enabling this feature does not.
//! Drop the future to cancel HTTP/polling and close its listener/connections.
//! Error strings may contain provider data and must be masked before display.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use serde_json::Map;

/// Opaque credential DTO only. The caller owns validation, persistence,
/// account identity and safe error presentation; values may contain secrets.
pub type Credentials = Map<String, Value>;

/// Trim white space and a BOM (`js` is not built without `_transport`).
fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// `normalizeDomain`: the host name of a GitHub Enterprise domain or URL.
pub fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = trim(input);
    if trimmed.is_empty() {
        return None;
    }
    let url = if trimmed.contains("://") {
        reqwest::Url::parse(trimmed)
    } else {
        reqwest::Url::parse(&format!("https://{trimmed}"))
    }
    .ok()?;
    Some(url.host_str().unwrap_or_default().to_owned())
}

/// `getGitHubCopilotBaseUrl`: the API host from the token's `proxy-ep`,
/// else the enterprise or individual default.
pub fn copilot_base_url(token: Option<&str>, enterprise_domain: Option<&str>) -> String {
    if let Some(token) = token.filter(|token| !token.is_empty())
        && let Some(start) = token.find("proxy-ep=")
    {
        let host = &token[start + "proxy-ep=".len()..];
        let host = host.split(';').next().unwrap_or_default();
        if !host.is_empty() {
            let host = host
                .strip_prefix("proxy.")
                .map_or_else(|| host.to_owned(), |rest| format!("api.{rest}"));
            return format!("https://{host}");
        }
    }
    match enterprise_domain {
        Some(domain) if !domain.is_empty() => format!("https://copilot-api.{domain}"),
        _ => "https://api.individual.githubcopilot.com".to_owned(),
    }
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A question for the user (`onPrompt`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub message: String,
    pub placeholder: Option<String>,
    pub allow_empty: Option<bool>,
}

/// `OAuthLoginCallbacks`: how a login reaches the user.
pub trait LoginHooks: Send + Sync {
    /// The authorization page (and instructions); `Err` refuses it.
    fn on_auth(&self, url: &str, instructions: Option<&str>) -> Result<(), String>;
    fn on_progress(&self, text: &str);
    /// `onPrompt` (`?? ''` applied).
    fn prompt(&self, prompt: Prompt) -> BoxFuture<Result<String, String>>;
    /// `onManualCodeInput`: the pasted callback URL (`?? ''` applied).
    fn manual(&self) -> BoxFuture<Result<String, String>>;
}

/// Where the logins go. [`Endpoints::default`] is the real services; tests
/// point them at local servers.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub anthropic_authorize: String,
    pub anthropic_token: String,
    pub anthropic_callback_port: u16,
    pub codex_authorize: String,
    pub codex_token: String,
    pub codex_callback_port: u16,
    /// The callback servers' address (`PI_OAUTH_CALLBACK_HOST`, which the
    /// TS gateway set to 127.0.0.1).
    pub callback_host: String,
    /// Replaces `https://<domain>` and `https://api.<domain>` (as
    /// `<base>/api`) of GitHub's URLs.
    pub github_override: Option<String>,
    /// Replaces the Copilot API base the model policies are enabled at.
    pub copilot_api_override: Option<String>,
    /// The least device-flow polling interval (one second).
    pub poll_floor: Duration,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            anthropic_authorize: "https://claude.ai/oauth/authorize".to_owned(),
            anthropic_token: "https://platform.claude.com/v1/oauth/token".to_owned(),
            anthropic_callback_port: 53692,
            codex_authorize: "https://auth.openai.com/oauth/authorize".to_owned(),
            codex_token: "https://auth.openai.com/oauth/token".to_owned(),
            codex_callback_port: 1455,
            callback_host: "127.0.0.1".to_owned(),
            github_override: None,
            copilot_api_override: None,
            poll_floor: Duration::from_secs(1),
        }
    }
}

const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_SCOPE: &str = "openid profile email offline_access";
const CODEX_JWT_CLAIM: &str = "https://api.openai.com/auth";
const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const COPILOT_HEADERS: [(&str, &str); 4] = [
    ("User-Agent", "GitHubCopilotChat/0.35.0"),
    ("Editor-Version", "vscode/1.107.0"),
    ("Editor-Plugin-Version", "copilot-chat/0.35.0"),
    ("Copilot-Integration-Id", "vscode-chat"),
];
const FIVE_MINUTES_MS: f64 = 5.0 * 60.0 * 1000.0;

/// `generatePKCE`: a random verifier and its S256 challenge.
pub fn pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system random number generator");
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_page(title: &str, message: &str, details: Option<&str>) -> String {
    let details = details.map_or_else(String::new, |details| {
        format!("<div class=\"details\">{}</div>", escape_html(details))
    });
    include_str!("page.html")
        .replace("{{title}}", &escape_html(title))
        .replace("{{heading}}", &escape_html(title))
        .replace("{{message}}", &escape_html(message))
        .replace("{{details}}", &details)
}

/// `oauthSuccessHtml`.
pub fn success_html(message: &str) -> String {
    render_page("Authentication successful", message, None)
}

/// `oauthErrorHtml`.
pub fn error_html(message: &str, details: Option<&str>) -> String {
    render_page("Authentication failed", message, details)
}

/// What a callback server makes of one request: the reply and, for the
/// expected callback, the authorization code and state.
pub struct CallbackReply {
    pub status: u16,
    pub html: String,
    pub code: Option<(String, Option<String>)>,
}

/// A localhost callback server, stopped when dropped (`server.close()`).
pub struct CallbackServer {
    task: tokio::task::JoinHandle<()>,
    code: Option<oneshot::Receiver<(String, Option<String>)>>,
}

impl Drop for CallbackServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl CallbackServer {
    /// Listen on `host:port`; `handle` answers each request's URL.
    pub async fn start(
        host: &str,
        port: u16,
        handle: impl Fn(&reqwest::Url) -> CallbackReply + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        // A login cancelled just before (its server task is being aborted)
        // may still hold the fixed port for a moment.
        let mut attempts = 0;
        let listener = loop {
            match TcpListener::bind((host, port)).await {
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && attempts < 20 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                result => break result?,
            }
        };
        let (sender, receiver) = oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let handle = Arc::new(handle);
        let task = tokio::spawn(async move {
            // Connections are served concurrently (as Node's server did), at
            // most 16 at a time; they end with the server.
            let mut connections = tokio::task::JoinSet::new();
            loop {
                // At the cap, new connections wait in the listen backlog.
                if connections.len() >= 16 {
                    connections.join_next().await;
                    continue;
                }
                let socket = tokio::select! {
                    accepted = listener.accept() => accepted,
                    Some(_) = connections.join_next(), if !connections.is_empty() => continue,
                };
                let Ok((socket, _)) = socket else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let (sender, handle) = (sender.clone(), handle.clone());
                connections.spawn(serve_callback(socket, sender, handle));
            }
        });
        Ok(Self {
            task,
            code: Some(receiver),
        })
    }

    /// A server that never receives a callback (Codex's failed `listen`).
    fn unavailable() -> Self {
        Self {
            task: tokio::spawn(async {}),
            code: None,
        }
    }

    /// `waitForCode()`: the first accepted callback, or `None`.
    async fn wait(&mut self) -> Option<(String, Option<String>)> {
        match self.code.take() {
            Some(receiver) => receiver.await.ok(),
            None => None,
        }
    }
}

type CodeSender = Arc<Mutex<Option<oneshot::Sender<(String, Option<String>)>>>>;

/// One request to a callback server: the first accepted callback settles
/// the login; every request gets its page.
async fn serve_callback(
    mut socket: tokio::net::TcpStream,
    sender: CodeSender,
    handle: Arc<impl Fn(&reqwest::Url) -> CallbackReply + Send + Sync>,
) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        while !buffer.windows(4).any(|w| w == b"\r\n\r\n") && buffer.len() < 16_384 {
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await;
    if read.is_err() {
        return;
    }
    let head = String::from_utf8_lossy(&buffer);
    let target = head
        .lines()
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .unwrap_or_default();
    let url = reqwest::Url::parse("http://localhost")
        .and_then(|base| base.join(target))
        .unwrap_or_else(|_| reqwest::Url::parse("http://localhost/").unwrap());
    let reply = handle(&url);
    if let Some(code) = reply.code
        && let Some(sender) = sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    {
        let _ = sender.send(code);
    }
    let reason = match reply.status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        reply.status,
        reply.html.len(),
        reply.html
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn query(url: &reqwest::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// `parseAuthorizationInput`: a callback URL, `code#state`, a query string
/// or a bare code.
pub fn parse_authorization_input(input: &str) -> (Option<String>, Option<String>) {
    let value = trim(input);
    if value.is_empty() {
        return (None, None);
    }
    if let Ok(url) = reqwest::Url::parse(value) {
        return (query(&url, "code"), query(&url, "state"));
    }
    if let Some((code, state)) = value.split_once('#') {
        let state = state.split('#').next().unwrap_or_default();
        return (Some(code.to_owned()), Some(state.to_owned()));
    }
    if value.contains("code=") {
        let pairs: Vec<(String, String)> = form_urlencoded::parse(value.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let get = |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        };
        return (get("code"), get("state"));
    }
    (Some(value.to_owned()), None)
}

/// The code from the callback server or the pasted URL, whichever comes
/// first (`onManualCodeInput` raced with `waitForCode`).
async fn race_for_code(
    server: &mut CallbackServer,
    hooks: &dyn LoginHooks,
    expected_state: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let mut manual = hooks.manual();
    let from_manual = |input: String| {
        let (code, state) = parse_authorization_input(&input);
        if state
            .as_deref()
            .is_some_and(|state| state != expected_state)
        {
            return Err("OAuth state mismatch".to_owned());
        }
        Ok((code, state))
    };
    tokio::select! {
        callback = server.wait() => match callback {
            Some((code, state)) => Ok((Some(code), state)),
            None => from_manual(manual.await?),
        },
        input = &mut manual => from_manual(input?),
    }
}

/// The longest provider reply a login reads (the TS worker's output cap).
const MAX_REPLY: usize = 1_000_000;
/// Every request of a login or refresh.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Send `request`; the status and at most [`MAX_REPLY`] bytes of the body.
async fn send(request: reqwest::RequestBuilder) -> Result<(reqwest::StatusCode, String), String> {
    let mut response = request
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("request failed: {error}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_REPLY {
            return Err("reply too large".to_owned());
        }
    }
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> Result<Value, String> {
    let (status, text) = send(
        client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.to_string()),
    )
    .await?;
    if !status.is_success() {
        return Err(format!("HTTP request failed. status={}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|_| "invalid JSON".to_owned())
}

async fn post_form(
    client: &reqwest::Client,
    url: &str,
    fields: &[(&str, &str)],
) -> Result<Value, String> {
    let (status, text) = send(
        client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form(fields)),
    )
    .await?;
    if !status.is_success() {
        return Err(format!("token request failed ({})", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|_| "invalid JSON".to_owned())
}

/// `Date.now() + seconds * 1000 - margin`; not a number unless `seconds` is.
fn expires_at(seconds: Option<&Value>, margin_ms: f64) -> Value {
    match seconds.and_then(Value::as_f64) {
        Some(seconds) => json!(now_ms() as f64 + seconds * 1000.0 - margin_ms),
        None => Value::Null,
    }
}

fn credentials(entries: Vec<(&str, Value)>) -> Credentials {
    entries
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// `loginAnthropic`.
pub async fn anthropic_login(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    hooks: &dyn LoginHooks,
) -> Result<Credentials, String> {
    let (verifier, challenge) = pkce();
    let redirect_uri = format!(
        "http://localhost:{}/callback",
        endpoints.anthropic_callback_port
    );
    let expected = verifier.clone();
    let mut server = CallbackServer::start(
        &endpoints.callback_host,
        endpoints.anthropic_callback_port,
        move |url| {
            if url.path() != "/callback" {
                return CallbackReply {
                    status: 404,
                    html: error_html("Callback route not found.", None),
                    code: None,
                };
            }
            let (code, state, error) =
                (query(url, "code"), query(url, "state"), query(url, "error"));
            if let Some(error) = error {
                return CallbackReply {
                    status: 400,
                    html: error_html(
                        "Anthropic authentication did not complete.",
                        Some(&format!("Error: {error}")),
                    ),
                    code: None,
                };
            }
            let (Some(code), Some(state)) = (
                code.filter(|c| !c.is_empty()),
                state.filter(|s| !s.is_empty()),
            ) else {
                return CallbackReply {
                    status: 400,
                    html: error_html("Missing code or state parameter.", None),
                    code: None,
                };
            };
            if state != expected {
                return CallbackReply {
                    status: 400,
                    html: error_html("State mismatch.", None),
                    code: None,
                };
            }
            CallbackReply {
                status: 200,
                html: success_html(
                    "Anthropic authentication completed. You can close this window.",
                ),
                code: Some((code, Some(state))),
            }
        },
    )
    .await
    .map_err(|error| format!("callback server: {error}"))?;
    let mut url = reqwest::Url::parse(&endpoints.anthropic_authorize).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", ANTHROPIC_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", ANTHROPIC_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &verifier);
    hooks.on_auth(
        url.as_str(),
        Some("Complete login in your browser. If the browser is on another machine, paste the final redirect URL here."),
    )?;
    let (code, state) = race_for_code(&mut server, hooks, &verifier).await?;
    let (code, state) = match code.filter(|code| !code.is_empty()) {
        Some(code) => (code, state.unwrap_or_else(|| verifier.clone())),
        None => {
            let input = hooks
                .prompt(Prompt {
                    message: "Paste the authorization code or full redirect URL:".to_owned(),
                    placeholder: Some(redirect_uri.clone()),
                    allow_empty: None,
                })
                .await?;
            let (code, state) = parse_authorization_input(&input);
            if state.as_deref().is_some_and(|state| state != verifier) {
                return Err("OAuth state mismatch".to_owned());
            }
            let code = code
                .filter(|code| !code.is_empty())
                .ok_or("Missing authorization code")?;
            (code, state.unwrap_or_else(|| verifier.clone()))
        }
    };
    drop(server);
    hooks.on_progress("Exchanging authorization code for tokens...");
    let data = post_json(
        client,
        &endpoints.anthropic_token,
        &json!({ "grant_type": "authorization_code", "client_id": ANTHROPIC_CLIENT_ID,
            "code": code, "state": state, "redirect_uri": redirect_uri,
            "code_verifier": verifier }),
    )
    .await?;
    Ok(credentials(vec![
        ("refresh", data["refresh_token"].clone()),
        ("access", data["access_token"].clone()),
        (
            "expires",
            expires_at(data.get("expires_in"), FIVE_MINUTES_MS),
        ),
    ]))
}

/// `refreshAnthropicToken`.
pub async fn anthropic_refresh(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    refresh: &str,
) -> Result<Credentials, String> {
    let data = post_json(
        client,
        &endpoints.anthropic_token,
        &json!({ "grant_type": "refresh_token", "client_id": ANTHROPIC_CLIENT_ID,
            "refresh_token": refresh }),
    )
    .await?;
    Ok(credentials(vec![
        ("refresh", data["refresh_token"].clone()),
        ("access", data["access_token"].clone()),
        (
            "expires",
            expires_at(data.get("expires_in"), FIVE_MINUTES_MS),
        ),
    ]))
}

/// `decodeJwt`: the payload of a three-part token (`atob`, so standard
/// base64 with optional padding).
fn decode_jwt(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1].trim_end_matches('=');
    let bytes = STANDARD_NO_PAD.decode(payload).ok()?;
    // `atob` yields one character per byte; JSON.parse reads them as text.
    let text: String = bytes.iter().map(|&b| char::from(b)).collect();
    serde_json::from_str(&text).ok()
}

/// `getAccountId`: the ChatGPT account of a Codex access token.
pub fn codex_account_id(access: &str) -> Option<String> {
    let payload = decode_jwt(access)?;
    payload
        .get(CODEX_JWT_CLAIM)?
        .get("chatgpt_account_id")?
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// The token response of Codex's exchange or refresh, as credentials.
fn codex_credentials(json: &Value) -> Result<Credentials, String> {
    let text = |key: &str| {
        json.get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let (Some(access), Some(refresh), Some(_)) = (
        text("access_token"),
        text("refresh_token"),
        json.get("expires_in").and_then(Value::as_f64),
    ) else {
        return Err("Codex token response missing fields".to_owned());
    };
    let account_id = codex_account_id(access).ok_or("Failed to extract accountId from token")?;
    Ok(credentials(vec![
        ("access", json!(access)),
        ("refresh", json!(refresh)),
        ("expires", expires_at(json.get("expires_in"), 0.0)),
        ("accountId", json!(account_id)),
    ]))
}

/// `loginOpenAICodex` (originator `pi`).
pub async fn codex_login(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    hooks: &dyn LoginHooks,
) -> Result<Credentials, String> {
    let (verifier, challenge) = pkce();
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).expect("the system random number generator");
    let state: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let redirect_uri = format!(
        "http://localhost:{}/auth/callback",
        endpoints.codex_callback_port
    );
    let mut url = reqwest::Url::parse(&endpoints.codex_authorize).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CODEX_CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", CODEX_SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "pi");
    let expected = state.clone();
    let server = CallbackServer::start(
        &endpoints.callback_host,
        endpoints.codex_callback_port,
        move |url| {
            if url.path() != "/auth/callback" {
                return CallbackReply {
                    status: 404,
                    html: error_html("Callback route not found.", None),
                    code: None,
                };
            }
            if query(url, "state").as_deref() != Some(expected.as_str()) {
                return CallbackReply {
                    status: 400,
                    html: error_html("State mismatch.", None),
                    code: None,
                };
            }
            let Some(code) = query(url, "code").filter(|code| !code.is_empty()) else {
                return CallbackReply {
                    status: 400,
                    html: error_html("Missing authorization code.", None),
                    code: None,
                };
            };
            CallbackReply {
                status: 200,
                html: success_html("OpenAI authentication completed. You can close this window."),
                code: Some((code, None)),
            }
        },
    )
    .await;
    // A port in use leaves only the pasted URL.
    let mut server = server.unwrap_or_else(|_| CallbackServer::unavailable());
    hooks.on_auth(
        url.as_str(),
        Some("A browser window should open. Complete login to finish."),
    )?;
    let (code, _) = race_for_code(&mut server, hooks, &state).await?;
    let code = match code.filter(|code| !code.is_empty()) {
        Some(code) => code,
        None => {
            let input = hooks
                .prompt(Prompt {
                    message: "Paste the authorization code (or full redirect URL):".to_owned(),
                    placeholder: None,
                    allow_empty: None,
                })
                .await?;
            let (code, parsed_state) = parse_authorization_input(&input);
            if parsed_state
                .as_deref()
                .is_some_and(|parsed| parsed != state)
            {
                return Err("State mismatch".to_owned());
            }
            code.filter(|code| !code.is_empty())
                .ok_or("Missing authorization code")?
        }
    };
    drop(server);
    let json = post_form(
        client,
        &endpoints.codex_token,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT_ID),
            ("code", &code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect_uri),
        ],
    )
    .await?;
    codex_credentials(&json)
}

/// `refreshOpenAICodexToken`.
pub async fn codex_refresh(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    refresh: &str,
) -> Result<Credentials, String> {
    let json = post_form(
        client,
        &endpoints.codex_token,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", CODEX_CLIENT_ID),
        ],
    )
    .await?;
    codex_credentials(&json)
}

/// `getUrls(domain)`: device code, access token and Copilot token URLs.
fn github_urls(endpoints: &Endpoints, domain: &str) -> (String, String, String) {
    let (site, api) = match &endpoints.github_override {
        Some(base) => (base.clone(), format!("{base}/api")),
        None => (format!("https://{domain}"), format!("https://api.{domain}")),
    };
    (
        format!("{site}/login/device/code"),
        format!("{site}/login/oauth/access_token"),
        format!("{api}/copilot_internal/v2/token"),
    )
}

async fn fetch_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let (status, text) = send(request).await?;
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|_| "invalid JSON".to_owned())
}

fn form(fields: &[(&str, &str)]) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish()
}

/// `refreshGitHubCopilotToken`: a Copilot token from the GitHub token.
pub async fn copilot_token(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    github_token: &str,
    enterprise_domain: Option<&str>,
) -> Result<Credentials, String> {
    let domain = enterprise_domain
        .filter(|domain| !domain.is_empty())
        .unwrap_or("github.com");
    let (_, _, token_url) = github_urls(endpoints, domain);
    let mut request = client
        .get(token_url)
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {github_token}"));
    for (name, value) in COPILOT_HEADERS {
        request = request.header(name, value);
    }
    let raw = fetch_json(request).await?;
    let (Some(token), Some(expires_at)) = (
        raw.get("token").and_then(Value::as_str),
        raw.get("expires_at").and_then(Value::as_f64),
    ) else {
        return Err("Invalid Copilot token response fields".to_owned());
    };
    let mut out = credentials(vec![
        ("refresh", json!(github_token)),
        ("access", json!(token)),
        ("expires", json!(expires_at * 1000.0 - FIVE_MINUTES_MS)),
    ]);
    if let Some(domain) = enterprise_domain {
        out.insert("enterpriseUrl".to_owned(), json!(domain));
    }
    Ok(out)
}

/// `loginGitHubCopilot`: enterprise domain, device flow, Copilot token,
/// then the explicitly supplied model policies enabled (empty disables discovery).
pub async fn copilot_login(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    hooks: &dyn LoginHooks,
    policy_model_ids: &[String],
) -> Result<Credentials, String> {
    let input = hooks
        .prompt(Prompt {
            message: "GitHub Enterprise URL/domain (blank for github.com)".to_owned(),
            placeholder: Some("company.ghe.com".to_owned()),
            allow_empty: Some(true),
        })
        .await?;
    let trimmed = trim(&input);
    let enterprise = normalize_domain(&input);
    if !trimmed.is_empty() && enterprise.is_none() {
        return Err("Invalid GitHub Enterprise URL/domain".to_owned());
    }
    let domain = enterprise
        .clone()
        .unwrap_or_else(|| "github.com".to_owned());
    let (device_url, access_url, _) = github_urls(endpoints, &domain);
    let device = fetch_json(
        client
            .post(device_url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("User-Agent", "GitHubCopilotChat/0.35.0")
            .body(form(&[
                ("client_id", COPILOT_CLIENT_ID),
                ("scope", "read:user"),
            ])),
    )
    .await?;
    let field = |key: &str| device.get(key);
    let (
        Some(device_code),
        Some(user_code),
        Some(verification_uri),
        Some(interval),
        Some(expires_in),
    ) = (
        field("device_code").and_then(Value::as_str),
        field("user_code").and_then(Value::as_str),
        field("verification_uri").and_then(Value::as_str),
        field("interval").and_then(Value::as_f64),
        field("expires_in").and_then(Value::as_f64),
    )
    else {
        return Err("Invalid device code response fields".to_owned());
    };
    hooks.on_auth(verification_uri, Some(&format!("Enter code: {user_code}")))?;
    let github_token = poll_device_flow(
        client,
        endpoints,
        &access_url,
        device_code,
        interval,
        expires_in,
    )
    .await?;
    let credentials =
        copilot_token(client, endpoints, &github_token, enterprise.as_deref()).await?;
    hooks.on_progress("Enabling models...");
    let access = credentials
        .get("access")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    enable_copilot_models(
        client,
        endpoints,
        &access,
        enterprise.as_deref(),
        policy_model_ids,
    )
    .await;
    Ok(credentials)
}

/// `pollForGitHubAccessToken`.
async fn poll_device_flow(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    access_url: &str,
    device_code: &str,
    interval_seconds: f64,
    expires_in: f64,
) -> Result<String, String> {
    let deadline = now_ms() as f64 + expires_in * 1000.0;
    let floor = endpoints.poll_floor.as_millis() as f64;
    let mut interval_ms = floor.max((interval_seconds * 1000.0).floor());
    let mut multiplier = 1.2;
    let mut slow_downs = 0;
    while (now_ms() as f64) < deadline {
        let remaining = deadline - now_ms() as f64;
        let wait = (interval_ms * multiplier).ceil().min(remaining).max(0.0);
        tokio::time::sleep(Duration::from_millis(wait as u64)).await;
        let raw = fetch_json(
            client
                .post(access_url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("User-Agent", "GitHubCopilotChat/0.35.0")
                .body(form(&[
                    ("client_id", COPILOT_CLIENT_ID),
                    ("device_code", device_code),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])),
        )
        .await?;
        if let Some(token) = raw.get("access_token").and_then(Value::as_str) {
            return Ok(token.to_owned());
        }
        if let Some(error) = raw.get("error").and_then(Value::as_str) {
            match error {
                "authorization_pending" => continue,
                "slow_down" => {
                    slow_downs += 1;
                    interval_ms = match raw.get("interval").and_then(Value::as_f64) {
                        Some(seconds) if seconds > 0.0 => seconds * 1000.0,
                        _ => floor.max(interval_ms + 5000.0),
                    };
                    multiplier = 1.4;
                    continue;
                }
                other => return Err(format!("Device flow failed: {other}")),
            }
        }
    }
    if slow_downs > 0 {
        Err("Device flow timed out after one or more slow_down responses".to_owned())
    } else {
        Err("Device flow timed out".to_owned())
    }
}

/// `enableAllGitHubCopilotModels`: accept each host-selected model policy;
/// failures are ignored.
async fn enable_copilot_models(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    token: &str,
    enterprise_domain: Option<&str>,
    policy_model_ids: &[String],
) {
    let base = endpoints
        .copilot_api_override
        .clone()
        .unwrap_or_else(|| copilot_base_url(Some(token), enterprise_domain));
    let requests = policy_model_ids.iter().map(|id| {
        let mut request = client
            .post(format!("{base}/models/{id}/policy"))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {token}"));
        for (name, value) in COPILOT_HEADERS {
            request = request.header(name, value);
        }
        let request = request
            .header("openai-intent", "chat-policy")
            .header("x-interaction-type", "chat-policy")
            .body(r#"{"state":"enabled"}"#)
            .timeout(REQUEST_TIMEOUT);
        async move {
            let _ = request.send().await;
        }
    });
    // Owned by the login: cancelling it stops the requests too.
    let mut tasks = tokio::task::JoinSet::new();
    for request in requests {
        tasks.spawn(request);
    }
    while tasks.join_next().await.is_some() {}
}

/// `provider.refreshToken(credentials)` of the registry.
pub async fn refresh(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    provider: &str,
    credentials: &Credentials,
) -> Result<Credentials, String> {
    let refresh = credentials
        .get("refresh")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match provider {
        "anthropic" => anthropic_refresh(client, endpoints, refresh).await,
        "openai-codex" => codex_refresh(client, endpoints, refresh).await,
        "github-copilot" => {
            let domain = credentials.get("enterpriseUrl").and_then(Value::as_str);
            copilot_token(client, endpoints, refresh, domain).await
        }
        _ => Err("Unknown provider".to_owned()),
    }
}

/// `provider.login(callbacks)` of the registry.
pub async fn login(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    provider: &str,
    hooks: &dyn LoginHooks,
    policy_model_ids: &[String],
) -> Result<Credentials, String> {
    match provider {
        "anthropic" => anthropic_login(client, endpoints, hooks).await,
        "openai-codex" => codex_login(client, endpoints, hooks).await,
        "github-copilot" => copilot_login(client, endpoints, hooks, policy_model_ids).await,
        _ => Err("Unknown provider".to_owned()),
    }
}

#[cfg(test)]
mod tests;
