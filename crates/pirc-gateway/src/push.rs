//! Push notifications to browsers and phones
//! (`apps/gateway/src/daemon/push.ts`, `push-routes.ts`): Web Push to
//! browsers, and the same protocol to phones through UnifiedPush. Payloads
//! are encrypted for the subscriber (RFC 8291, `aes128gcm`) and signed with
//! the gateway's VAPID key (RFC 8292), as the `web-push` library did, so the
//! push service relays them without reading them. They still say little: a
//! title, a short line and where to open, never an agent's answer.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use axum::Router;
use axum::extract::{Extension, State};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use pirc_config::{Env, js_space};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::mpsc;
use url::Url;

use crate::app::{App, AppState, ReqBody};
use crate::auth::Identity;
use crate::db::{Db, Store};
use crate::error::{ApiError, ApiResult, json_response};
use crate::events::{EventHub, GatewayEvent};
use crate::http::{no_content, ok};
use crate::routes::Handled;
use crate::util::{new_id, now_ms, present, random_bytes};

/// One notification (`PushMessage`): `target` is what it opens:
/// `{roomId}` ([`room_target`]), `{sessionId}` (the engine), `{memory: true}`,
/// or `{}` for nothing in particular.
#[derive(Clone, Debug)]
pub struct PushMessage {
    pub title: String,
    pub body: String,
    /// Notifications with the same tag replace each other on the device.
    pub tag: String,
    pub target: Value,
    /// Exact question metadata for create/revoke pushes. Refresh hints omit the tuple.
    pub interaction: Option<InteractionPush>,
}

/// The target of a notification about a room: clients open the room
/// (the web at `/?room=<id>`). Rooms push their own tag, `room:<id>`, so
/// a newer notification about a room replaces the older one.
#[allow(dead_code, reason = "room notifications start with plans 05 to 07")]
pub fn room_message(room_id: &str, title: String, body: String) -> PushMessage {
    PushMessage {
        title,
        body,
        tag: format!("room:{room_id}"),
        target: room_target(room_id),
        interaction: None,
    }
}

pub fn room_target(room_id: &str) -> Value {
    json!({ "roomId": room_id })
}

#[derive(Clone, Debug)]
pub struct InteractionPush {
    pub kind: &'static str,
    pub session_id: String,
    pub interaction_id: Option<String>,
    pub interaction_epoch: Option<String>,
}

/// A push service's answer before giving up on it for this message.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a push service keeps an undelivered message (a phone offline for a while).
const TTL_SECONDS: u32 = 24 * 3600;
/// Consecutive failures after which a subscription is dropped.
const MAX_FAILURES: i64 = 20;
/// `web-push`'s VAPID JWT lifetime (12 hours).
const VAPID_EXPIRATION_SECONDS: i64 = 12 * 60 * 60;
/// `http_ece`'s record size; payloads are far smaller, so one record.
const RECORD_SIZE: usize = 4096;
/// Per record: the delimiter byte and the AES-GCM tag.
const RECORD_OVERHEAD: usize = 1 + 16;
/// The endpoints `web-push` sends GCM's own authorization to (never VAPID).
const GCM_ENDPOINT: &str = "https://android.googleapis.com/gcm/send";

// ---------------------------------------------------------------------------
// VAPID keys

/// The gateway's VAPID key pair, URL-safe base64 without padding: the
/// uncompressed P-256 public point (65 bytes) and the private scalar (32).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VapidKeys {
    pub public_key: String,
    pub private_key: String,
}

/// A fresh key pair (`webpush.generateVAPIDKeys`).
pub fn generate_vapid_keys() -> VapidKeys {
    let secret = loop {
        if let Ok(secret) = SecretKey::from_slice(&random_bytes::<32>()) {
            break secret;
        }
    };
    VapidKeys {
        public_key: URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes()),
        private_key: URL_SAFE_NO_PAD.encode(secret.to_bytes()),
    }
}

/// The gateway's VAPID key pair (`loadVapidKeys`): from
/// `PIRC_VAPID_PUBLIC_KEY` and `PIRC_VAPID_PRIVATE_KEY`, else made once and
/// kept in `<stateDir>/vapid.json`. A new key pair invalidates every
/// subscription, so it must outlive restarts.
pub fn load_vapid_keys(state_dir: &Path, env: &Env) -> Result<VapidKeys, String> {
    let var = |name: &str| {
        env.get(name)
            .map(|value| value.trim_matches(js_space))
            .filter(|value| !value.is_empty())
    };
    let public_key = var("PIRC_VAPID_PUBLIC_KEY");
    let private_key = var("PIRC_VAPID_PRIVATE_KEY");
    if public_key.is_some() || private_key.is_some() {
        let (Some(public_key), Some(private_key)) = (public_key, private_key) else {
            return Err(
                "Set both PIRC_VAPID_PUBLIC_KEY and PIRC_VAPID_PRIVATE_KEY, or neither".into(),
            );
        };
        return Ok(VapidKeys {
            public_key: public_key.to_owned(),
            private_key: private_key.to_owned(),
        });
    }
    let file = state_dir.join("vapid.json");
    if file.exists() {
        let text = fs::read_to_string(&file)
            .map_err(|error| format!("cannot read {}: {error}", file.display()))?;
        let stored: Value = serde_json::from_str(&text)
            .map_err(|error| format!("{} is not JSON: {error}", file.display()))?;
        let field = |name: &str| {
            stored
                .get(name)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        return match (field("publicKey"), field("privateKey")) {
            (Some(public_key), Some(private_key)) => Ok(VapidKeys {
                public_key,
                private_key,
            }),
            _ => Err(format!("{} holds no VAPID key pair", file.display())),
        };
    }
    let keys = generate_vapid_keys();
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state_dir)
        .map_err(|error| format!("cannot create {}: {error}", state_dir.display()))?;
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .map_err(|error| format!("cannot create {}: {error}", file.display()))?;
    out.write_all(serde_json::to_string(&keys).unwrap_or_default().as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", file.display()))?;
    Ok(keys)
}

// ---------------------------------------------------------------------------
// Web Push (what `web-push`'s `generateRequestDetails` and `http_ece` did)

/// `Buffer.from(text, 'base64url')`: either alphabet's padding, trailing
/// bits and a dangling last character are tolerated.
fn decode_base64url(text: &str) -> Result<Vec<u8>, String> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let mut text = text
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_");
    if text.len() % 4 == 1 {
        text.pop();
    }
    LENIENT
        .decode(text)
        .map_err(|error| format!("invalid base64: {error}"))
}

