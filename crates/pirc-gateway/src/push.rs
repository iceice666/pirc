//! Push notifications to browsers and phones
//! (`apps/gateway/src/daemon/push.ts`, `push-routes.ts`): subscriptions,
//! VAPID keys, RFC 8291 encryption and the interaction watcher. STUB: being
//! ported (M2.6).

use axum::Router;
use serde_json::Value;

use crate::app::AppState;

/// One notification (`PushMessage`): `target` is `{sessionId}` or
/// `{schedules: true, scheduleId}`.
#[derive(Clone, Debug)]
pub struct PushMessage {
    pub title: String,
    pub body: String,
    pub tag: String,
    pub target: Value,
}

/// `/api/push*`.
pub fn routes() -> Router<AppState> {
    Router::new()
}

/// Start watching for interactions that need the user (`watchInteractions`).
pub fn start(_app: &AppState) {}

/// Send `message` to every subscription of `user`, in the background.
pub fn notify(_app: &AppState, _user: &str, _message: PushMessage) {}
