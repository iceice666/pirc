//! Ported from `backend-auth.test.ts` and `backend-discovery.test.ts`
//! (the store, presets and probes; logins are tested with the OAuth flows).

use std::sync::atomic::AtomicUsize;

use super::*;

const SECRET: &str = "fake-secret-token";

fn baseline() -> Models {
    serde_json::from_value(json!({
        "providers": { "file": {
            "api": "openai-chat", "baseUrl": "https://file-backend.example/v1",
            "apiKey": "file-secret", "headers": { "authorization": "file-header-secret" },
            "compat": {}, "models": [{ "id": "file-model", "contextWindow": 1000,
                "maxTokens": 100, "reasoning": false, "input": ["text"], "compat": {} }],
        } },
        "defaultModel": { "provider": "file", "id": "file-model" },
    }))
    .unwrap()
}

fn service(dir: &Path) -> (BackendService, Arc<AtomicUsize>) {
    let service = BackendService::open(dir, baseline()).unwrap();
    let changes = Arc::new(AtomicUsize::new(0));
    let counter = changes.clone();
    service.set_on_change(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    (service, changes)
}

async fn resolve(service: &BackendService, provider: &str, model: &str) -> Resolved {
    service.resolve(provider, model).await.unwrap()
}

#[tokio::test]
async fn persists_ui_backends_privately_and_keys_are_write_only() {
    let dir = tempfile::tempdir().unwrap();
    let (backends, changes) = service(dir.path());
    let lan = |key: Option<&str>| {
        let mut body = json!({ "api": "openai-completions", "baseUrl": "http://192.168.1.5:8080/v1",
            "models": [{ "id": "local-model" }] });
        if let Some(key) = key {
            body["apiKey"] = json!(key);
        }
        body
    };
    backends
        .save_provider("lan", &lan(Some("ui-secret")), true)
        .unwrap();
    let model = json!({ "api": "openai-chat", "baseUrl": "https://x.example",
        "models": [{ "id": "m" }] });
    assert_eq!(
        backends.save_provider("file", &model, true).unwrap_err(),
        conflict("File-managed backends are read-only")
    );
    let mut credentials = model.clone();
    credentials["baseUrl"] = json!("https://u:p@x.example");
    assert_eq!(
        backends
            .save_provider("bad", &credentials, true)
            .unwrap_err(),
        invalid_settings()
    );
    let mut command = model.clone();
    command["apiKeyCommand"] = json!(["cat"]);
    assert!(backends.save_provider("cmd", &command, true).is_err());
    assert_eq!(
        backends.save_provider("lan", &model, true).unwrap_err(),
        conflict("Backend ID already exists")
    );
    assert_eq!(
        backends.save_provider("nope", &model, false).unwrap_err(),
        not_found()
    );
    assert_eq!(
        backends
            .save_provider("default-model", &model, true)
            .unwrap_err(),
        invalid("Invalid backend ID")
    );
    // Omitting the key keeps it; an empty string clears it.
    backends.save_provider("lan", &lan(None), false).unwrap();
    assert_eq!(
        resolve(&backends, "lan", "local-model")
            .await
            .api_key
            .as_deref(),
        Some("ui-secret")
    );
    let file = dir.path().join("backends/settings.json");
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(file.parent().unwrap()), 0o700);
    let snapshot = backends.snapshot();
    assert!(!snapshot.to_string().contains("ui-secret"));
    let view = snapshot["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "lan")
        .unwrap()
        .clone();
    assert_eq!(view["source"], "ui");
    assert_eq!(view["hasApiKey"], true);
    assert_eq!(view["baseUrl"], "http://192.168.1.5:8080/v1");
    backends
        .save_provider("lan", &lan(Some("")), false)
        .unwrap();
    assert_eq!(resolve(&backends, "lan", "local-model").await.api_key, None);
    backends
        .set_default(&json!({ "provider": "lan", "id": "local-model" }))
        .unwrap();
    assert_eq!(
        backends.models().default_model.unwrap().provider,
        "lan".to_owned()
    );
    assert_eq!(changes.load(Ordering::SeqCst), 4);
    assert_eq!(
        backends
            .set_default(&json!({ "provider": "lan", "id": "other" }))
            .unwrap_err(),
        invalid("Model is not configured")
    );
    assert_eq!(
        backends
            .set_default(&json!({ "provider": "lan", "id": "local-model", "x": 1 }))
            .unwrap_err(),
        invalid_settings()
    );
    // Survives a restart; deleting a backend drops a default that pointed to it.
    drop(backends);
    let (reopened, _) = service(dir.path());
    assert_eq!(
        reopened.models().default_model.unwrap().provider,
        "lan".to_owned()
    );
    reopened.delete_provider("lan").unwrap();
    assert_eq!(reopened.models().default_model, baseline().default_model);
    assert!(!fs::read_to_string(&file).unwrap().contains("lan"));
    assert_eq!(reopened.delete_provider("lan").unwrap_err(), not_found());
    assert_eq!(
        reopened.delete_provider("file").unwrap_err(),
        conflict("File-managed backends are read-only")
    );
    assert_eq!(
        reopened.delete_provider("oauth:nope").unwrap_err(),
        not_found()
    );
    reopened.delete_provider("oauth:anthropic").unwrap();
    // No temporary files are left behind.
    let names: Vec<_> = fs::read_dir(file.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["settings.json"]);
}

#[tokio::test]
async fn keeps_opencode_go_and_the_saved_key_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let (backends, _) = service(dir.path());
    let input = json!({ "api": "openai-completions", "baseUrl": "https://proxy.example/v1",
        "models": [{ "id": "glm" }], "opencodeGo": true });
    let mut with_key = input.clone();
    with_key["apiKey"] = json!(SECRET);
    backends.save_provider("go", &with_key, true).unwrap();
    assert_eq!(backends.snapshot()["providers"][0]["opencodeGo"], true);
    drop(backends);
    let (reopened, _) = service(dir.path());
    assert_eq!(
        resolve(&reopened, "go", "glm").await.provider.opencode_go,
        Some(true)
    );
    let mut off = input;
    off["opencodeGo"] = json!(false);
    reopened.save_provider("go", &off, false).unwrap();
    let resolved = resolve(&reopened, "go", "glm").await;
    assert_eq!(resolved.provider.opencode_go, Some(false));
    assert_eq!(resolved.api_key.as_deref(), Some(SECRET));
}