/// `urlBase64Helper.validate`.
fn is_url_base64(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `info` for the key derivation of RFC 8291 section 3.4.
fn webpush_info(ua_public: &[u8], as_public: &[u8]) -> Vec<u8> {
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(ua_public);
    info.extend_from_slice(as_public);
    info
}

/// The content encryption key and nonce of an `aes128gcm` message (RFC 8188).
fn content_key(ikm: &[u8], salt: &[u8]) -> ([u8; 16], [u8; 12]) {
    let prk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut key = [0; 16];
    let mut nonce = [0; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .expect("16 bytes is a valid HKDF length");
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("12 bytes is a valid HKDF length");
    (key, nonce)
}

/// The nonce of record `counter`: the base nonce XOR the counter.
fn record_nonce(base: &[u8; 12], counter: u64) -> [u8; 12] {
    let mut nonce = *base;
    for (byte, counter_byte) in nonce[4..].iter_mut().zip(counter.to_be_bytes()) {
        *byte ^= counter_byte;
    }
    nonce
}

/// RFC 8291 encryption of `plaintext` for the subscriber's `p256dh` key
/// and `auth` secret, from `local` (the ephemeral key) with `salt`: the
/// `aes128gcm` header (salt, record size, key id = `local`'s public key)
/// and records of 4096 bytes, no padding.
pub fn encrypt(
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
    salt: &[u8; 16],
    local: &SecretKey,
) -> Result<Vec<u8>, String> {
    let ua = PublicKey::from_sec1_bytes(ua_public)
        .map_err(|_| "The subscription p256dh value is not a P-256 public key".to_owned())?;
    let shared = p256::ecdh::diffie_hellman(local.to_nonzero_scalar(), ua.as_affine());
    let local_public = local.public_key().to_encoded_point(false);
    let mut ikm = [0; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
        .expand(&webpush_info(ua_public, local_public.as_bytes()), &mut ikm)
        .expect("32 bytes is a valid HKDF length");
    let (key, base_nonce) = content_key(&ikm, salt);
    let cipher = Aes128Gcm::new(&key.into());

    let mut out = Vec::with_capacity(86 + plaintext.len() + RECORD_OVERHEAD);
    out.extend_from_slice(salt);
    out.extend_from_slice(&(RECORD_SIZE as u32).to_be_bytes());
    out.push(local_public.as_bytes().len() as u8);
    out.extend_from_slice(local_public.as_bytes());
    let chunk = RECORD_SIZE - RECORD_OVERHEAD;
    let mut start = 0;
    let mut counter = 0;
    loop {
        let end = start + chunk;
        let last = end >= plaintext.len();
        let mut record = plaintext[start..end.min(plaintext.len())].to_vec();
        record.push(if last { 2 } else { 1 });
        let nonce = record_nonce(&base_nonce, counter);
        let sealed = cipher
            .encrypt(Nonce::from_slice(&nonce), record.as_slice())
            .map_err(|_| "encryption failed".to_owned())?;
        out.extend_from_slice(&sealed);
        if last {
            return Ok(out);
        }
        start = end;
        counter += 1;
    }
}

/// `encryptionHelper.encrypt` with a new ephemeral key and salt.
fn encrypt_for(p256dh: &str, auth: &str, payload: &str) -> Result<Vec<u8>, String> {
    let ua_public = decode_base64url(p256dh)?;
    if ua_public.len() != 65 {
        return Err("The subscription p256dh value should be 65 bytes long.".into());
    }
    let auth = decode_base64url(auth)?;
    if auth.len() < 16 {
        return Err("The subscription auth key should be at least 16 bytes long".into());
    }
    let local = loop {
        if let Ok(secret) = SecretKey::from_slice(&random_bytes::<32>()) {
            break secret;
        }
    };
    encrypt(
        &ua_public,
        &auth,
        payload.as_bytes(),
        &random_bytes::<16>(),
        &local,
    )
}

/// The push service's origin as `web-push` wrote the JWT's `aud`:
/// `url.parse`'s protocol and host (an explicit port kept, even the default).
fn audience(endpoint: &str) -> Result<String, String> {
    let url =
        // The message names the host only: the endpoint is a capability URL.
        Url::parse(endpoint).map_err(|_| format!("VAPID audience is not a url. {}", host_of(endpoint)))?;
    let host = url.host_str().unwrap_or_default();
    let authority = endpoint
        .split_once("://")
        .map_or("", |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let after_host = authority
        .rfind(']')
        .map_or(authority, |at| &authority[at..]);
    let port = after_host
        .rsplit_once(':')
        .map(|(_, port)| port)
        .filter(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    Ok(match port {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// `vapidHelper.getVapidHeaders` for `aes128gcm`: `vapid t=<JWT>, k=<key>`.
pub fn vapid_authorization(
    audience: &str,
    subject: &str,
    keys: &VapidKeys,
    now_ms: i64,
) -> Result<String, String> {
    let parsed =
        Url::parse(subject).map_err(|_| format!("Vapid subject is not a valid URL. {subject}"))?;
    if !matches!(parsed.scheme(), "https" | "mailto") {
        return Err(format!(
            "Vapid subject is not an https: or mailto: URL. {subject}"
        ));
    }
    if parsed.host_str() == Some("localhost") {
        crate::log::warn(
            "Vapid subject points to a localhost web URI, which is unsupported by Apple's push \
             notification server and will result in a BadJwtToken error when sending notifications.",
        );
    }
    if !is_url_base64(&keys.public_key) {
        return Err("Vapid public key must be a URL safe Base 64 (without \"=\")".into());
    }
    if decode_base64url(&keys.public_key)?.len() != 65 {
        return Err("Vapid public key should be 65 bytes long when decoded.".into());
    }
    if !is_url_base64(&keys.private_key) {
        return Err("Vapid private key must be a URL safe Base 64 (without \"=\")".into());
    }
    let private = decode_base64url(&keys.private_key)?;
    if private.len() != 32 {
        return Err("Vapid private key should be 32 bytes long when decoded.".into());
    }
    let signer =
        SigningKey::from_slice(&private).map_err(|_| "Invalid VAPID private key".to_owned())?;
    let header = URL_SAFE_NO_PAD.encode(r#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = json!({
        "aud": audience,
        "exp": now_ms.div_euclid(1000) + VAPID_EXPIRATION_SECONDS,
        "sub": subject,
    });
    let input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
    let signature: Signature = signer.sign(input.as_bytes());
    let jwt = format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()));
    Ok(format!("vapid t={jwt}, k={}", keys.public_key))
}

/// The `Topic` header allows at most 32 URL-safe base64 characters.
pub fn topic_of(tag: &str) -> String {
    let mut hash: i32 = 0;
    // `for (const char of tag)` with `char.charCodeAt(0)`: per code point,
    // its first UTF-16 unit.
    for c in tag.chars() {
        let mut units = [0; 2];
        let first = c.encode_utf16(&mut units)[0];
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(first));
    }
    let topic = format!(
        "t{}{}",
        base36(u64::from(hash as u32)),
        base36(tag.encode_utf16().count() as u64)
    );
    topic.chars().take(32).collect()
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `clip` in UTF-16 units: at most `max`, cut with an ellipsis (JS strings
/// may end in half a surrogate pair, so the result stays UTF-16).
fn clip(text: &str, max: usize) -> Vec<u16> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return units;
    }
    units.truncate(max - 1);
    // `trimEnd()`: JS whitespace (all of it in the BMP).
    while units
        .last()
        .and_then(|&unit| char::from_u32(u32::from(unit)))
        .is_some_and(js_space)
    {
        units.pop();
    }
    units.push(0x2026);
    units
}

/// `JSON.stringify` of a JS string (lone surrogates escaped).
fn js_json_string(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

/// What the subscriber decrypts: `{title, body, tag, target, at}`.
fn payload(message: &PushMessage, at: i64) -> String {
    let tag: Vec<u16> = message.tag.encode_utf16().collect();
    let interaction = message
        .interaction
        .as_ref()
        .map(|interaction| {
            let mut fields = format!(
                ",\"kind\":{},\"sessionId\":{}",
                serde_json::to_string(interaction.kind).unwrap_or_else(|_| "null".into()),
                serde_json::to_string(&interaction.session_id).unwrap_or_else(|_| "null".into()),
            );
            if let Some(id) = &interaction.interaction_id {
                fields.push_str(&format!(
                    ",\"interactionId\":{}",
                    serde_json::to_string(id).unwrap_or_else(|_| "null".into()),
                ));
            }
            if let Some(epoch) = &interaction.interaction_epoch {
                fields.push_str(&format!(
                    ",\"interactionEpoch\":{}",
                    serde_json::to_string(epoch).unwrap_or_else(|_| "null".into()),
                ));
            }
            fields
        })
        .unwrap_or_default();
    format!(
        r#"{{"title":{},"body":{},"tag":{},"target":{},"at":{at}{interaction}}}"#,
        js_json_string(&clip(&message.title, 120)),
        js_json_string(&clip(&message.body, 240)),
        js_json_string(&tag),
        serde_json::to_string(&message.target).unwrap_or_else(|_| "null".into()),
    )
}

// ---------------------------------------------------------------------------
// Subscriptions

/// A subscription as the routes accept it (`subscriptionBody`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionInput {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
    /// `web` (a browser) or `unifiedpush` (the Android app); default `web`.
    #[serde(default, deserialize_with = "present")]
    pub kind: Option<String>,
    /// Shown in the list of places that get notifications.
    #[serde(default, deserialize_with = "present")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// `^[A-Za-z0-9_-]{min,max}={0,2}$`
fn key_shaped(text: &str, min: usize, max: usize) -> bool {
    let body = text.trim_end_matches('=');
    text.len() - body.len() <= 2
        && (min..=max).contains(&body.len())
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

impl SubscriptionInput {
    /// The zod schema's checks; `name` comes back trimmed.
    fn validate(mut self) -> ApiResult<Self> {
        let endpoint_ok = utf16_len(&self.endpoint) <= 2000 && Url::parse(&self.endpoint).is_ok();
        let keys_ok = key_shaped(&self.keys.p256dh, 80, 100) && key_shaped(&self.keys.auth, 16, 32);
        let kind = self.kind.get_or_insert_with(|| "web".into());
        let kind_ok = kind == "web" || kind == "unifiedpush";
        if let Some(name) = &mut self.name {
            *name = name.trim_matches(js_space).to_owned();
        }
        let name_ok = self
            .name
            .as_deref()
            .is_none_or(|name| utf16_len(name) <= 100);
        if endpoint_ok && keys_ok && kind_ok && name_ok {
            Ok(self)
        } else {
            Err(ApiError::invalid_input())
        }
    }
}

struct SubscriptionRow {
    id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
    kind: String,
    name: Option<String>,
    created_at: i64,
    last_success_at: Option<i64>,
    failures: i64,
}

impl SubscriptionRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            endpoint: row.get("endpoint")?,
            p256dh: row.get("p256dh")?,
            auth: row.get("auth")?,
            kind: row.get("kind")?,
            name: row.get("name")?,
            created_at: row.get("created_at")?,
            last_success_at: row.get("last_success_at")?,
            failures: row.get("failures")?,
        })
    }
}

/// `new URL(endpoint).host`.
fn host_of(endpoint: &str) -> String {
    let Ok(url) = Url::parse(endpoint) else {
        return String::new();
    };
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        _ => String::new(),
    }
}

/// A push request's headers, in the order `web-push` set them.
type Headers = Vec<(&'static str, String)>;

/// Push notifications for the users of one gateway (`Push`).
pub struct Push {
    db: Arc<Db>,
    vapid: VapidKeys,
    /// `mailto:` or `https:` contact the push services may use (PIRC_VAPID_SUBJECT).
    subject: String,
    /// Plain http endpoints are refused unless this allows them (tests, loopback distributors).
    allow_http: bool,
    client: reqwest::Client,
}

impl Push {
    pub fn new(db: Arc<Db>, vapid: VapidKeys, subject: String, allow_http: bool) -> Self {
        // ring, as in pirc-providers: no aws-lc.
        let _ = rustls::crypto::ring::default_provider().install_default();
        // Direct connections, as Node's fetch made them (no proxy variables).
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client builds with the ring provider installed");
        Self {
            db,
            vapid,
            subject,
            allow_http,
            client,
        }
    }

    pub fn public_key(&self) -> &str {
        &self.vapid.public_key
    }

    /// Where the user gets notifications (endpoints are shown by host only).
    pub fn list(&self, user: &str) -> ApiResult<Vec<Value>> {
        let conn = self.db.lock();
        prune(&conn)?;
        let mut statement = conn
            .prepare("SELECT * FROM push_subscriptions WHERE owner_user=? ORDER BY created_at")?;
        let rows = statement
            .query_map([user], SubscriptionRow::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let host = host_of(&row.endpoint);
                json!({
                    "id": row.id,
                    "kind": row.kind,
                    "name": row.name.unwrap_or_else(|| host.clone()),
                    "host": host,
                    "createdAt": row.created_at,
                    "lastSuccessAt": row.last_success_at,
                    "failing": row.failures > 0,
                })
            })
            .collect())
    }

    /// Add or refresh a subscription; one endpoint belongs to one user.
    pub fn subscribe(
        &self,
        user: &str,
        input: &SubscriptionInput,
        device_id: Option<&str>,
    ) -> ApiResult<Value> {
        let url = Url::parse(&input.endpoint).map_err(|_| ApiError::invalid_input())?;
        if url.scheme() != "https" && !(self.allow_http && url.scheme() == "http") {
            return Err(ApiError::new(
                400,
                "invalid_input",
                "A push endpoint must use https",
            ));
        }
        if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty())
        {
            return Err(ApiError::new(
                400,
                "invalid_input",
                "A push endpoint cannot carry credentials",
            ));
        }
        let id = {
            let conn = self.db.lock();
            let existing: Option<(String, String)> = conn
                .query_row(
                    "SELECT id, owner_user FROM push_subscriptions WHERE endpoint=?",
                    [&input.endpoint],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let id = match existing {
                Some((id, owner)) if owner == user => id,
                Some((id, _)) => {
                    conn.execute("DELETE FROM push_subscriptions WHERE id=?", [&id])?;
                    new_id("push")
                }
                None => new_id("push"),
            };
            let name = input
                .name
                .as_deref()
                .filter(|name| !name.is_empty())
                .map(|name| String::from_utf16_lossy(&clip(name, 100)));
            conn.execute(
                "INSERT INTO push_subscriptions (id,owner_user,endpoint,p256dh,auth,kind,name,device_id,created_at,failures)
                 VALUES (?,?,?,?,?,?,?,?,?,0)
                 ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, kind=excluded.kind,
                   name=excluded.name, device_id=excluded.device_id, failures=0",
                params![
                    id,
                    user,
                    input.endpoint,
                    input.keys.p256dh,
                    input.keys.auth,
                    input.kind.as_deref().unwrap_or("web"),
                    name,
                    device_id,
                    now_ms(),
                ],
            )?;
            id
        };
        self.list(user)?
            .into_iter()
            .find(|item| item["id"] == id.as_str())
            .ok_or_else(ApiError::internal)
    }

    /// Stop notifying one endpoint (by endpoint, as the device knows it) or
    /// subscription id.
    pub fn unsubscribe(
        &self,
        user: &str,
        endpoint: Option<&str>,
        id: Option<&str>,
    ) -> ApiResult<bool> {
        let changes = self.db.lock().execute(
            "DELETE FROM push_subscriptions WHERE owner_user=? AND (endpoint=? OR id=?)",
            params![user, endpoint.unwrap_or_default(), id.unwrap_or_default()],
        )?;
        Ok(changes > 0)
    }

    /// Send `message` to every place `user` gets notifications; how many
    /// took it. Never fails: a push that cannot be delivered is only
    /// logged, and dead endpoints go.
    pub async fn notify(self: &Arc<Self>, user: &str, message: &PushMessage) -> usize {
        let rows = {
            let conn = self.db.lock();
            let rows = prune(&conn).and_then(|()| {
                conn.prepare("SELECT * FROM push_subscriptions WHERE owner_user=?")?
                    .query_map([user], SubscriptionRow::from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            });
            match rows {
                Ok(rows) => rows,
                Err(error) => {
                    crate::log::warn(&format!("push: cannot read subscriptions: {error}"));
                    return 0;
                }
            }
        };
        let payload = Arc::new(payload(message, now_ms()));
        let topic = Arc::new(topic_of(&message.tag));
        let mut sends = tokio::task::JoinSet::new();
        for row in rows {
            let push = self.clone();
            let (payload, topic) = (payload.clone(), topic.clone());
            sends.spawn(async move { push.send(row, &payload, &topic).await });
        }
        let mut delivered = 0;
        while let Some(sent) = sends.join_next().await {
            delivered += usize::from(sent.unwrap_or(false));
        }
        delivered
    }

    /// The request `web-push` would make: its headers and encrypted body.
    fn request(
        &self,
        row: &SubscriptionRow,
        payload: &str,
        topic: &str,
    ) -> Result<(Headers, Vec<u8>), String> {
        let body = encrypt_for(&row.p256dh, &row.auth, payload)?;
        let mut headers = vec![
            ("TTL", TTL_SECONDS.to_string()),
            ("Content-Type", "application/octet-stream".to_owned()),
            ("Content-Encoding", "aes128gcm".to_owned()),
        ];
        if row.endpoint.starts_with(GCM_ENDPOINT) {
            crate::log::warn(
                "Attempt to send push notification to GCM endpoint, but no GCM key is defined.",
            );
        } else {
            headers.push((
                "Authorization",
                vapid_authorization(
                    &audience(&row.endpoint)?,
                    &self.subject,
                    &self.vapid,
                    now_ms(),
                )?,
            ));
        }
        headers.push(("Urgency", "normal".to_owned()));
        headers.push(("Topic", topic.to_owned()));
        Ok((headers, body))
    }

    async fn send(&self, row: SubscriptionRow, payload: &str, topic: &str) -> bool {
        let outcome = match self.request(&row, payload, topic) {
            Ok((headers, body)) => {
                let mut request = self
                    .client
                    .post(&row.endpoint)
                    .timeout(SEND_TIMEOUT)
                    .body(body);
                for (name, value) in headers {
                    request = request.header(name, value);
                }
                match request.send().await {
                    Ok(response) => Ok(response.status().as_u16()),
                    Err(_) => Err("push service unreachable".to_owned()),
                }
            }
            Err(error) => Err(error),
        };
        let conn = self.db.lock();
        let failure = match outcome {
            Ok(404 | 410) => {
                let _ = conn.execute("DELETE FROM push_subscriptions WHERE id=?", [&row.id]);
                return false;
            }
            Ok(status) if (200..300).contains(&status) => {
                let _ = conn.execute(
                    "UPDATE push_subscriptions SET last_success_at=?, failures=0 WHERE id=?",
                    params![now_ms(), row.id],
                );
                return true;
            }
            Ok(status) => format!("push service answered {status}"),
            Err(error) => error,
        };
        let _ = conn.execute(
            "UPDATE push_subscriptions SET failures=failures+1 WHERE id=?",
            [&row.id],
        );
        let _ = conn.execute(
            "DELETE FROM push_subscriptions WHERE id=? AND failures>=?",
            params![row.id, MAX_FAILURES],
        );
        drop(conn);
        crate::log::warn(&format!(
            "push to {} failed: {failure}",
            host_of(&row.endpoint)
        ));
        false
    }
}

/// A phone's subscription goes with its device token.
fn prune(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM push_subscriptions WHERE device_id IS NOT NULL AND device_id NOT IN (SELECT id FROM device_tokens)",
        [],
    )
    .map(drop)
}

