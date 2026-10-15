//! Each session's event stream (`apps/gateway/src/events.ts`): events get a
//! sequence number within the session's runner epoch, the newest
//! `capacity` are kept for replay, at most [`REPLAY_MAX_BYTES`] of them
//! (security audit I3), and a cursor that cannot be continued is answered
//! with a reset.
//!
//! Listeners run while the hub is locked, in sequence order, and must not
//! call back into the hub: they hand the event to a socket's queue or a
//! channel and return.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde::Serialize;
use serde_json::Value;

use crate::util::now_ms;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayEvent {
    pub session_id: String,
    pub epoch: i64,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub kind: String,
    /// Absent when the node sent none (`undefined` in the TS gateway).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub timestamp: i64,
}

/// A position in a session's stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub epoch: i64,
    pub sequence: u64,
}

pub type Listener = Arc<dyn Fn(&GatewayEvent) + Send + Sync>;

/// Serialized bytes of events kept for replay per session. A client whose
/// cursor is older resets and loads a snapshot, as after `capacity` events.
pub const REPLAY_MAX_BYTES: usize = 8 * 1024 * 1024;

/// An event's size as JSON, without building the text.
fn json_size(event: &GatewayEvent) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    let _ = serde_json::to_writer(&mut count, event);
    count.0
}

struct Stream {
    epoch: i64,
    sequence: u64,
    events: VecDeque<Arc<GatewayEvent>>,
    /// The size of each of `events`, and their sum.
    sizes: VecDeque<usize>,
    bytes: usize,
    listeners: HashMap<u64, Listener>,
}

#[derive(Default)]
struct State {
    streams: HashMap<String, Stream>,
    global: HashMap<u64, Listener>,
}

pub struct EventHub {
    capacity: usize,
    max_bytes: usize,
    state: Mutex<State>,
    next_listener: AtomicU64,
}

/// What a socket gets first: the events after its cursor, or a reset.
pub struct Replay {
    pub reset: bool,
    pub events: Vec<Arc<GatewayEvent>>,
    pub watermark: Cursor,
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
            sizes: VecDeque::new(),
            bytes: 0,
            listeners: HashMap::new(),
        });
    if epoch > stream.epoch {
        stream.epoch = epoch;
        stream.sequence = 0;
        stream.events.clear();
        stream.sizes.clear();
        stream.bytes = 0;
    }
    stream
}

impl EventHub {
    pub fn new(capacity: usize) -> Arc<Self> {
        Self::with_limits(capacity, REPLAY_MAX_BYTES)
    }

    pub fn with_limits(capacity: usize, max_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            capacity,
            max_bytes,
            state: Mutex::new(State::default()),
            next_listener: AtomicU64::new(0),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn forget(&self, session_id: &str) {
        self.lock().streams.remove(session_id);
    }

    /// Every event of every session.
    pub fn subscribe_all(self: &Arc<Self>, listener: Listener) -> Subscription {
        let key = self.next_listener.fetch_add(1, Ordering::Relaxed);
        self.lock().global.insert(key, listener);
        Subscription {
            hub: Arc::downgrade(self),
            session_id: None,
            key,
        }
    }

    pub fn publish(&self, session_id: &str, epoch: i64, kind: &str, data: Value) -> GatewayEvent {
        self.publish_optional(session_id, epoch, kind, Some(data))
    }

    pub fn publish_optional(
        &self,
        session_id: &str,
        epoch: i64,
        kind: &str,
        data: Option<Value>,
    ) -> GatewayEvent {
        let mut state = self.lock();
        let (capacity, max_bytes) = (self.capacity, self.max_bytes);
        let stream = stream(&mut state, session_id, epoch);
        stream.sequence += 1;
        let event = Arc::new(GatewayEvent {
            session_id: session_id.to_owned(),
            epoch: stream.epoch,
            sequence: stream.sequence,
            kind: kind.to_owned(),
            data,
            timestamp: now_ms(),
        });
        let size = json_size(&event);
        stream.events.push_back(event.clone());
        stream.sizes.push_back(size);
        stream.bytes += size;
        // The newest event is always kept, however large.
        while stream.events.len() > capacity
            || (stream.bytes > max_bytes && stream.events.len() > 1)
        {
            stream.events.pop_front();
            stream.bytes -= stream.sizes.pop_front().unwrap_or(0);
        }
        let listeners: Vec<Listener> = stream.listeners.values().cloned().collect();
        // One failing listener must not stop the others or fail the publisher.
        for listener in listeners.iter().chain(state.global.values()) {
            let delivered =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&event)));
            if delivered.is_err() {
                crate::log::error(&format!("event listener failed for {}", event.kind));
            }
        }
        (*event).clone()
    }

    pub fn watermark(&self, session_id: &str, epoch: i64) -> Cursor {
        let mut state = self.lock();
        let stream = stream(&mut state, session_id, epoch);
        Cursor {
            epoch: stream.epoch,
            sequence: stream.sequence,
        }
    }

    fn replay_locked(
        state: &mut State,
        session_id: &str,
        cursor: Option<Cursor>,
        epoch: i64,
    ) -> Replay {
        let stream = stream(state, session_id, epoch);
        let watermark = Cursor {
            epoch: stream.epoch,
            sequence: stream.sequence,
        };
        let Some(cursor) = cursor else {
            return Replay {
                reset: false,
                events: stream.events.iter().cloned().collect(),
                watermark,
            };
        };
        let oldest = stream
            .events
            .front()
            .map_or(stream.sequence + 1, |event| event.sequence);
        if cursor.epoch != stream.epoch
            || cursor.sequence > stream.sequence
            || cursor.sequence + 1 < oldest
        {
            return Replay {
                reset: true,
                events: Vec::new(),
                watermark,
            };
        }
        Replay {
            reset: false,
            events: stream
                .events
                .iter()
                .filter(|event| event.sequence > cursor.sequence)
                .cloned()
                .collect(),
            watermark,
        }
    }

    #[cfg(test)]
    pub fn replay(&self, session_id: &str, cursor: Option<Cursor>, epoch: i64) -> Replay {
        Self::replay_locked(&mut self.lock(), session_id, cursor, epoch)
    }

    /// Replay and subscribe in one step, so no event falls in between:
    /// `deliver_replay` runs under the hub's lock before `listener` is added.
    pub fn attach(
        self: &Arc<Self>,
        session_id: &str,
        cursor: Option<Cursor>,
        epoch: i64,
        deliver_replay: impl FnOnce(Replay),
        listener: Listener,
    ) -> Subscription {
        let key = self.next_listener.fetch_add(1, Ordering::Relaxed);
        let mut state = self.lock();
        deliver_replay(Self::replay_locked(&mut state, session_id, cursor, epoch));
        stream(&mut state, session_id, 0)
            .listeners
            .insert(key, listener);
        Subscription {
            hub: Arc::downgrade(self),
            session_id: Some(session_id.to_owned()),
            key,
        }
    }
}

