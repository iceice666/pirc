//! Each session's event stream on the node (`apps/gateway/src/events.ts`,
//! the node's half; the gateway's `events.rs` is the same port with replay
//! for its sockets): events get a sequence number within the session's
//! runner epoch, the newest `capacity` are kept, and every event goes to the
//! global listeners (the link forwards them all to the gateway).
//!
//! Listeners run while the hub is locked, in sequence order, and must not
//! call back into the hub: they hand the event to a queue and return.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::util::now_ms;

/// One event (`GatewayEvent` in `types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub session_id: String,
    pub epoch: i64,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Value,
    pub timestamp: i64,
}

impl SessionEvent {
    /// The `event` of a link `event` frame (`{...event}`).
    pub fn to_map(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        }
    }
}

/// A position in a session's stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub epoch: i64,
    pub sequence: u64,
}

pub type Listener = Arc<dyn Fn(&SessionEvent) + Send + Sync>;

struct Stream {
    epoch: i64,
    sequence: u64,
    events: VecDeque<Arc<SessionEvent>>,
}

#[derive(Default)]
struct State {
    streams: HashMap<String, Stream>,
    global: HashMap<u64, Listener>,
}

pub struct EventHub {
    capacity: usize,
    state: Mutex<State>,
    next_listener: AtomicU64,
}

/// The stream of `session_id`, created on first use; a newer epoch starts it over.
fn stream<'a>(state: &'a mut State, session_id: &str, epoch: i64) -> &'a mut Stream {
    let stream = state
        .streams
        .entry(session_id.to_owned())
        .or_insert_with(|| Stream {
            epoch,
            sequence: 0,
            events: VecDeque::new(),
        });
    if epoch > stream.epoch {
        stream.epoch = epoch;
        stream.sequence = 0;
        stream.events.clear();
    }
    stream
}

impl EventHub {
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            capacity,
            state: Mutex::new(State::default()),
            next_listener: AtomicU64::new(0),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Drop a deleted session's stream.
    pub fn forget(&self, session_id: &str) {
        self.lock().streams.remove(session_id);
    }

    /// Every event of every session (the link forwards them to the gateway).
    pub fn subscribe_all(self: &Arc<Self>, listener: Listener) -> Subscription {
        let key = self.next_listener.fetch_add(1, Ordering::Relaxed);
        self.lock().global.insert(key, listener);
        Subscription {
            hub: Arc::downgrade(self),
            key,
        }
    }

    /// Publish an event in `epoch` (an older epoch's event joins the
    /// current one, as in TS) and tell every listener.
    pub fn publish(&self, session_id: &str, epoch: i64, kind: &str, data: Value) -> SessionEvent {
        let mut state = self.lock();
        let capacity = self.capacity;
        let stream = stream(&mut state, session_id, epoch);
        stream.sequence += 1;
        let event = Arc::new(SessionEvent {
            session_id: session_id.to_owned(),
            epoch: stream.epoch,
            sequence: stream.sequence,
            kind: kind.to_owned(),
            data,
            timestamp: now_ms(),
        });
        stream.events.push_back(event.clone());
        while stream.events.len() > capacity {
            stream.events.pop_front();
        }
        // One failing listener must not stop the others or fail the
        // publisher (a runner would otherwise treat it as a crash).
        for listener in state.global.values() {
            let delivered =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&event)));
            if delivered.is_err() {
                crate::log::error(&format!("event listener failed for {}", event.kind));
            }
        }
        (*event).clone()
    }

    /// The last event's position (a snapshot's `watermark`).
    pub fn watermark(&self, session_id: &str, epoch: i64) -> Cursor {
        let mut state = self.lock();
        let stream = stream(&mut state, session_id, epoch);
        Cursor {
            epoch: stream.epoch,
            sequence: stream.sequence,
        }
    }

    /// The kept events of a session, oldest first.
    pub fn buffered(&self, session_id: &str) -> Vec<Arc<SessionEvent>> {
        self.lock()
            .streams
            .get(session_id)
            .map(|stream| stream.events.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// A listener; dropping it unsubscribes.
pub struct Subscription {
    hub: Weak<EventHub>,
    key: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.lock().global.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn sequences_epochs_and_capacity() {
        let hub = EventHub::new(3);
        for n in 1..=4 {
            hub.publish("s", 0, "e", json!(n));
        }
        let kept: Vec<_> = hub.buffered("s").iter().map(|e| e.sequence).collect();
        assert_eq!(kept, [2, 3, 4]);
        assert_eq!(
            hub.watermark("s", 0),
            Cursor {
                epoch: 0,
                sequence: 4
            }
        );
        // A newer epoch starts over.
        let event = hub.publish("s", 1, "e", json!(5));
        assert_eq!((event.epoch, event.sequence), (1, 1));
        assert_eq!(hub.buffered("s").len(), 1);
        // An older epoch's events join the current one.
        assert_eq!(hub.publish("s", 0, "e", json!(6)).epoch, 1);
        hub.forget("s");
        assert_eq!(
            hub.watermark("s", 0),
            Cursor {
                epoch: 0,
                sequence: 0
            }
        );
    }

    // events-reducer.test.ts: "isolates a failing subscriber..."
    #[test]
    fn isolates_a_failing_listener() {
        let hub = EventHub::new(10);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let failing = hub.subscribe_all(Arc::new(|_| panic!("listener failure")));
        let sink = seen.clone();
        let global = hub.subscribe_all(Arc::new(move |event| {
            sink.lock().unwrap().push(event.to_map());
        }));
        let event = hub.publish("s", 2, "pi_event", json!({ "type": "agent_start" }));
        assert_eq!(event.sequence, 1);
        drop(failing);
        drop(global);
        hub.publish("s", 2, "pi_event", json!({}));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            Value::Object(seen[0].clone()),
            json!({ "sessionId": "s", "epoch": 2, "sequence": 1, "type": "pi_event",
                "data": { "type": "agent_start" }, "timestamp": event.timestamp })
        );
    }
}