/// The gateway's push state, made from its configuration on first use (at
/// startup, by [`start`]).
fn state(app: &App) -> Result<Arc<Push>, String> {
    if let Some(push) = app.slots.get::<Push>() {
        return Ok(push);
    }
    let vapid = load_vapid_keys(&app.config.state_dir, &Env::from_process())?;
    Ok(app.slots.get_or_init(|| {
        Push::new(
            app.db.clone(),
            vapid,
            app.config.vapid_subject.clone(),
            app.config.push_allow_http,
        )
    }))
}

fn push_of(app: &App) -> ApiResult<Arc<Push>> {
    state(app).map_err(|error| {
        crate::log::error(&format!("push: {error}"));
        ApiError::internal()
    })
}

// ---------------------------------------------------------------------------
// The interaction watcher

/// A session that starts waiting for its user (a dangerous command to
/// confirm, a question) pushes to them; the gateway's own confirmations (a
/// delegation to approve) count too (`watchInteractions`).
fn waiting_message(
    conn: &rusqlite::Connection,
    session_id: &str,
    data: Option<&Value>,
) -> Option<(String, PushMessage)> {
    let session = conn.get_session(session_id).ok()?;
    let user = session.owner_user?;
    // A delegated session's confirmation is relayed to the chat that started
    // it, which pushes it instead (answerable there without control).
    if data
        .and_then(|data| data.get("kind"))
        .and_then(Value::as_str)
        == Some("confirm")
        && relayed_to_chat(conn, session_id)
    {
        return None;
    }
    let request = data.and_then(|data| data.get("request"));
    let asked = request
        .and_then(|request| request.get("title"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim_matches(js_space).is_empty());
    let relayed_from = request
        .and_then(|request| request.get("relayed"))
        .and_then(|relayed| relayed.get("sessionName"))
        .and_then(Value::as_str);
    let interaction = exact_interaction_push("interaction_created", session_id, data);
    Some((
        user,
        PushMessage {
            title: match relayed_from {
                Some(name) => format!("{name} needs you"),
                None => format!("{} is waiting for you", session.name),
            },
            body: asked.unwrap_or("It needs your answer to go on.").to_owned(),
            tag: interaction
                .as_ref()
                .map(interaction_tag)
                .unwrap_or_else(|| format!("session:{}", session.id)),
            target: json!({ "sessionId": session.id }),
            interaction,
        },
    ))
}

/// The session is a running delegation's, whose chat still exists: its
/// confirmations are relayed there.
fn relayed_to_chat(conn: &rusqlite::Connection, session_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM delegations d JOIN sessions s ON s.id=d.assistant_session_id WHERE d.target_session_id=? AND d.status IN ('running','waiting_input') LIMIT 1",
        [session_id],
        |_| Ok(()),
    )
    .is_ok()
}

