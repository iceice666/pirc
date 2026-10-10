//! A Web Push service on loopback (push services such as Mozilla's
//! autopush or a UnifiedPush distributor). It records what the gateway
//! sends and answers each endpoint with the status the test chose. Every
//! request is checked and read the way a browser would: the VAPID JWT is
//! verified against its `k` key and the `aes128gcm` body (RFC 8291) is
//! decrypted with the subscriber's private key, so a recording shows the
//! payload in clear and nothing that differs between runs (ephemeral keys,
//! salts, signatures).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// One subscriber: the keys its browser made, and what the service answers.
struct Subscriber {
    secret: SecretKey,
    auth: Vec<u8>,
    status: u16,
}

#[derive(Default)]
struct Service {
    subscribers: HashMap<String, Subscriber>,
    received: Vec<Value>,
}

/// The running service; stops when dropped.
pub struct FakePush {
    url: String,
    service: Arc<Mutex<Service>>,
    task: JoinHandle<()>,
}

/// A subscription as a browser hands it to the gateway.
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

impl PushSubscription {
    /// The body of `POST /api/push/subscriptions` (without kind or name).
    pub fn body(&self) -> Value {
        json!({ "endpoint": self.endpoint, "keys": { "p256dh": self.p256dh, "auth": self.auth } })
    }
}

