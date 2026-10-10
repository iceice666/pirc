//! Subscription logins and token refresh of [`BackendService`]
//! (`startAuth`, `authStatus`, `authInput`, `cancelAuth`, `refresh` in
//! `backends/service.ts`). Logins run as tokio tasks in the gateway (the TS
//! gateway's isolated worker held third-party code); cancelling a login
//! aborts its task, which closes its callback server.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};
use tokio::task::AbortHandle;

use super::oauth::flows::{BoxFuture, LoginHooks, Prompt};
use super::{
    BackendError, BackendService, Credentials, conflict, invalid, not_found, oauth, own,
    random_uuid, valid_credentials,
};
use crate::stream::now_ms;

/// How logins and refreshes reach the providers; tests replace it.
pub trait OAuthRunner: Send + Sync + 'static {
    fn login(
        &self,
        provider: String,
        hooks: Arc<dyn LoginHooks>,
    ) -> BoxFuture<Result<Credentials, String>>;
    fn refresh(
        &self,
        provider: String,
        credentials: Credentials,
    ) -> BoxFuture<Result<Credentials, String>>;
}

/// The real providers ([`oauth::flows`]).
pub struct ProviderRunner {
    client: reqwest::Client,
    endpoints: oauth::flows::Endpoints,
}

impl ProviderRunner {
    /// Logins use `HTTP(S)_PROXY` and `NO_PROXY`, the only proxy variables
    /// the TS gateway passed to its OAuth worker (not `ALL_PROXY`).
    pub fn new(endpoints: oauth::flows::Endpoints) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let variable = |names: [&str; 2]| {
            names
                .into_iter()
                .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        };
        let mut builder = reqwest::Client::builder().no_proxy();
        let no_proxy = reqwest::NoProxy::from_env();
        if let Some(url) = variable(["HTTPS_PROXY", "https_proxy"])
            && let Ok(proxy) = reqwest::Proxy::https(&url)
        {
            builder = builder.proxy(proxy.no_proxy(no_proxy.clone()));
        }
        if let Some(url) = variable(["HTTP_PROXY", "http_proxy"])
            && let Ok(proxy) = reqwest::Proxy::http(&url)
        {
            builder = builder.proxy(proxy.no_proxy(no_proxy));
        }
        Self {
            client: builder
                .build()
                .expect("the HTTP client builds with the ring provider installed"),
            endpoints,
        }
    }
}

impl OAuthRunner for ProviderRunner {
    fn login(
        &self,
        provider: String,
        hooks: Arc<dyn LoginHooks>,
    ) -> BoxFuture<Result<Credentials, String>> {
        let (client, endpoints) = (self.client.clone(), self.endpoints.clone());
        Box::pin(async move {
            oauth::flows::login(&client, &endpoints, &provider, hooks.as_ref()).await
        })
    }

    fn refresh(
        &self,
        provider: String,
        credentials: Credentials,
    ) -> BoxFuture<Result<Credentials, String>> {
        let (client, endpoints) = (self.client.clone(), self.endpoints.clone());
        Box::pin(async move {
            oauth::flows::refresh(&client, &endpoints, &provider, &credentials).await
        })
    }
}

/// A question shown on the settings page (`AuthPrompt`; pi-ai's `select`
/// prompts are used by none of the three providers and are not ported).
#[derive(Clone, Debug)]
struct PromptView {
    id: String,
    manual: bool,
    message: String,
    placeholder: Option<String>,
    allow_empty: Option<bool>,
}

/// `AuthSession`: what the browser sees of a login.
#[derive(Clone, Debug)]
struct View {
    id: String,
    provider_id: String,
    status: &'static str,
    /// `auth`: URL, instructions, device-flow user code.
    auth: Option<(String, Option<String>, Option<String>)>,
    prompts: Vec<PromptView>,
    progress: Option<String>,
    error: Option<String>,
    expires_at: u64,
}