fn exact_interaction_push(
    kind: &'static str,
    session_id: &str,
    data: Option<&Value>,
) -> Option<InteractionPush> {
    let data = data?;
    let id_key = if kind == "interaction_created" {
        "id"
    } else {
        "interactionId"
    };
    let id = data.get(id_key)?.as_str()?.to_owned();
    if id.is_empty() {
        return None;
    }
    // `interactionEpoch` is copied from the row's `runnerEpoch`. The hub
    // envelope epoch is deliberately never used as a fallback.
    let epoch = data
        .get("interactionEpoch")
        .or_else(|| data.get("runnerEpoch"))?;
    let epoch = match epoch {
        Value::Number(number) => number.as_u64()?.to_string(),
        Value::String(text) => text.parse::<u64>().ok()?.to_string(),
        _ => return None,
    };
    Some(InteractionPush {
        kind,
        session_id: session_id.to_owned(),
        interaction_id: Some(id),
        interaction_epoch: Some(epoch),
    })
}

fn hex_utf8(text: &str) -> String {
    text.as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn interaction_tag(interaction: &InteractionPush) -> String {
    format!(
        "interaction:{}:{}:{}",
        hex_utf8(&interaction.session_id),
        interaction.interaction_epoch.as_deref().unwrap_or_default(),
        hex_utf8(interaction.interaction_id.as_deref().unwrap_or_default()),
    )
}

fn answered_message(
    conn: &rusqlite::Connection,
    session_id: &str,
    data: Option<&Value>,
) -> Option<(String, PushMessage)> {
    let session = conn.get_session(session_id).ok()?;
    let user = session.owner_user?;
    let interaction =
        exact_interaction_push("interaction_answered", session_id, data).or_else(|| {
            Some(InteractionPush {
                kind: "interaction_refresh",
                session_id: session_id.to_owned(),
                interaction_id: None,
                interaction_epoch: None,
            })
        });
    let exact = interaction
        .as_ref()
        .is_some_and(|interaction| interaction.kind == "interaction_answered");
    Some((
        user,
        PushMessage {
            title: String::new(),
            body: String::new(),
            tag: if exact {
                interaction
                    .as_ref()
                    .map(interaction_tag)
                    .unwrap_or_default()
            } else {
                format!("session:{}", session.id)
            },
            target: json!({ "sessionId": session.id }),
            interaction,
        },
    ))
}

/// Hand `interaction_created` events from the hub (whose listeners run
/// under its lock) to a task that pushes them, for as long as the hub lives.
fn watch_interactions(events: &Arc<EventHub>, db: Arc<Db>, push: Arc<Push>) {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let subscription = events.subscribe_all(Arc::new(move |event: &GatewayEvent| {
        if matches!(
            event.kind.as_str(),
            "interaction_created" | "interaction_answered"
        ) {
            let _ = sender.send((
                event.session_id.clone(),
                event.kind.clone(),
                event.data.clone(),
            ));
        }
    }));
    tokio::spawn(async move {
        let _subscription = subscription;
        while let Some((session_id, kind, data)) = receiver.recv().await {
            let message = match kind.as_str() {
                "interaction_created" => waiting_message(&db.lock(), &session_id, data.as_ref()),
                "interaction_answered" => answered_message(&db.lock(), &session_id, data.as_ref()),
                _ => None,
            };
            if let Some((user, message)) = message {
                let push = push.clone();
                tokio::spawn(async move { push.notify(&user, &message).await });
            }
        }
    });
}

// ---------------------------------------------------------------------------
// The gateway's interface

/// `/api/push*`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/push", get(get_push))
        .route(
            "/api/push/subscriptions",
            post(add_subscription).delete(remove_subscription),
        )
        .route("/api/push/test", post(test_push))
}