impl FakePush {
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let service = Arc::new(Mutex::new(Service::default()));
        let app = Router::new().fallback(receive).with_state(service.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { url, service, task })
    }

    /// `http://127.0.0.1:<port>`
    pub fn url(&self) -> &str {
        &self.url
    }

    /// A new subscriber at `/<name>`, answered with `status`; `auth_bytes`
    /// is the length of its authentication secret (16 is what browsers use).
    pub fn subscribe(&self, name: &str, status: u16, auth_bytes: usize) -> PushSubscription {
        let secret = loop {
            let mut bytes = [0; 32];
            getrandom::fill(&mut bytes).unwrap();
            if let Ok(secret) = SecretKey::from_slice(&bytes) {
                break secret;
            }
        };
        let mut auth = vec![0; auth_bytes];
        getrandom::fill(&mut auth).unwrap();
        let subscription = PushSubscription {
            endpoint: format!("{}/{name}", self.url),
            p256dh: URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes()),
            auth: URL_SAFE_NO_PAD.encode(&auth),
        };
        self.service.lock().unwrap().subscribers.insert(
            format!("/{name}"),
            Subscriber {
                secret,
                auth,
                status,
            },
        );
        subscription
    }

    /// Change what `/<name>` answers.
    pub fn answer(&self, name: &str, status: u16) {
        if let Some(subscriber) = self
            .service
            .lock()
            .unwrap()
            .subscribers
            .get_mut(&format!("/{name}"))
        {
            subscriber.status = status;
        }
    }

    /// Requests received so far, in order of arrival.
    pub fn received(&self) -> Vec<Value> {
        self.service.lock().unwrap().received.clone()
    }

    /// Take the requests received so far, sorted by path (the gateway sends
    /// to several endpoints at once).
    pub fn take(&self) -> Vec<Value> {
        let mut received = std::mem::take(&mut self.service.lock().unwrap().received);
        received.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        received
    }

    /// Wait until `count` requests have arrived (at most 20 s).
    pub async fn wait_for(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.service.lock().unwrap().received.len() < count {
            assert!(
                Instant::now() < deadline,
                "the push service got {} of {count} requests",
                self.service.lock().unwrap().received.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for FakePush {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn receive(
    State(service): State<Arc<Mutex<Service>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let mut service = service.lock().unwrap();
    let path = uri.path().to_owned();
    let header = |name: &str| {
        headers
            .get(name)
            .map(|value| json!(String::from_utf8_lossy(value.as_bytes())))
            .unwrap_or(Value::Null)
    };
    let subscriber = service.subscribers.get(&path);
    let mut recorded = json!({
        "method": method.as_str(),
        "path": path,
        "headers": {
            "ttl": header("ttl"),
            "urgency": header("urgency"),
            "topic": header("topic"),
            "content-type": header("content-type"),
            "content-encoding": header("content-encoding"),
            "content-length": header("content-length"),
        },
        "authorization": headers
            .get("authorization")
            .map_or(Value::Null, |value| authorization(&String::from_utf8_lossy(value.as_bytes()))),
        "payload": subscriber.map_or(json!("<unknown subscriber>"), |subscriber| {
            decrypt(subscriber, &body).unwrap_or_else(|error| json!(format!("<{error}>")))
        }),
    });
    if body.len() >= 21 {
        recorded["record"] = json!({
            "recordSize": u32::from_be_bytes([body[16], body[17], body[18], body[19]]),
            "keyIdLength": body[20],
        });
    }
    let status = subscriber.map_or(404, |subscriber| subscriber.status);
    service.received.push(recorded);
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// `vapid t=<JWT>, k=<key>`: the JWT's header and claims, its expiry
/// relative to now, and whether `k` verifies its signature.
fn authorization(value: &str) -> Value {
    let Some((jwt, key)) = value
        .strip_prefix("vapid t=")
        .and_then(|rest| rest.split_once(", k="))
    else {
        return json!({ "unparsed": value });
    };
    let parts: Vec<&str> = jwt.split('.').collect();
    let decode = |part: &str| -> Value {
        URL_SAFE_NO_PAD
            .decode(part)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null)
    };
    if parts.len() != 3 {
        return json!({ "unparsed": value });
    }
    let mut claims = decode(parts[1]);
    if let Some(exp) = claims.get("exp").and_then(Value::as_i64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let left = exp - now;
        // web-push signs for 12 hours.
        claims["exp"] = if (12 * 3600 - 60..=12 * 3600).contains(&left) {
            json!("<now + 12h>")
        } else {
            json!(format!("<now + {left}s>"))
        };
    }
    let verified = URL_SAFE_NO_PAD
        .decode(key)
        .ok()
        .and_then(|key| VerifyingKey::from_sec1_bytes(&key).ok())
        .zip(
            URL_SAFE_NO_PAD
                .decode(parts[2])
                .ok()
                .and_then(|signature| Signature::from_slice(&signature).ok()),
        )
        .is_some_and(|(key, signature)| {
            key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
                .is_ok()
        });
    json!({
        "k": key,
        "header": decode(parts[0]),
        "claims": claims,
        "signatureVerified": verified,
    })
}

/// Read an `aes128gcm` message as the subscriber's browser (RFC 8291):
/// the payload as JSON (or text), with the record delimiter checked.
fn decrypt(subscriber: &Subscriber, body: &[u8]) -> Result<Value, String> {
    if body.len() < 21 {
        return Err("short body".into());
    }
    let salt = &body[..16];
    let record_size = u32::from_be_bytes([body[16], body[17], body[18], body[19]]) as usize;
    let idlen = body[20] as usize;
    let sender = body.get(21..21 + idlen).ok_or("short key id")?;
    let sender_key = PublicKey::from_sec1_bytes(sender).map_err(|_| "key id is no P-256 key")?;
    let shared = p256::ecdh::diffie_hellman(
        subscriber.secret.to_nonzero_scalar(),
        sender_key.as_affine(),
    );
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(
        subscriber
            .secret
            .public_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    info.extend_from_slice(sender);
    let mut ikm = [0; 32];
    Hkdf::<Sha256>::new(Some(&subscriber.auth), shared.raw_secret_bytes())
        .expand(&info, &mut ikm)
        .map_err(|_| "hkdf")?;
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut key = [0; 16];
    let mut nonce = [0; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .map_err(|_| "hkdf")?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| "hkdf")?;
    let cipher = Aes128Gcm::new(&key.into());
    let mut plain = Vec::new();
    for (counter, record) in body[21 + idlen..].chunks(record_size).enumerate() {
        let mut nonce = nonce;
        for (byte, counter_byte) in nonce[4..].iter_mut().zip((counter as u64).to_be_bytes()) {
            *byte ^= counter_byte;
        }
        let mut data = cipher
            .decrypt(Nonce::from_slice(&nonce), record)
            .map_err(|_| "record does not decrypt")?;
        while data.last() == Some(&0) {
            data.pop();
        }
        match data.pop() {
            Some(1) => {}
            Some(2) => {
                plain.extend_from_slice(&data);
                break;
            }
            _ => return Err("bad record delimiter".into()),
        }
        plain.extend_from_slice(&data);
    }
    Ok(serde_json::from_slice(&plain)
        .unwrap_or_else(|_| json!(String::from_utf8_lossy(&plain).into_owned())))
}
