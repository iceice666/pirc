//! Rooms as the gateway serves them (plans/rewrite/01-rooms.md): the store
//! ([`crate::db::rooms`]) plus the room event stream and typing.
//!
//! Room events (`/api/events?rooms=1`): `room_message` and
//! `room_message_updated` carry `{message}`, `room_changed` carries `{room}`
//! (settings, activity, archive, move), `room_read` carries
//! `{user, readSeq}` and goes to that user only, and `room_typing`
//! (`{user, device, expiresAt}`) is ephemeral: never numbered or replayed,
//! never stored.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::app::App;
use crate::db::rooms::{Message, Room, RoomView};
use crate::util::now_ms;

/// How long a typing signal holds. Clients send one at most every 3 seconds
/// while keys are pressed, so a signal is renewed before it lapses; one that
/// lapses means the user stopped or left.
pub const TYPING_TTL_MS: i64 = 6_000;

/// The latest keystroke per room, user and device, in memory only (decision
/// #16: plan 02's debounce reads it; nothing of it is worth keeping).
#[derive(Default)]
pub struct Typing(Mutex<HashMap<(String, String, String), i64>>);

impl Typing {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String, String), i64>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Record a keystroke at `at`; lapsed entries go.
    pub fn mark(&self, room_id: &str, user: &str, device: &str, at: i64) {
        let mut typing = self.lock();
        typing.retain(|_, last| at - *last < TYPING_TTL_MS);
        typing.insert((room_id.into(), user.into(), device.into()), at);
    }

    /// The user stopped typing in the room (they sent), on every device.
    pub fn clear(&self, room_id: &str, user: &str) {
        self.lock()
            .retain(|(room, who, _), _| !(room == room_id && who == user));
    }

    /// The user's latest keystroke in the room still within
    /// [`TYPING_TTL_MS`] of `now`, on any device.
    pub fn last_keystroke(&self, room_id: &str, user: &str, now: i64) -> Option<i64> {
        self.lock()
            .iter()
            .filter(|((room, who, _), last)| {
                room == room_id && who == user && now - **last < TYPING_TTL_MS
            })
            .map(|(_, last)| *last)
            .max()
    }
}

impl App {
    pub fn typing(&self) -> Arc<Typing> {
        self.slots.get_or_init(Typing::default)
    }

    pub fn room_changed(&self, room: &Room) {
        self.rooms
            .publish(&room.id, "room_changed", json!({ "room": room }), None);
    }

    pub fn room_message(&self, message: &Message) {
        self.rooms.publish(
            &message.room_id,
            "room_message",
            json!({ "message": message }),
            None,
        );
    }

    pub fn room_message_updated(&self, message: &Message) {
        self.rooms.publish(
            &message.room_id,
            "room_message_updated",
            json!({ "message": message }),
            None,
        );
    }

    /// Every device of `user` learns what they read.
    pub fn room_read(&self, user: &str, view: &RoomView) {
        self.rooms.publish(
            &view.room.id,
            "room_read",
            json!({ "user": user, "readSeq": view.read_seq }),
            Some(user),
        );
    }

    /// A keystroke signal: kept in memory and shown to everyone.
    pub fn room_typing(&self, room_id: &str, user: &str, device: &str) {
        let now = now_ms();
        self.typing().mark(room_id, user, device, now);
        self.rooms.publish_ephemeral(
            room_id,
            "room_typing",
            json!({ "user": user, "device": device, "expiresAt": now + TYPING_TTL_MS }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_lapses_and_clears() {
        let typing = Typing::default();
        typing.mark("r", "u", "web", 1_000);
        typing.mark("r", "u", "phone", 2_000);
        assert_eq!(typing.last_keystroke("r", "u", 2_500), Some(2_000));
        assert_eq!(typing.last_keystroke("r", "v", 2_500), None);
        assert_eq!(typing.last_keystroke("other", "u", 2_500), None);
        assert_eq!(
            typing.last_keystroke("r", "u", 1_000 + TYPING_TTL_MS),
            Some(2_000),
            "the phone's is still fresh"
        );
        assert_eq!(typing.last_keystroke("r", "u", 2_000 + TYPING_TTL_MS), None);
        typing.mark("r", "u", "web", 10_000);
        typing.clear("r", "u");
        assert_eq!(typing.last_keystroke("r", "u", 10_001), None);
    }
}