impl View {
    fn to_json(&self) -> Value {
        let prompts: Vec<Value> = self
            .prompts
            .iter()
            .map(|prompt| {
                let mut out = json!({ "id": prompt.id,
                    "kind": if prompt.manual { "manual" } else { "prompt" },
                    "message": prompt.message });
                if let Some(placeholder) = &prompt.placeholder {
                    out["placeholder"] = json!(placeholder);
                }
                if let Some(allow_empty) = prompt.allow_empty {
                    out["allowEmpty"] = json!(allow_empty);
                }
                out
            })
            .collect();
        let mut out = json!({ "id": self.id, "providerId": self.provider_id,
            "status": self.status, "prompts": prompts, "expiresAt": self.expires_at });
        if let Some((url, instructions, user_code)) = &self.auth {
            let mut auth = json!({ "url": url });
            if let Some(instructions) = instructions {
                auth["instructions"] = json!(instructions);
            }
            if let Some(code) = user_code {
                auth["userCode"] = json!(code);
            }
            out["auth"] = auth;
        }
        if let Some(progress) = &self.progress {
            out["progress"] = json!(progress);
        }
        if let Some(error) = &self.error {
            out["error"] = json!(error);
        }
        out
    }
}

struct Session {
    view: View,
    owner: String,
    generation: u64,
    task: Option<AbortHandle>,
    timer: Option<AbortHandle>,
    /// Unanswered prompts; dropping a sender rejects the prompt.
    answers: HashMap<String, oneshot::Sender<Option<String>>>,
}

type RefreshOutcome = Option<Result<Credentials, ()>>;

/// Login and refresh state (locked before the store's state, never after).
#[derive(Default)]
pub(super) struct AuthState {
    sessions: HashMap<String, Session>,
    generations: HashMap<String, u64>,
    refreshing: HashMap<String, (watch::Receiver<RefreshOutcome>, AbortHandle)>,
}

impl AuthState {
    fn generation(&self, provider: &str) -> u64 {
        self.generations.get(provider).copied().unwrap_or(0)
    }

    /// `finish`: end a login, rejecting its prompts.
    fn finish(&mut self, id: &str, status: &'static str, error: Option<&str>) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        session.view.status = status;
        if let Some(error) = error {
            session.view.error = Some(error.to_owned());
        }
        if let Some(timer) = session.timer.take() {
            timer.abort();
        }
        if let Some(task) = session.task.take() {
            task.abort();
        }
        session.answers.clear();
        session.view.prompts.clear();
        session.view.auth = None;
        session.view.progress = None;
    }

    /// `deleteProvider` of an account: in-flight logins and refreshes lose.
    pub(super) fn sign_out(&mut self, provider: &str) {
        *self.generations.entry(provider.to_owned()).or_default() += 1;
        if let Some((_, task)) = self.refreshing.remove(provider) {
            task.abort();
        }
        let pending: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.view.provider_id == provider && s.view.status == "pending")
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            self.finish(&id, "cancelled", None);
        }
    }

    /// `close()`: every login is cancelled, every refresh aborted.
    pub(super) fn close(&mut self) {
        let pending: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.view.status == "pending")
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            self.finish(&id, "cancelled", None);
        }
        for (_, (_, task)) in self.refreshing.drain() {
            task.abort();
        }
    }
}

/// `text()`: control characters dropped, credentials redacted, at most
/// 2000 UTF-16 units.
fn sanitize(value: &str) -> String {
    use std::sync::LazyLock;
    static SECRET: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
        regex_lite::Regex::new(
            // JavaScript's `\s`, which also covers Unicode spaces.
            r"(?i)(?:Bearer[\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+|(?:access_token|refresh_token|api_key|token)[\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*[:=][\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*)[^\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+",
        )
        .unwrap()
    });
    let cleaned: String = value
        .chars()
        .filter(|&c| !matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}'))
        .collect();
    let redacted = SECRET.replace_all(&cleaned, "[redacted]");
    let mut units = 0;
    redacted
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 2000
        })
        .collect()
}

/// The user code a device flow's instructions carry.
fn user_code(instructions: &str) -> Option<String> {
    use std::sync::LazyLock;
    static CODE: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
        regex_lite::Regex::new(r"(?i)\bcode:\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b").unwrap()
    });
    CODE.captures(instructions)
        .map(|captures| captures[1].to_owned())
}

/// A login's view of its session.
struct SessionHooks {
    service: Weak<BackendService>,
    id: String,
}