#[test]
fn lists_every_login_without_leaking_file_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let (backends, _) = service(dir.path());
    let snapshot = backends.snapshot();
    let ids: Vec<_> = snapshot["oauthProviders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["anthropic", "github-copilot", "openai-codex"]);
    assert_eq!(snapshot["oauthProviders"][1]["requiresPolicyConsent"], true);
    assert_eq!(snapshot["oauthProviders"][1]["usesCallbackServer"], false);
    let providers = snapshot["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0]["source"], "file");
    assert_eq!(providers[0]["readOnly"], true);
    assert_eq!(providers[0]["hasApiKey"], true);
    assert!(providers[0].get("baseUrl").is_none());
    let text = format!(
        "{snapshot}{}",
        serde_json::to_string(&backends.models()).unwrap()
    );
    for secret in ["file-secret", "file-header-secret", "file-backend.example"] {
        assert!(!text.contains(secret), "{secret}");
    }
}

#[tokio::test]
async fn saving_from_a_preset_keeps_catalog_metadata_gateway_side() {
    let dir = tempfile::tempdir().unwrap();
    let (backends, _) = service(dir.path());
    let known = "deepseek/deepseek-v4-flash";
    backends
        .save_provider(
            "router",
            &json!({ "api": "openai-completions", "baseUrl": "https://openrouter.ai/api/v1",
                "apiKey": SECRET, "preset": "openrouter",
                "models": [{ "id": known }, { "id": "vendor/custom" }] }),
            true,
        )
        .unwrap();
    let resolved = resolve(&backends, "router", known).await;
    assert_eq!(resolved.provider.pi_provider.as_deref(), Some("openrouter"));
    assert_eq!(resolved.model.compat["thinkingFormat"], "deepseek");
    assert!(resolved.model.thinking_level_map.is_some());
    assert!(
        resolve(&backends, "router", "vendor/custom")
            .await
            .model
            .compat
            .is_empty()
    );
    let snapshot = backends.snapshot();
    assert_eq!(snapshot["providers"][0]["preset"], "openrouter");
    assert!(!snapshot.to_string().contains("thinkingFormat"));
    assert!(!snapshot.to_string().contains(SECRET));
    // Editing without the preset drops the catalog metadata.
    backends
        .save_provider(
            "router",
            &json!({ "api": "openai-completions", "baseUrl": "https://openrouter.ai/api/v1",
                "models": [{ "id": known }] }),
            false,
        )
        .unwrap();
    let plain = resolve(&backends, "router", known).await;
    assert_eq!(plain.provider.pi_provider, None);
    assert!(plain.model.compat.is_empty());
    assert_eq!(plain.api_key.as_deref(), Some(SECRET));
    for preset in ["ollama", "github-copilot", "nope"] {
        let body = json!({ "api": "openai-completions", "baseUrl": "https://a.example",
            "preset": preset, "models": [{ "id": "m" }] });
        assert_eq!(
            backends
                .save_provider(&format!("x-{preset}"), &body, true)
                .unwrap_err(),
            invalid("Unknown backend preset"),
            "{preset}"
        );
    }
    let mismatch = json!({ "api": "anthropic-messages", "baseUrl": "https://a.example",
        "preset": "openrouter", "models": [{ "id": "m" }] });
    assert_eq!(
        backends
            .save_provider("mismatch", &mismatch, true)
            .unwrap_err(),
        invalid("Unknown backend preset")
    );
}

#[tokio::test]
async fn file_providers_win_and_baseline_reloads_notify() {
    let dir = tempfile::tempdir().unwrap();
    let (backends, changes) = service(dir.path());
    backends
        .save_provider(
            "later",
            &json!({ "api": "openai-completions", "baseUrl": "https://ui.example",
                "apiKey": "ui-key", "models": [{ "id": "m" }] }),
            true,
        )
        .unwrap();
    let mut next = baseline();
    let mut shadow = next.providers["file"].clone();
    shadow.api_key = Some("file-key".to_owned());
    next.providers.insert("later".to_owned(), shadow);
    backends.set_baseline(next);
    assert_eq!(changes.load(Ordering::SeqCst), 2);
    let resolved = resolve(&backends, "later", "file-model").await;
    assert_eq!(resolved.api_key.as_deref(), Some("file-key"));
    let snapshot = backends.snapshot();
    let later = &snapshot["providers"][0];
    assert_eq!(
        (later["id"].as_str(), later["source"].as_str()),
        (Some("later"), Some("file"))
    );
    assert!(later.get("baseUrl").is_none());
    assert!(backends.resolve("oauth:anthropic", "m").await.is_err());
    backends.close();
    assert_eq!(
        backends.save_provider("x", &json!({}), true).unwrap_err(),
        closed_error()
    );
    assert!(backends.resolve("file", "file-model").await.is_err());
}

#[test]
fn refuses_unreadable_or_invalid_stores() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("backends/settings.json");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    for (text, error) in [
        ("{", "Cannot read backend credential store"),
        (
            r#"{"version":2,"providers":{},"oauth":{}}"#,
            "Cannot read backend credential store",
        ),
        (
            r#"{"version":1,"providers":{},"oauth":{},"extra":1}"#,
            "Cannot read backend credential store",
        ),
        (
            r#"{"version":1,"providers":{},"oauth":{"anthropic":{"access":"a"}}}"#,
            "Cannot read backend credential store",
        ),
        (
            r#"{"version":1,"providers":{"a":{"api":"openai-chat","baseUrl":"https://a","models":[]}},"oauth":{}}"#,
            "Cannot read backend credential store",
        ),
        (
            r#"{"version":1,"providers":{"a":{"api":"openai-chat","baseUrl":"nope","models":[{"id":"m"}]}},"oauth":{}}"#,
            "Cannot read backend credential store",
        ),
        (
            r#"{"version":1,"providers":{"bad id":{"api":"openai-chat","baseUrl":"https://a","models":[{"id":"m"}]}},"oauth":{}}"#,
            "Invalid backend credential store",
        ),
    ] {
        fs::write(&file, text).unwrap();
        assert_eq!(
            BackendService::open(dir.path(), baseline()).unwrap_err(),
            error,
            "{text}"
        );
    }
    fs::write(&file, r#"{"version":1,"oauth":{}}"#).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    BackendService::open(dir.path(), baseline()).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn probes_reuse_only_the_edited_web_backend_key() {
    use axum::http::HeaderMap;
    use std::sync::Mutex as StdMutex;
    let seen = Arc::new(StdMutex::new(Vec::<Option<String>>::new()));
    let log = seen.clone();
    let app = axum::Router::new().route(
        "/models",
        axum::routing::get(move |headers: HeaderMap| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(
                    headers
                        .get("authorization")
                        .map(|v| v.to_str().unwrap().to_owned()),
                );
                json!({ "data": [{ "id": "z" }, { "id": "a" }] }).to_string()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });

    let dir = tempfile::tempdir().unwrap();
    let (backends, _) = service(dir.path());
    backends
        .save_provider(
            "saved",
            &json!({ "api": "openai-completions", "baseUrl": base, "apiKey": SECRET,
                "models": [{ "id": "m" }] }),
            true,
        )
        .unwrap();
    let form = |extra: Value| {
        let mut body = json!({ "api": "openai-completions", "baseUrl": base });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    let models = backends
        .discover(&form(json!({ "backendId": "saved" })))
        .await
        .unwrap();
    let ids: Vec<_> = models.iter().map(|m| m.model.id.as_str()).collect();
    assert_eq!(ids, ["a", "z"]);
    for extra in [
        json!({ "backendId": "saved", "apiKey": "" }),
        json!({ "backendId": "saved", "apiKey": "typed" }),
        json!({ "backendId": "missing" }),
        json!({ "backendId": "file" }),
    ] {
        backends.discover(&form(extra)).await.unwrap();
    }
    assert_eq!(
        *seen.lock().unwrap(),
        [
            Some(format!("Bearer {SECRET}")),
            None,
            Some("Bearer typed".to_owned()),
            None,
            None,
        ]
    );
    assert_eq!(
        backends
            .discover(&form(json!({ "baseUrl": "ftp://a.example" })))
            .await
            .unwrap_err(),
        invalid_settings()
    );
}

#[tokio::test]
async fn discovery_refuses_redirects_and_never_echoes_bodies() {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use std::sync::Mutex as StdMutex;
    let reply = Arc::new(StdMutex::new(0u8));
    let state = reply.clone();
    let app = axum::Router::new().fallback(move || {
        let state = state.clone();
        async move {
            match *state.lock().unwrap() {
                0 => (StatusCode::UNAUTHORIZED, format!("bad key {SECRET}")).into_response(),
                1 => (StatusCode::FOUND, [("location", "https://evil.example")]).into_response(),
                2 => format!("<html>{SECRET}</html>").into_response(),
                3 => StatusCode::NOT_FOUND.into_response(),
                4 => StatusCode::TOO_MANY_REQUESTS.into_response(),
                6 => "\u{feff}{\"data\":[{\"id\":\"bom\"}]}".into_response(),
                _ => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    let dir = tempfile::tempdir().unwrap();
    let (backends, _) = service(dir.path());
    let mut messages = Vec::new();
    for step in 0..6u8 {
        *reply.lock().unwrap() = step;
        let error = backends
            .discover(&json!({ "api": "openai-chat", "baseUrl": base }))
            .await
            .unwrap_err();
        assert_eq!((error.status, error.code), (502, "node_error"));
        messages.push(error.message);
    }
    assert_eq!(
        messages,
        [
            "The endpoint rejected the API key (HTTP 401). Check the key and try again.",
            "The endpoint redirected the request. Use the final base URL.",
            "The endpoint returned an unrecognized model list.",
            "This endpoint does not list its models (HTTP 404). Add model IDs manually.",
            "The endpoint is rate limiting requests (HTTP 429). Try again later.",
            "The endpoint returned HTTP 502 when listing models.",
        ]
    );
    *reply.lock().unwrap() = 6;
    let listed = backends
        .discover(&json!({ "api": "openai-chat", "baseUrl": base }))
        .await
        .unwrap();
    assert_eq!(listed[0].model.id, "bom");
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unreachable = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let error = backends
        .discover(&json!({ "api": "anthropic-messages", "baseUrl": unreachable }))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Cannot reach the endpoint from the gateway. Check the base URL."
    );
}

#[tokio::test]
async fn probes_are_limited_to_four_at_a_time() {
    let dir = tempfile::tempdir().unwrap();
    let (backends, _) = service(dir.path());
    let slots: Vec<_> = (0..4).map(|_| backends.start_probe().unwrap()).collect();
    assert_eq!(backends.start_probe().err().unwrap().status, 429);
    drop(slots);
    assert!(backends.start_probe().is_ok());
}