/// Load the VAPID keys and start watching for interactions that need the
/// user (`watchInteractions`). Keys that cannot be loaded stop the gateway,
/// as they stopped `createApp`.
/// Fails, before the gateway listens, on unusable VAPID keys.
pub fn start(app: &AppState) -> Result<(), String> {
    let push = state(app)?;
    watch_interactions(&app.events, app.db.clone(), push);
    Ok(())
}

/// Send `message` to every subscription of `user`, in the background.
pub fn notify(app: &AppState, user: &str, message: PushMessage) {
    let Ok(push) = push_of(app) else {
        return;
    };
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let (push, user) = (push.clone(), user.to_owned());
    runtime.spawn(async move { push.notify(&user, &message).await });
}

/// The key a browser subscribes with, and where notifications go now.
async fn get_push(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Handled {
    let push = push_of(&app)?;
    Ok(ok(json!({
        "publicKey": push.public_key(),
        "subscriptions": push.list(&identity.user)?,
    })))
}

/// A device token subscribes its own phone, and the subscription goes with
/// the token.
async fn add_subscription(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let input = body.parse::<SubscriptionInput>()?.validate()?;
    let subscription =
        push_of(&app)?.subscribe(&identity.user, &input, identity.device_id.as_deref())?;
    Ok(json_response(201, &json!({ "subscription": subscription })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoveBody {
    #[serde(default, deserialize_with = "present")]
    endpoint: Option<String>,
    #[serde(default, deserialize_with = "present")]
    id: Option<String>,
}

async fn remove_subscription(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    ReqBody(body): ReqBody,
) -> Handled {
    let RemoveBody { endpoint, id } = body.parse()?;
    let fits = |value: &Option<String>, max: usize| {
        value.as_deref().is_none_or(|value| utf16_len(value) <= max)
    };
    // `.refine((body) => body.endpoint || body.id)`: an empty string is no reference.
    let given = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    if !fits(&endpoint, 2000) || !fits(&id, 100) || !(given(&endpoint) || given(&id)) {
        return Err(ApiError::invalid_input().into());
    }
    push_of(&app)?.unsubscribe(&identity.user, endpoint.as_deref(), id.as_deref())?;
    Ok(no_content())
}

/// A test notification to every place; answers how many took it.
async fn test_push(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    ReqBody(_): ReqBody,
) -> Handled {
    let delivered = push_of(&app)?
        .notify(
            &identity.user,
            &PushMessage {
                title: "pirc notifications work".into(),
                body: "Anything waiting for you will show up here.".into(),
                tag: "test".into(),
                target: json!({}),
                interaction: None,
            },
        )
        .await;
    Ok(ok(json!({ "delivered": delivered })))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::body::Bytes;
    use axum::http::{HeaderMap, StatusCode, Uri};
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    use super::*;

    fn b64(text: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(text).unwrap()
    }

    /// RFC 8188 decryption of a single-record message, as a browser reads it.
    fn decrypt(ua: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        let idlen = body[20] as usize;
        let as_public = &body[21..21 + idlen];
        let shared = p256::ecdh::diffie_hellman(
            ua.to_nonzero_scalar(),
            PublicKey::from_sec1_bytes(as_public).unwrap().as_affine(),
        );
        let ua_public = ua.public_key().to_encoded_point(false);
        let mut ikm = [0; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
            .expand(&webpush_info(ua_public.as_bytes(), as_public), &mut ikm)
            .unwrap();
        let (key, nonce) = content_key(&ikm, salt);
        let mut plain = Aes128Gcm::new(&key.into())
            .decrypt(Nonce::from_slice(&nonce), &body[21 + idlen..])
            .unwrap();
        assert_eq!(plain.pop(), Some(2), "the last record's delimiter");
        plain
    }

    #[test]
    fn rfc8291_example() {
        // RFC 8291, appendix A.
        let as_private =
            SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public = b64(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let ua_private =
            SecretKey::from_slice(&b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let plaintext = b"When I grow up, I want to be a watermelon";
        let message = encrypt(&ua_public, &auth, plaintext, &salt, &as_private).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&message),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(as_private.public_key().to_encoded_point(false).as_bytes()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        assert_eq!(decrypt(&ua_private, &auth, &message), plaintext);
    }

    #[test]
    fn long_payloads_span_records() {
        let ua = SecretKey::from_slice(&random_bytes::<32>()).unwrap();
        let ua_public = ua.public_key().to_encoded_point(false);
        let auth = random_bytes::<16>();
        let plaintext = vec![b'x'; 5000];
        let local = SecretKey::from_slice(&random_bytes::<32>()).unwrap();
        let message = encrypt(ua_public.as_bytes(), &auth, &plaintext, &[7; 16], &local).unwrap();
        // Header, one full record (4079 bytes + delimiter 1 + tag), the rest (+ delimiter 2 + tag).
        assert_eq!(message.len(), 86 + 4096 + (5000 - 4079) + 17);
        let shared =
            p256::ecdh::diffie_hellman(ua.to_nonzero_scalar(), local.public_key().as_affine());
        let mut ikm = [0; 32];
        Hkdf::<Sha256>::new(Some(&auth), shared.raw_secret_bytes())
            .expand(
                &webpush_info(
                    ua_public.as_bytes(),
                    local.public_key().to_encoded_point(false).as_bytes(),
                ),
                &mut ikm,
            )
            .unwrap();
        let (key, nonce) = content_key(&ikm, &[7; 16]);
        let cipher = Aes128Gcm::new(&key.into());
        let first = cipher
            .decrypt(
                Nonce::from_slice(&record_nonce(&nonce, 0)),
                &message[86..86 + 4096],
            )
            .unwrap();
        let second = cipher
            .decrypt(
                Nonce::from_slice(&record_nonce(&nonce, 1)),
                &message[86 + 4096..],
            )
            .unwrap();
        assert_eq!((first.len(), first[4079]), (4080, 1));
        assert_eq!(second.last(), Some(&2));
    }

    #[test]
    fn vapid_keys_are_kept_or_taken_from_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let none = Env::new([], "/");
        let first = load_vapid_keys(&state, &none).unwrap();
        assert_eq!(load_vapid_keys(&state, &none).unwrap(), first);
        let file = state.join("vapid.json");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(stored["publicKey"], first.public_key.as_str());
        assert_eq!(b64(&first.public_key).len(), 65);
        assert_eq!(b64(&first.private_key).len(), 32);
        let env = Env::new(
            [
                ("PIRC_VAPID_PUBLIC_KEY", " pub "),
                ("PIRC_VAPID_PRIVATE_KEY", "priv"),
            ],
            "/",
        );
        assert_eq!(
            load_vapid_keys(&state, &env).unwrap(),
            VapidKeys {
                public_key: "pub".into(),
                private_key: "priv".into()
            }
        );
        let error = load_vapid_keys(&state, &Env::new([("PIRC_VAPID_PUBLIC_KEY", "pub")], "/"))
            .unwrap_err();
        assert!(error.contains("both"));
        fs::write(&file, "{}").unwrap();
        assert!(
            load_vapid_keys(&state, &none)
                .unwrap_err()
                .contains("holds no VAPID key pair")
        );
    }

    #[test]
    fn vapid_authorization_is_a_signed_jwt() {
        let keys = generate_vapid_keys();
        let header = vapid_authorization(
            "https://push.example",
            "mailto:ops@example.com",
            &keys,
            1_700_000_000_999,
        )
        .unwrap();
        let rest = header.strip_prefix("vapid t=").unwrap();
        let (jwt, key) = rest.split_once(", k=").unwrap();
        assert_eq!(key, keys.public_key);
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(b64(parts[0]), br#"{"typ":"JWT","alg":"ES256"}"#);
        assert_eq!(
            String::from_utf8(b64(parts[1])).unwrap(),
            r#"{"aud":"https://push.example","exp":1700043200,"sub":"mailto:ops@example.com"}"#
        );
        let verifying = VerifyingKey::from_sec1_bytes(&b64(&keys.public_key)).unwrap();
        let signature = Signature::from_slice(&b64(parts[2])).unwrap();
        verifying
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
        // Keys that do not fit fail the send, not the gateway.
        let bad = VapidKeys {
            public_key: "pub".into(),
            private_key: keys.private_key.clone(),
        };
        assert!(vapid_authorization("https://p", "mailto:a@b", &bad, 0).is_err());
        assert!(vapid_authorization("https://p", "http://a", &keys, 0).is_err());
    }

    #[test]
    fn audiences_topics_and_payloads_as_web_push_made_them() {
        assert_eq!(
            audience("https://Push.Example:443/x").unwrap(),
            "https://push.example:443"
        );
        assert_eq!(
            audience("http://127.0.0.1:8080/a?b").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(audience("https://[::1]:99/x").unwrap(), "https://[::1]:99");
        assert_eq!(audience("https://u@h.com/x").unwrap(), "https://h.com");
        // Values from the TS `topicOf`.
        for (tag, topic) in [
            ("test", "t2487m4"),
            (
                "session:session_0b1c6b8e-5d7a-4b55-9a3e-1c2d3e4f5a6b",
                "th8rv5x1g",
            ),
            ("", "t00"),
            ("x😀y", "t139784"),
            ("delegation:abc", "tmhb3f4e"),
        ] {
            assert_eq!(topic_of(tag), topic, "{tag}");
        }
        assert_eq!(js_json_string(&clip("ab😀", 3)), r#""ab…""#);
        assert_eq!(js_json_string(&clip("a   b", 3)), r#""a…""#);
        let message = PushMessage {
            title: format!("{}  tail", "t".repeat(119)),
            body: "b".into(),
            tag: "a\u{1}\"\\\n".into(),
            target: json!({ "sessionId": "s" }),
            interaction: None,
        };
        assert_eq!(
            payload(&message, 5),
            format!(
                r#"{{"title":"{}…","body":"b","tag":"a\u0001\"\\\n","target":{{"sessionId":"s"}},"at":5}}"#,
                "t".repeat(119)
            )
        );
        // A room's deep link.
        let room: Value = serde_json::from_str(&payload(
            &room_message("general", "pirc".into(), "Here".into()),
            7,
        ))
        .unwrap();
        assert_eq!(room["target"], json!({ "roomId": "general" }));
        assert_eq!(room["tag"], "room:general");
        let revoke = PushMessage {
            title: String::new(),
            body: String::new(),
            tag: "interaction:7331:0:6d656d6f72793a703a30".into(),
            target: json!({ "sessionId": "s1" }),
            interaction: Some(InteractionPush {
                kind: "interaction_answered",
                session_id: "s1".into(),
                interaction_id: Some("memory:p:0".into()),
                interaction_epoch: Some("0".into()),
            }),
        };
        let revoke: Value = serde_json::from_str(&payload(&revoke, 6)).unwrap();
        assert_eq!(revoke["kind"], "interaction_answered");
        assert_eq!(revoke["sessionId"], "s1");
        assert_eq!(revoke["interactionId"], "memory:p:0");
        assert_eq!(revoke["interactionEpoch"], "0");
        assert_eq!(revoke["tag"], "interaction:7331:0:6d656d6f72793a703a30");
        // Half a surrogate pair, as `JSON.stringify` writes it.
        assert_eq!(js_json_string(&clip("a😀bc", 3)), r#""a\ud83d…""#);
        assert!(key_shaped(&"a".repeat(80), 80, 100));
        assert!(key_shaped(&format!("{}==", "a".repeat(87)), 80, 100));
        assert!(!key_shaped(&format!("{}===", "a".repeat(87)), 80, 100));
        assert!(!key_shaped(&"a".repeat(79), 80, 100));
        assert!(!key_shaped(&format!("{}+", "a".repeat(87)), 80, 100));
    }

    /// A browser's push subscription keys.
    struct Subscriber {
        secret: SecretKey,
        auth: [u8; 16],
    }

    impl Subscriber {
        fn new() -> Self {
            Self {
                secret: SecretKey::from_slice(&random_bytes::<32>()).unwrap(),
                auth: random_bytes(),
            }
        }

        fn keys(&self) -> SubscriptionKeys {
            SubscriptionKeys {
                p256dh: URL_SAFE_NO_PAD
                    .encode(self.secret.public_key().to_encoded_point(false).as_bytes()),
                auth: URL_SAFE_NO_PAD.encode(self.auth),
            }
        }

        fn read(&self, body: &[u8]) -> Value {
            serde_json::from_slice(&decrypt(&self.secret, &self.auth, body)).unwrap()
        }
    }

    #[derive(Default)]
    struct Service {
        status: u16,
        received: Vec<(String, HeaderMap, Bytes)>,
    }

    /// A push service on loopback that records what it receives and answers `status`.
    async fn push_service() -> (String, Arc<Mutex<Service>>) {
        let service = Arc::new(Mutex::new(Service {
            status: 201,
            received: Vec::new(),
        }));
        let state = service.clone();
        let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let state = state.clone();
            async move {
                let mut service = state.lock().unwrap();
                service
                    .received
                    .push((uri.path().to_owned(), headers, body));
                StatusCode::from_u16(service.status).unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (url, service)
    }

    fn setup() -> Arc<Push> {
        Arc::new(Push::new(
            Arc::new(Db::memory()),
            generate_vapid_keys(),
            "mailto:ops@example.com".into(),
            true,
        ))
    }

    fn input(
        endpoint: &str,
        keys: SubscriptionKeys,
        kind: &str,
        name: Option<&str>,
    ) -> SubscriptionInput {
        SubscriptionInput {
            endpoint: endpoint.into(),
            keys,
            kind: Some(kind.into()),
            name: name.map(Into::into),
        }
    }

    fn message(tag: &str) -> PushMessage {
        PushMessage {
            title: "t".into(),
            body: "b".into(),
            tag: tag.into(),
            target: json!({ "memory": true }),
            interaction: None,
        }
    }

    #[tokio::test]
    async fn sends_encrypted_signed_notifications_only_the_subscriber_can_read() {
        let push = setup();
        let (url, service) = push_service().await;
        let browser = Subscriber::new();
        push.subscribe(
            "me",
            &input(&format!("{url}/me"), browser.keys(), "web", None),
            None,
        )
        .unwrap();
        let delivered = push
            .notify(
                "me",
                &PushMessage {
                    title: "CI check failed".into(),
                    body: "Finished: open it to read the result.".into(),
                    tag: "session:s1".into(),
                    target: json!({ "sessionId": "s1" }),
                    interaction: None,
                },
            )
            .await;
        assert_eq!(delivered, 1);
        let (path, headers, body) = service.lock().unwrap().received[0].clone();
        assert_eq!(path, "/me");
        let header = |name: &str| headers.get(name).unwrap().to_str().unwrap().to_owned();
        assert_eq!(header("content-encoding"), "aes128gcm");
        assert_eq!(header("content-type"), "application/octet-stream");
        assert_eq!(header("ttl"), "86400");
        assert_eq!(header("urgency"), "normal");
        assert_eq!(header("topic"), topic_of("session:s1"));
        assert!(header("authorization").starts_with("vapid t="));
        assert!(!String::from_utf8_lossy(&body).contains("CI check"));
        let read = browser.read(&body);
        assert_eq!(read["title"], "CI check failed");
        assert_eq!(read["tag"], "session:s1");
        assert_eq!(read["target"], json!({ "sessionId": "s1" }));
        assert!(read["at"].is_i64());

        // Nobody else's notifications.
        assert_eq!(push.notify("someone-else", &message("t")).await, 0);
        assert_eq!(service.lock().unwrap().received.len(), 1);
    }

    #[tokio::test]
    async fn lists_refreshes_and_removes_subscriptions_and_drops_dead_ones() {
        let push = setup();
        let (url, service) = push_service().await;
        let browser = Subscriber::new();
        let strict = Push::new(
            Arc::new(Db::memory()),
            generate_vapid_keys(),
            "mailto:a@b.c".into(),
            false,
        );
        let refused = strict
            .subscribe(
                "me",
                &input("http://push.example/x", browser.keys(), "web", None),
                None,
            )
            .unwrap_err();
        assert!(refused.message.contains("https"));
        let refused = strict
            .subscribe(
                "me",
                &input("https://u:p@push.example/x", browser.keys(), "web", None),
                None,
            )
            .unwrap_err();
        assert!(refused.message.contains("credentials"));

        let a = format!("{url}/a");
        let first = push
            .subscribe(
                "me",
                &input(&a, browser.keys(), "web", Some("Firefox")),
                None,
            )
            .unwrap();
        // The same endpoint again refreshes it rather than adding one.
        let again = push
            .subscribe(
                "me",
                &input(&a, browser.keys(), "web", Some("Firefox")),
                None,
            )
            .unwrap();
        assert_eq!(again["id"], first["id"]);
        push.subscribe(
            "me",
            &input(
                &format!("{url}/b"),
                Subscriber::new().keys(),
                "unifiedpush",
                Some("Pixel"),
            ),
            None,
        )
        .unwrap();
        let listed: Vec<(Value, Value)> = push
            .list("me")
            .unwrap()
            .into_iter()
            .map(|item| (item["kind"].clone(), item["name"].clone()))
            .collect();
        assert_eq!(
            listed,
            [
                (json!("web"), json!("Firefox")),
                (json!("unifiedpush"), json!("Pixel"))
            ]
        );

        // The push service says the subscription is gone: it goes here too.
        service.lock().unwrap().status = 410;
        assert_eq!(push.notify("me", &message("x")).await, 0);
        assert!(push.list("me").unwrap().is_empty());

        // A failing service is counted, not thrown.
        let c = format!("{url}/c");
        let added = push
            .subscribe("me", &input(&c, browser.keys(), "web", None), None)
            .unwrap();
        assert_eq!(added["name"], url.trim_start_matches("http://"));
        service.lock().unwrap().status = 500;
        assert_eq!(push.notify("me", &message("x")).await, 0);
        assert_eq!(push.list("me").unwrap()[0]["failing"], true);

        // Another user's subscription of the endpoint replaces it.
        let taken = push
            .subscribe("you", &input(&c, browser.keys(), "web", None), None)
            .unwrap();
        assert_ne!(taken["id"], added["id"]);
        assert!(push.list("me").unwrap().is_empty());
        assert!(push.unsubscribe("you", Some(&c), None).unwrap());
        assert!(!push.unsubscribe("you", None, Some("push_none")).unwrap());
        assert!(push.list("you").unwrap().is_empty());
    }

    #[tokio::test]
    async fn drops_a_subscription_after_twenty_failures() {
        let push = setup();
        let (url, service) = push_service().await;
        service.lock().unwrap().status = 500;
        push.subscribe(
            "me",
            &input(&format!("{url}/x"), Subscriber::new().keys(), "web", None),
            None,
        )
        .unwrap();
        for _ in 0..19 {
            push.notify("me", &message("x")).await;
        }
        assert_eq!(push.list("me").unwrap().len(), 1);
        push.notify("me", &message("x")).await;
        assert!(push.list("me").unwrap().is_empty());
    }

    #[test]
    fn drops_a_phone_subscription_with_its_device_token() {
        let push = setup();
        push.db
            .lock()
            .execute(
                "INSERT INTO device_tokens (id, owner_user, name, token_hash, created_at, expires_at, last_used_at) VALUES ('dev1','me','Pixel','h',1,9999999999999,1)",
                [],
            )
            .unwrap();
        push.subscribe(
            "me",
            &input(
                "http://127.0.0.1:1/p",
                Subscriber::new().keys(),
                "unifiedpush",
                None,
            ),
            Some("dev1"),
        )
        .unwrap();
        assert_eq!(push.list("me").unwrap().len(), 1);
        push.db
            .lock()
            .execute("DELETE FROM device_tokens WHERE id='dev1'", [])
            .unwrap();
        assert!(push.list("me").unwrap().is_empty());
    }

    #[test]
    fn validates_subscriptions_like_the_schema() {
        let keys = Subscriber::new().keys();
        let parse = |body: Value| {
            crate::http::Body::Json(body)
                .parse::<SubscriptionInput>()
                .and_then(SubscriptionInput::validate)
        };
        let valid = parse(json!({ "endpoint": "https://p.example/x", "keys": { "p256dh": keys.p256dh, "auth": keys.auth }, "name": "  Laptop " })).unwrap();
        assert_eq!(
            (valid.kind.as_deref(), valid.name.as_deref()),
            (Some("web"), Some("Laptop"))
        );
        for body in [
            json!({ "endpoint": "not a url", "keys": { "p256dh": keys.p256dh, "auth": keys.auth } }),
            json!({ "endpoint": "https://p/x", "keys": { "p256dh": "short", "auth": keys.auth } }),
            json!({ "endpoint": "https://p/x", "keys": { "p256dh": keys.p256dh, "auth": keys.auth, "x": 1 } }),
            json!({ "endpoint": "https://p/x", "keys": { "p256dh": keys.p256dh, "auth": keys.auth }, "kind": "apns" }),
            json!({ "endpoint": "https://p/x", "keys": { "p256dh": keys.p256dh, "auth": keys.auth }, "name": null }),
            json!({ "endpoint": "https://p/x", "keys": { "p256dh": keys.p256dh, "auth": keys.auth }, "name": "n".repeat(101) }),
            json!({ "endpoint": format!("https://p/{}", "x".repeat(2000)), "keys": { "p256dh": keys.p256dh, "auth": keys.auth } }),
        ] {
            assert!(parse(body.clone()).is_err(), "{body}");
        }
    }

    #[tokio::test]
    async fn pushes_when_a_session_starts_waiting_for_its_user() {
        let push = setup();
        let (url, service) = push_service().await;
        let browser = Subscriber::new();
        push.subscribe(
            "me",
            &input(&format!("{url}/me"), browser.keys(), "web", None),
            None,
        )
        .unwrap();
        let session = {
            let conn = push.db.lock();
            conn.sync_remote_workspaces(
                "work",
                &[(
                    "pirc".into(),
                    "pirc".into(),
                    crate::db::ModeId::new("directory").unwrap(),
                )],
            )
            .unwrap();
            conn.create_session("work:pirc", "node://work/r1", "work", "r1", "me")
                .unwrap()
        };
        let events = EventHub::new(100);
        watch_interactions(&events, push.db.clone(), push.clone());
        events.publish(
            &session.id,
            17,
            "interaction_created",
            json!({ "id": "i1", "runnerEpoch": 0, "request": { "title": "Allow rm -rf build?" } }),
        );
        events.publish(
            &session.id,
            17,
            "interaction_answered",
            json!({ "interactionId": "i1", "interactionEpoch": 0 }),
        );
        events.publish("unknown", 0, "interaction_created", json!({}));
        for _ in 0..100 {
            if service.lock().unwrap().received.len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let received = service.lock().unwrap().received.clone();
        assert_eq!(received.len(), 2);
        let payloads: Vec<Value> = received.iter().map(|item| browser.read(&item.2)).collect();
        let created = payloads
            .iter()
            .find(|payload| payload["kind"] == "interaction_created")
            .unwrap();
        assert_eq!(
            created["title"],
            format!("{} is waiting for you", session.name)
        );
        assert_eq!(created["body"], "Allow rm -rf build?");
        assert_eq!(created["interactionId"], "i1");
        assert_eq!(created["interactionEpoch"], "0");
        assert_eq!(
            created["tag"],
            format!("interaction:{}:0:6931", hex_utf8(&session.id))
        );
        assert_eq!(created["target"], json!({ "sessionId": session.id }));
        let answered = payloads
            .iter()
            .find(|payload| payload["kind"] == "interaction_answered")
            .unwrap();
        assert_eq!(answered["title"], "");
        assert_eq!(answered["interactionId"], "i1");
        assert_eq!(answered["interactionEpoch"], "0");
        assert_eq!(answered["tag"], created["tag"]);
        assert_eq!(answered["target"], json!({ "sessionId": session.id }));

        let conn = push.db.lock();
        let (_, refresh) =
            answered_message(&conn, &session.id, Some(&json!({ "interactionId": "i1" }))).unwrap();
        assert_eq!(
            refresh.interaction.as_ref().unwrap().kind,
            "interaction_refresh"
        );
        assert_eq!(refresh.tag, format!("session:{}", session.id));
        assert_eq!(refresh.interaction.as_ref().unwrap().interaction_id, None);

        let (_, untitled) = waiting_message(
            &conn,
            &session.id,
            Some(&json!({ "request": { "title": "  " } })),
        )
        .unwrap();
        assert_eq!(untitled.body, "It needs your answer to go on.");
        let (_, no_data) = waiting_message(&conn, &session.id, None).unwrap();
        assert_eq!(no_data.body, "It needs your answer to go on.");
    }
}
