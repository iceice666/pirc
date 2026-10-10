//! The login flows against local stand-ins for the providers.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, Uri};
use axum::response::IntoResponse;

use super::*;

#[derive(Default)]
struct Seen {
    requests: Vec<(String, String, HeaderMap, String)>,
    polls: usize,
}

type Shared = Arc<Mutex<Seen>>;

fn jwt(account: &str) -> String {
    let payload = json!({ CODEX_JWT_CLAIM: { "chatgpt_account_id": account } }).to_string();
    format!(
        "h.{}.s",
        base64::engine::general_purpose::STANDARD.encode(payload)
    )
}

async fn provider(
    State(seen): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    let path = uri.path().to_owned();
    let body = String::from_utf8_lossy(&body).into_owned();
    let polls = {
        let mut seen = seen.lock().unwrap();
        seen.requests
            .push((method.to_string(), path.clone(), headers, body.clone()));
        if path == "/login/oauth/access_token" {
            seen.polls += 1;
        }
        seen.polls
    };
    let json = |value: Value| ([("content-type", "application/json")], value.to_string());
    match path.as_str() {
        "/anthropic/token" => {
            let request: Value = serde_json::from_str(&body).unwrap();
            let refresh = request["grant_type"] == "refresh_token";
            json(
                json!({ "access_token": if refresh { "a-refreshed" } else { "a-access" },
                "refresh_token": "a-refresh", "expires_in": 3600 }),
            )
            .into_response()
        }
        "/codex/token" => json(json!({ "access_token": jwt("acct-1"),
            "refresh_token": "c-refresh", "expires_in": 600 }))
        .into_response(),
        "/login/device/code" => json(json!({ "device_code": "dev", "user_code": "ABCD-1234",
            "verification_uri": "https://github.example/login/device", "interval": 0,
            "expires_in": 30 }))
        .into_response(),
        "/login/oauth/access_token" if polls == 1 => {
            json(json!({ "error": "authorization_pending" })).into_response()
        }
        "/login/oauth/access_token" => json(json!({ "access_token": "gh-token" })).into_response(),
        "/api/copilot_internal/v2/token" => json(json!({
            "token": "tid=1;proxy-ep=proxy.example.com;", "expires_at": 2_000_000_000 }))
        .into_response(),
        _ => json(json!({})).into_response(),
    }
}