impl SessionHooks {
    fn ask(&self, manual: bool, prompt: Prompt) -> BoxFuture<Result<String, String>> {
        let receiver = (|| {
            let service = self.service.upgrade()?;
            let mut auth = service.auth();
            let session = auth.sessions.get_mut(&self.id)?;
            if session.view.status != "pending" || session.answers.len() >= 8 {
                return None;
            }
            let id = random_uuid();
            session.view.prompts.push(PromptView {
                id: id.clone(),
                manual,
                message: prompt.message,
                placeholder: prompt.placeholder,
                allow_empty: prompt.allow_empty,
            });
            let (sender, receiver) = oneshot::channel();
            session.answers.insert(id, sender);
            Some(receiver)
        })();
        Box::pin(async move {
            match receiver {
                Some(receiver) => receiver
                    .await
                    .map(Option::unwrap_or_default)
                    .map_err(|_| "Authorization ended".to_owned()),
                None => Err("OAuth cancelled".to_owned()),
            }
        })
    }
}

impl LoginHooks for SessionHooks {
    fn on_auth(&self, url: &str, instructions: Option<&str>) -> Result<(), String> {
        let Some(service) = self.service.upgrade() else {
            return Ok(());
        };
        let mut auth = service.auth();
        let Some(session) = auth.sessions.get_mut(&self.id) else {
            return Ok(());
        };
        if session.view.status != "pending" {
            return Ok(());
        }
        let parsed = reqwest::Url::parse(url).map_err(|_| "Unsafe authorization URL")?;
        let has = |name: &str| parsed.query_pairs().any(|(key, _)| key == name);
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some_and(|p| !p.is_empty())
            || has("access_token")
            || has("refresh_token")
        {
            return Err("Unsafe authorization URL".to_owned());
        }
        session.view.auth = Some((
            parsed.to_string(),
            instructions.map(sanitize),
            instructions.and_then(user_code),
        ));
        Ok(())
    }

    fn on_progress(&self, text: &str) {
        if let Some(service) = self.service.upgrade()
            && let Some(session) = service.auth().sessions.get_mut(&self.id)
            && session.view.status == "pending"
        {
            session.view.progress = Some(sanitize(text));
        }
    }

    fn prompt(&self, prompt: Prompt) -> BoxFuture<Result<String, String>> {
        self.ask(
            false,
            Prompt {
                message: sanitize(&prompt.message),
                placeholder: prompt.placeholder.as_deref().map(sanitize),
                allow_empty: prompt.allow_empty,
            },
        )
    }

    fn manual(&self) -> BoxFuture<Result<String, String>> {
        self.ask(
            true,
            Prompt {
                message: "Paste the complete localhost callback URL after authorization".to_owned(),
                placeholder: None,
                allow_empty: Some(false),
            },
        )
    }
}

/// `validateCallback`: the pasted URL is the expected localhost callback
/// with this login's state and exactly one code.
fn valid_callback(view: &View, value: &str) -> bool {
    let check = || -> Option<bool> {
        let url = reqwest::Url::parse(value).ok()?;
        let auth = reqwest::Url::parse(&view.auth.as_ref()?.0).ok()?;
        let param = |url: &reqwest::Url, name: &str| -> Vec<String> {
            url.query_pairs()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
                .collect()
        };
        let redirect = reqwest::Url::parse(param(&auth, "redirect_uri").first()?).ok()?;
        let state = param(&auth, "state").into_iter().next();
        let states = param(&url, "state");
        let codes = param(&url, "code");
        Some(
            url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.origin() == redirect.origin()
                && url.path() == redirect.path()
                && url.username().is_empty()
                && url.password().is_none_or(str::is_empty)
                && url.fragment().is_none_or(str::is_empty)
                && state.as_deref().is_some_and(|s| !s.is_empty())
                && states.first() == state.as_ref()
                && codes.first().is_some_and(|c| !c.is_empty())
                && states.len() == 1
                && codes.len() == 1,
        )
    };
    check().unwrap_or(false)
}

/// The GitHub Enterprise domain prompt: an HTTPS host without path,
/// port, query or credentials.
fn valid_enterprise_domain(value: &str) -> bool {
    let text = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    reqwest::Url::parse(&text).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none_or(str::is_empty)
            && url.fragment().is_none_or(str::is_empty)
            && url.path() == "/"
    })
}