/// A listener; dropping it unsubscribes.
pub struct Subscription {
    hub: Weak<EventHub>,
    session_id: Option<String>,
    key: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        let mut state = hub.lock();
        match &self.session_id {
            None => {
                state.global.remove(&self.key);
            }
            Some(session_id) => {
                if let Some(stream) = state.streams.get_mut(session_id) {
                    stream.listeners.remove(&self.key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn cursor(epoch: i64, sequence: u64) -> Option<Cursor> {
        Some(Cursor { epoch, sequence })
    }

    #[test]
    fn sequences_epochs_and_replay() {
        let hub = EventHub::new(3);
        for n in 1..=4 {
            hub.publish("s", 0, "e", json!(n));
        }
        let all = hub.replay("s", None, 0);
        assert_eq!(
            all.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
            [2, 3, 4]
        );
        assert_eq!(
            all.watermark,
            Cursor {
                epoch: 0,
                sequence: 4
            }
        );
        assert_eq!(hub.replay("s", cursor(0, 2), 0).events.len(), 2);
        assert!(!hub.replay("s", cursor(0, 1), 0).reset);
        assert!(hub.replay("s", cursor(0, 0), 0).reset);
        assert!(hub.replay("s", cursor(0, 5), 0).reset);
        assert!(hub.replay("s", cursor(1, 0), 0).reset);
        // A newer epoch starts over.
        let event = hub.publish("s", 1, "e", json!(5));
        assert_eq!((event.epoch, event.sequence), (1, 1));
        assert_eq!(hub.replay("s", None, 0).events.len(), 1);
        // An older epoch's events join the current one.
        assert_eq!(hub.publish("s", 0, "e", json!(6)).epoch, 1);
    }

    #[test]
    fn replay_is_bounded_by_bytes() {
        let event = |n: u64| GatewayEvent {
            session_id: "s".into(),
            epoch: 0,
            sequence: n,
            kind: "e".into(),
            data: Some(json!("x".repeat(100))),
            timestamp: 0,
        };
        let size = json_size(&event(1));
        assert_eq!(size, serde_json::to_string(&event(1)).unwrap().len());
        // Room for two and a half events: the oldest go first.
        let hub = EventHub::with_limits(100, size * 5 / 2);
        for _ in 1..=4 {
            hub.publish("s", 0, "e", json!("x".repeat(100)));
        }
        let all = hub.replay("s", None, 0);
        assert_eq!(
            all.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
            [3, 4]
        );
        assert!(hub.replay("s", cursor(0, 1), 0).reset);
        assert!(!hub.replay("s", cursor(0, 2), 0).reset);
        // One event larger than the limit is still kept.
        hub.publish("s", 0, "e", json!("y".repeat(size * 3)));
        assert_eq!(hub.replay("s", None, 0).events.len(), 1);
    }

    #[test]
    fn attach_and_unsubscribe() {
        let hub = EventHub::new(10);
        hub.publish("s", 0, "e", json!(1));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let replayed = Arc::new(Mutex::new(0));
        let (sink, count) = (seen.clone(), replayed.clone());
        let subscription = hub.attach(
            "s",
            cursor(0, 0),
            0,
            |replay| *count.lock().unwrap() = replay.events.len(),
            Arc::new(move |event| sink.lock().unwrap().push(event.sequence)),
        );
        let all_seen = Arc::new(Mutex::new(0));
        let all_sink = all_seen.clone();
        let global = hub.subscribe_all(Arc::new(move |_| *all_sink.lock().unwrap() += 1));
        hub.publish("s", 0, "e", json!(2));
        hub.publish("other", 0, "e", json!(3));
        drop(subscription);
        drop(global);
        hub.publish("s", 0, "e", json!(4));
        assert_eq!(*replayed.lock().unwrap(), 1);
        assert_eq!(*seen.lock().unwrap(), [2]);
        assert_eq!(*all_seen.lock().unwrap(), 2);
    }
}