async fn start() -> (String, Shared) {
    let seen = Shared::default();
    let app = Router::new().fallback(provider).with_state(seen.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, seen)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn endpoints(base: &str) -> Endpoints {
    Endpoints {
        anthropic_authorize: "https://claude.example/oauth/authorize".to_owned(),
        anthropic_token: format!("{base}/anthropic/token"),
        anthropic_callback_port: free_port(),
        codex_authorize: "https://auth.example/oauth/authorize".to_owned(),
        codex_token: format!("{base}/codex/token"),
        codex_callback_port: free_port(),
        callback_host: "127.0.0.1".to_owned(),
        github_override: Some(base.to_owned()),
        copilot_api_override: Some(format!("{base}/copilot")),
        poll_floor: Duration::from_millis(10),
    }
}

type Paste = Box<dyn Fn(&reqwest::Url) -> String + Send + Sync>;

/// A user who answers prompts from a script and pastes the callback URL
/// built from the authorization page (unless `paste` is false).
#[derive(Default)]
struct User {
    auth: Mutex<Vec<(String, Option<String>)>>,
    progress: Mutex<Vec<String>>,
    prompts: Mutex<Vec<Prompt>>,
    answers: Mutex<Vec<String>>,
    paste: Option<Paste>,
}

impl LoginHooks for User {
    fn on_auth(&self, url: &str, instructions: Option<&str>) -> Result<(), String> {
        self.auth
            .lock()
            .unwrap()
            .push((url.to_owned(), instructions.map(str::to_owned)));
        Ok(())
    }

    fn on_progress(&self, text: &str) {
        self.progress.lock().unwrap().push(text.to_owned());
    }

    fn prompt(&self, prompt: Prompt) -> BoxFuture<Result<String, String>> {
        self.prompts.lock().unwrap().push(prompt);
        let answer = self.answers.lock().unwrap().pop().unwrap_or_default();
        Box::pin(async move { Ok(answer) })
    }

    fn manual(&self) -> BoxFuture<Result<String, String>> {
        let url = self.auth.lock().unwrap().last().map(|(url, _)| url.clone());
        let pasted = match (&self.paste, url) {
            (Some(paste), Some(url)) => Some(paste(&reqwest::Url::parse(&url).unwrap())),
            _ => None,
        };
        Box::pin(async move {
            match pasted {
                Some(text) => Ok(text),
                None => std::future::pending().await,
            }
        })
    }
}

fn param(url: &reqwest::Url, name: &str) -> String {
    query(url, name).unwrap_or_default()
}

fn pasted_callback() -> Paste {
    Box::new(|auth| {
        format!(
            "{}?code=the-code&state={}",
            param(auth, "redirect_uri"),
            param(auth, "state")
        )
    })
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn anthropic_exchanges_a_pasted_code_with_pkce() {
    let (base, seen) = start().await;
    let endpoints = endpoints(&base);
    let user = User {
        paste: Some(pasted_callback()),
        ..User::default()
    };
    let credentials = anthropic_login(&client(), &endpoints, &user).await.unwrap();
    assert_eq!(credentials["access"], "a-access");
    assert_eq!(credentials["refresh"], "a-refresh");
    let expires = credentials["expires"].as_f64().unwrap();
    let expected = now_ms() as f64 + 3_300_000.0;
    assert!((expires - expected).abs() < 5_000.0, "{expires}");

    let (url, instructions) = user.auth.lock().unwrap()[0].clone();
    let auth = reqwest::Url::parse(&url).unwrap();
    let keys: Vec<String> = auth.query_pairs().map(|(k, _)| k.into_owned()).collect();
    assert_eq!(
        keys,
        [
            "code",
            "client_id",
            "response_type",
            "redirect_uri",
            "scope",
            "code_challenge",
            "code_challenge_method",
            "state"
        ]
    );
    assert!(url.contains("scope=org%3Acreate_api_key+user%3Aprofile"));
    assert_eq!(
        param(&auth, "redirect_uri"),
        format!(
            "http://localhost:{}/callback",
            endpoints.anthropic_callback_port
        )
    );
    assert!(instructions.unwrap().starts_with("Complete login"));
    let verifier = param(&auth, "state");
    assert_eq!(
        param(&auth, "code_challenge"),
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    );
    let seen = seen.lock().unwrap();
    let body: Value = serde_json::from_str(&seen.requests[0].3).unwrap();
    assert_eq!(
        body,
        json!({ "grant_type": "authorization_code", "client_id": ANTHROPIC_CLIENT_ID,
            "code": "the-code", "state": verifier, "redirect_uri": param(&auth, "redirect_uri"),
            "code_verifier": verifier })
    );
    assert_eq!(seen.requests[0].2["accept"], "application/json");
    assert_eq!(
        *user.progress.lock().unwrap(),
        ["Exchanging authorization code for tokens..."]
    );
}

#[tokio::test]
async fn anthropic_accepts_the_browser_callback() {
    let (base, _) = start().await;
    let endpoints = endpoints(&base);
    let user = Arc::new(User::default());
    let login = {
        let (endpoints, user) = (endpoints.clone(), user.clone());
        tokio::spawn(async move { anthropic_login(&client(), &endpoints, user.as_ref()).await })
    };
    let auth = loop {
        if let Some((url, _)) = user.auth.lock().unwrap().first().cloned() {
            break reqwest::Url::parse(&url).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let callback = format!(
        "http://127.0.0.1:{}/callback",
        endpoints.anthropic_callback_port
    );
    let http = client();
    let mismatch = http
        .get(format!("{callback}?code=x&state=wrong"))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch.status(), 400);
    assert!(mismatch.text().await.unwrap().contains("State mismatch."));
    let missing = http
        .get(format!("{callback}?state=x"))
        .send()
        .await
        .unwrap();
    assert!(
        missing
            .text()
            .await
            .unwrap()
            .contains("Missing code or state parameter.")
    );
    let other = http
        .get(format!(
            "http://127.0.0.1:{}/elsewhere",
            endpoints.anthropic_callback_port
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 404);
    let ok = http
        .get(format!(
            "{callback}?code=browser-code&state={}",
            param(&auth, "state")
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    let page = ok.text().await.unwrap();
    assert!(page.contains("<title>Authentication successful</title>"));
    assert!(page.contains("Anthropic authentication completed. You can close this window."));
    let credentials = login.await.unwrap().unwrap();
    assert_eq!(credentials["access"], "a-access");
    // The callback server is gone with the login.
    assert!(
        http.get(callback.clone())
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_err()
    );
}

#[tokio::test]
async fn anthropic_refuses_a_foreign_state_and_falls_back_to_the_prompt() {
    let (base, _) = start().await;
    let endpoints = endpoints(&base);
    let user = User {
        paste: Some(Box::new(|auth| {
            format!("{}?code=c&state=other", param(auth, "redirect_uri"))
        })),
        ..User::default()
    };
    let error = anthropic_login(&client(), &endpoints, &user)
        .await
        .unwrap_err();
    assert_eq!(error, "OAuth state mismatch");
    // A blank paste asks for the code instead.
    let user = User {
        paste: Some(Box::new(|_| "  ".to_owned())),
        answers: Mutex::new(vec!["typed-code".to_owned()]),
        ..User::default()
    };
    let credentials = anthropic_login(&client(), &endpoints, &user).await.unwrap();
    assert_eq!(credentials["access"], "a-access");
    assert_eq!(
        user.prompts.lock().unwrap()[0].message,
        "Paste the authorization code or full redirect URL:"
    );
}

#[tokio::test]
async fn codex_logs_in_with_its_account_id_even_when_the_port_is_taken() {
    let (base, seen) = start().await;
    let mut endpoints = endpoints(&base);
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    endpoints.codex_callback_port = taken.local_addr().unwrap().port();
    let user = User {
        paste: Some(pasted_callback()),
        ..User::default()
    };
    let credentials = codex_login(&client(), &endpoints, &user).await.unwrap();
    assert_eq!(credentials["accountId"], "acct-1");
    assert_eq!(credentials["refresh"], "c-refresh");
    let (url, _) = user.auth.lock().unwrap()[0].clone();
    let auth = reqwest::Url::parse(&url).unwrap();
    assert_eq!(param(&auth, "originator"), "pi");
    assert_eq!(param(&auth, "state").len(), 32);
    let seen = seen.lock().unwrap();
    let form: Vec<(String, String)> = form_urlencoded::parse(seen.requests[0].3.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let keys: Vec<&str> = form.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "grant_type",
            "client_id",
            "code",
            "code_verifier",
            "redirect_uri"
        ]
    );
    assert_eq!(
        seen.requests[0].2["content-type"],
        "application/x-www-form-urlencoded"
    );
    drop(taken);
}

#[tokio::test]
async fn copilot_device_flow_mints_a_token_and_enables_models() {
    let (base, seen) = start().await;
    let endpoints = endpoints(&base);
    let user = User::default();
    let credentials = copilot_login(&client(), &endpoints, &user).await.unwrap();
    assert_eq!(credentials["refresh"], "gh-token");
    assert_eq!(credentials["access"], "tid=1;proxy-ep=proxy.example.com;");
    assert_eq!(
        credentials["expires"].as_f64(),
        Some(2_000_000_000_000.0 - FIVE_MINUTES_MS)
    );
    assert!(credentials.get("enterpriseUrl").is_none());
    assert_eq!(
        user.auth.lock().unwrap()[0],
        (
            "https://github.example/login/device".to_owned(),
            Some("Enter code: ABCD-1234".to_owned())
        )
    );
    assert_eq!(user.prompts.lock().unwrap()[0].allow_empty, Some(true));
    assert_eq!(*user.progress.lock().unwrap(), ["Enabling models..."]);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.polls, 2);
    let token = seen
        .requests
        .iter()
        .find(|r| r.1 == "/api/copilot_internal/v2/token")
        .unwrap();
    assert_eq!(token.2["authorization"], "Bearer gh-token");
    assert_eq!(token.2["editor-version"], "vscode/1.107.0");
    let policies = seen
        .requests
        .iter()
        .filter(|r| r.1.ends_with("/policy"))
        .count();
    assert_eq!(policies, catalog_models("github-copilot").len());
}

#[tokio::test]
async fn copilot_refuses_an_invalid_enterprise_domain() {
    let (base, _) = start().await;
    let user = User {
        answers: Mutex::new(vec!["https://".to_owned()]),
        ..User::default()
    };
    let error = copilot_login(&client(), &endpoints(&base), &user)
        .await
        .unwrap_err();
    assert_eq!(error, "Invalid GitHub Enterprise URL/domain");
}

#[tokio::test]
async fn refreshes_each_provider() {
    let (base, seen) = start().await;
    let endpoints = endpoints(&base);
    let credentials = |refresh: &str, extra: Value| {
        let mut out = json!({ "access": "x", "refresh": refresh, "expires": 0 });
        out.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        out.as_object().unwrap().clone()
    };
    let http = client();
    let fresh = refresh(
        &http,
        &endpoints,
        "anthropic",
        &credentials("a-old", json!({})),
    )
    .await
    .unwrap();
    assert_eq!(fresh["access"], "a-refreshed");
    let fresh = refresh(
        &http,
        &endpoints,
        "openai-codex",
        &credentials("c-old", json!({})),
    )
    .await
    .unwrap();
    assert_eq!(fresh["accountId"], "acct-1");
    let fresh = refresh(
        &http,
        &endpoints,
        "github-copilot",
        &credentials("gh-token", json!({ "enterpriseUrl": "ghe.example" })),
    )
    .await
    .unwrap();
    assert_eq!(fresh["enterpriseUrl"], "ghe.example");
    assert_eq!(fresh["refresh"], "gh-token");
    let first = seen.lock().unwrap().requests[0].3.clone();
    let anthropic: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(
        anthropic,
        json!({ "grant_type": "refresh_token", "client_id": ANTHROPIC_CLIENT_ID,
            "refresh_token": "a-old" })
    );
    assert!(
        refresh(&http, &endpoints, "nope", &Credentials::new())
            .await
            .is_err()
    );
}

#[test]
fn parses_pasted_input() {
    assert_eq!(
        parse_authorization_input(" http://localhost:1/cb?code=c&state=s "),
        (Some("c".to_owned()), Some("s".to_owned()))
    );
    assert_eq!(
        parse_authorization_input("c#s#t"),
        (Some("c".to_owned()), Some("s".to_owned()))
    );
    assert_eq!(
        parse_authorization_input("code=c&state=s"),
        (Some("c".to_owned()), Some("s".to_owned()))
    );
    assert_eq!(
        parse_authorization_input("bare"),
        (Some("bare".to_owned()), None)
    );
    assert_eq!(parse_authorization_input("   "), (None, None));
}

#[test]
fn reads_codex_account_ids() {
    assert_eq!(codex_account_id(&jwt("acct")).as_deref(), Some("acct"));
    let padded = format!(
        "h.{}.s",
        base64::engine::general_purpose::STANDARD.encode(r#"{"a":1}"#)
    );
    assert_eq!(codex_account_id(&padded), None);
    assert_eq!(codex_account_id("not-a-jwt"), None);
    assert_eq!(codex_account_id(&jwt("")), None);
}

#[test]
fn pkce_challenges_match_their_verifiers() {
    let (verifier, challenge) = pkce();
    assert_eq!(verifier.len(), 43);
    assert_eq!(
        challenge,
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    );
    assert!(!verifier.contains(['+', '/', '=']));
}

#[test]
fn pages_escape_their_text() {
    let page = error_html("<bad>", Some("a & b"));
    assert!(page.contains("<p>&lt;bad&gt;</p>"));
    assert!(page.contains(r#"<div class="details">a &amp; b</div>"#));
    assert!(!success_html("ok").contains("class=\"details\""));
}