impl BackendService {
    /// `startAuth`: begin a subscription login for `owner`.
    pub fn start_auth(
        &self,
        owner: &str,
        provider_id: &str,
        policy_consent: bool,
    ) -> Result<Value, BackendError> {
        self.check_open()?;
        if oauth::info(provider_id).is_none() {
            return Err(invalid("Unknown OAuth provider"));
        }
        let reserved = format!("oauth:{provider_id}");
        if own(&self.lock().baseline.providers, &reserved) {
            return Err(conflict("File-managed backend ID is reserved"));
        }
        if provider_id == "github-copilot" && !policy_consent {
            return Err(invalid(
                "Explicit consent to enable known GitHub Copilot models is required",
            ));
        }
        let mut auth = self.auth();
        // `close()` sets the flag before it drains under this lock.
        self.check_open()?;
        if auth
            .sessions
            .values()
            .any(|s| s.view.provider_id == provider_id && s.view.status == "pending")
        {
            return Err(conflict("A login for this provider is already in progress"));
        }
        let now = now_ms();
        auth.sessions
            .retain(|_, s| s.view.status == "pending" || s.view.expires_at >= now);
        if auth.sessions.len() >= 32 {
            return Err(conflict("Too many authorization sessions; try again later"));
        }
        let id = random_uuid();
        let timeout = self.session_timeout;
        let expires_at = now + timeout.as_millis() as u64;
        let view = View {
            id: id.clone(),
            provider_id: provider_id.to_owned(),
            status: "pending",
            auth: None,
            prompts: Vec::new(),
            progress: None,
            error: None,
            expires_at,
        };
        let generation = auth.generation(provider_id);
        let weak = self.weak.clone();
        let timer = {
            let (weak, id) = (weak.clone(), id.clone());
            tokio::spawn(async move {
                tokio::time::sleep(timeout.max(Duration::from_millis(1))).await;
                if let Some(service) = weak.upgrade() {
                    let mut auth = service.auth();
                    // A login that ended while the timer fired stays as it ended.
                    if auth
                        .sessions
                        .get(&id)
                        .is_some_and(|s| s.view.status == "pending")
                    {
                        auth.finish(&id, "expired", None);
                    }
                }
            })
        };
        let hooks: Arc<dyn LoginHooks> = Arc::new(SessionHooks {
            service: weak.clone(),
            id: id.clone(),
        });
        let login = self.runner.login(provider_id.to_owned(), hooks);
        let task = {
            let (weak, id, provider) = (weak, id.clone(), provider_id.to_owned());
            tokio::spawn(async move {
                let result = login.await;
                if let Some(service) = weak.upgrade() {
                    service.complete_login(&id, &provider, generation, result);
                }
            })
        };
        auth.sessions.insert(
            id,
            Session {
                view: view.clone(),
                owner: owner.to_owned(),
                generation,
                task: Some(task.abort_handle()),
                timer: Some(timer.abort_handle()),
                answers: HashMap::new(),
            },
        );
        Ok(view.to_json())
    }

    /// A login's result: saved only while its session is pending and no
    /// sign-out or shutdown happened in between.
    fn complete_login(
        &self,
        id: &str,
        provider: &str,
        generation: u64,
        result: Result<Credentials, String>,
    ) {
        let mut auth = self.auth();
        let Some(session) = auth.sessions.get_mut(id) else {
            return;
        };
        // The task is ending: finishing must not abort it.
        session.task = None;
        if session.view.status != "pending" {
            return;
        }
        let session_generation = session.generation;
        let failed = |auth: &mut AuthState| {
            auth.finish(id, "failed", Some("Authorization failed. Please retry."));
        };
        let credentials = match result {
            Ok(credentials) if valid_credentials(&credentials) => credentials,
            _ => return failed(&mut auth),
        };
        if session_generation != generation
            || generation != auth.generation(provider)
            || self.closed()
        {
            return;
        }
        let mut inner = self.lock();
        if own(&inner.baseline.providers, &format!("oauth:{provider}")) {
            drop(inner);
            return failed(&mut auth);
        }
        let mut next = inner.state.clone();
        next.oauth.insert(provider.to_owned(), credentials);
        if self.commit(&mut inner, next).is_err() {
            drop(inner);
            return failed(&mut auth);
        }
        drop(inner);
        auth.finish(id, "succeeded", None);
        drop(auth);
        self.changed();
    }

    /// `session(owner, id)`: a login of `owner`; an overdue pending one expires.
    fn with_session<T>(
        &self,
        owner: &str,
        id: &str,
        f: impl FnOnce(&mut AuthState) -> Result<T, BackendError>,
    ) -> Result<T, BackendError> {
        let mut auth = self.auth();
        let session = auth.sessions.get(id).filter(|s| s.owner == owner);
        let Some(session) = session else {
            return Err(not_found());
        };
        if session.view.status == "pending" && session.view.expires_at <= now_ms() {
            auth.finish(id, "expired", None);
        }
        f(&mut auth)
    }

    /// `authStatus`.
    pub fn auth_status(&self, owner: &str, id: &str) -> Result<Value, BackendError> {
        self.with_session(owner, id, |auth| Ok(auth.sessions[id].view.to_json()))
    }

    /// `cancelAuth`: end a pending login.
    pub fn cancel_auth(&self, owner: &str, id: &str) -> Result<Value, BackendError> {
        self.with_session(owner, id, |auth| {
            if auth.sessions[id].view.status == "pending" {
                auth.finish(id, "cancelled", None);
            }
            Ok(auth.sessions[id].view.to_json())
        })
    }

    /// `authInput`: answer one of a login's prompts.
    pub fn auth_input(
        &self,
        owner: &str,
        id: &str,
        prompt_id: &str,
        value: Option<&str>,
    ) -> Result<Value, BackendError> {
        self.with_session(owner, id, |auth| {
            let session = auth.sessions.get_mut(id).expect("checked by with_session");
            if session.view.status != "pending" {
                return Err(conflict("Authorization session is no longer pending"));
            }
            let prompt = session.view.prompts.iter().find(|p| p.id == prompt_id);
            let (Some(prompt), true) = (prompt, session.answers.contains_key(prompt_id)) else {
                return Err(conflict("Prompt is no longer pending"));
            };
            if value.is_some_and(|v| v.encode_utf16().count() > 16_384) {
                return Err(invalid("Invalid authorization input"));
            }
            let Some(value) = value
                .filter(|v| !crate::js::trim(v).is_empty() || prompt.allow_empty == Some(true))
            else {
                return Err(invalid("A response is required"));
            };
            let provider = session.view.provider_id.as_str();
            if (prompt.manual || matches!(provider, "anthropic" | "openai-codex"))
                && !valid_callback(&session.view, value)
            {
                return Err(invalid(
                    "Paste the complete expected localhost callback URL with matching authorization state",
                ));
            }
            if !prompt.manual
                && provider == "github-copilot"
                && !crate::js::trim(value).is_empty()
                && !valid_enterprise_domain(value)
            {
                return Err(invalid(
                    "Enter an HTTPS GitHub Enterprise domain without path or credentials",
                ));
            }
            let sender = session.answers.remove(prompt_id).expect("checked above");
            session.view.prompts.retain(|p| p.id != prompt_id);
            let _ = sender.send(Some(value.to_owned()));
            Ok(session.view.to_json())
        })
    }

    /// `refresh`: one refresh per account at a time; callers share it. The
    /// result is saved (without a change notification) only if the account
    /// was not signed out meanwhile.
    pub(super) async fn refresh(
        &self,
        provider: &str,
        credentials: Credentials,
    ) -> Result<Credentials, BackendError> {
        let failed = || {
            BackendError::new(
                502,
                "node_error",
                "Backend authorization refresh failed; sign in again",
            )
        };
        let mut receiver = {
            let mut auth = self.auth();
            if self.closed() {
                return Err(failed());
            }
            match auth.refreshing.get(provider) {
                Some((receiver, _)) => receiver.clone(),
                None => {
                    // Revision check: a refresh that finished since the caller
                    // read the credentials already rotated them; refreshing
                    // again would spend the old refresh token.
                    if let Some(saved) = self.lock().state.oauth.get(provider)
                        && *saved != credentials
                    {
                        return Ok(saved.clone());
                    }
                    let generation = auth.generation(provider);
                    let (sender, receiver) = watch::channel(None);
                    let refresh = self.runner.refresh(provider.to_owned(), credentials);
                    let weak = self.weak.clone();
                    let name = provider.to_owned();
                    let watched = receiver.clone();
                    let task = tokio::spawn(async move {
                        let fresh = tokio::time::timeout(Duration::from_secs(60), refresh).await;
                        let outcome = match (fresh, weak.upgrade()) {
                            (Ok(Ok(fresh)), Some(service)) if valid_credentials(&fresh) => {
                                service.save_refresh(&name, generation, fresh)
                            }
                            _ => Err(()),
                        };
                        let _ = sender.send(Some(outcome));
                        if let Some(service) = weak.upgrade() {
                            let mut auth = service.auth();
                            if auth
                                .refreshing
                                .get(&name)
                                .is_some_and(|(r, _)| r.same_channel(&watched))
                            {
                                auth.refreshing.remove(&name);
                            }
                        }
                    });
                    auth.refreshing
                        .insert(provider.to_owned(), (receiver.clone(), task.abort_handle()));
                    receiver
                }
            }
        };
        let outcome = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| failed())?
            .clone();
        match outcome {
            Some(Ok(fresh)) => Ok(fresh),
            _ => Err(failed()),
        }
    }

    fn save_refresh(
        &self,
        provider: &str,
        generation: u64,
        fresh: Credentials,
    ) -> Result<Credentials, ()> {
        let auth = self.auth();
        if self.closed() || generation != auth.generation(provider) {
            return Err(());
        }
        let mut inner = self.lock();
        if !inner.state.oauth.contains_key(provider) {
            return Err(());
        }
        let mut next = inner.state.clone();
        next.oauth.insert(provider.to_owned(), fresh.clone());
        self.commit(&mut inner, next).map_err(|_| ())?;
        drop(auth);
        Ok(fresh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_shown_text() {
        assert_eq!(sanitize("a\u{1}b\tc\n"), "ab\tc\n");
        assert_eq!(
            sanitize("Sign in Bearer abc.def and token=xyz, access_token: q"),
            "Sign in [redacted] and [redacted] [redacted]"
        );
        assert_eq!(sanitize(&"é".repeat(3000)).chars().count(), 2000);
        assert_eq!(sanitize("Bearer\u{a0}secret ok"), "[redacted] ok");
    }

    #[test]
    fn finds_device_codes() {
        assert_eq!(
            user_code("Enter code: ABCD-1234").as_deref(),
            Some("ABCD-1234")
        );
        assert_eq!(user_code("no code here"), None);
    }

    #[test]
    fn callback_urls() {
        let view = View {
            id: "s".to_owned(),
            provider_id: "openai-codex".to_owned(),
            status: "pending",
            auth: Some((
                "https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc".to_owned(),
                None,
                None,
            )),
            prompts: Vec::new(),
            progress: None,
            error: None,
            expires_at: 0,
        };
        assert!(valid_callback(
            &view,
            "http://localhost:1455/auth/callback?code=c&state=abc"
        ));
        for bad in [
            "http://localhost:1455/auth/callback?code=c&state=nope",
            "http://localhost:1455/auth/callback?code=c",
            "http://localhost:1455/auth/callback?state=abc",
            "http://localhost:1455/auth/callback?code=c&code=d&state=abc",
            "http://localhost:1455/auth/callback?code=c&state=abc&state=abc",
            "http://127.0.0.1:1455/auth/callback?code=c&state=abc",
            "http://localhost:1456/auth/callback?code=c&state=abc",
            "http://localhost:1455/other?code=c&state=abc",
            "http://u:p@localhost:1455/auth/callback?code=c&state=abc",
            "http://localhost:1455/auth/callback?code=c&state=abc#x",
            "https://localhost:1455/auth/callback?code=c&state=abc",
            "the-code",
        ] {
            assert!(!valid_callback(&view, bad), "{bad}");
        }
    }

    #[test]
    fn enterprise_domains() {
        for good in ["ghe.example", "https://ghe.example", "https://ghe.example/"] {
            assert!(valid_enterprise_domain(good), "{good}");
        }
        for bad in [
            "http://ghe.example",
            "ghe.example/path",
            "ghe.example:8443",
            "https://u@ghe.example",
            "ghe.example?x=1",
        ] {
            assert!(!valid_enterprise_domain(bad), "{bad}");
        }
    }
}
