//! Image attachments of one `ptc` execution (`agent/ptc/attachments.ts`;
//! docs/architecture/ptc.md). An operation's
//! images stay on the host; the script sees descriptors with an opaque,
//! unguessable handle and may queue them for the outer `ptc` result with
//! `attachments.add(handle)`. No bytes, paths or URLs ever enter the realm,
//! and nothing here can read anything new: a handle only names an image an
//! operation of this execution already returned.
//!
//! Handles belong to one execution (the instance), so they cannot be used
//! by another session or a later call. They expire after 15 minutes or when
//! the execution ends; whatever was not queued is dropped then.

use std::rc::Rc;

use indexmap::IndexMap;
use pirc_protocol::UserBlock;
use serde_json::{Value, json};

use super::contracts::PtcError;
use crate::{now_ms, random_hex};

/// `ATTACHMENT_LIMITS`.
pub mod limits {
    /// Attachments one `ptc` result may carry.
    pub const COUNT: usize = 4;
    /// The queued images of one result, decoded. The result travels as one
    /// node RPC line (1 MiB by default) three times over, with its text and
    /// details, so its base64 (4/3 larger) must stay well below that limit.
    pub const BYTES_EACH: u64 = 512 * 1024;
    pub const BYTES_TOTAL: u64 = 512 * 1024;
    pub const TTL_MS: u64 = 15 * 60 * 1000;
    /// Images kept for possible attachment; older unqueued ones go first.
    pub const RETAINED: usize = 16;
    pub const RETAINED_BYTES: u64 = 64 * 1024 * 1024;
    /// `attachments.add` calls per execution.
    pub const CALLS: usize = 100;
}

/// `HANDLE_PATTERN`: `^att_[0-9a-f]{64}$`.
pub fn is_handle(handle: &str) -> bool {
    handle.len() == 68
        && handle.starts_with("att_")
        && handle[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

struct Stored {
    image: UserBlock,
    bytes: u64,
    expires_at: u64,
}

/// `decodedBytes(base64)`.
fn decoded_bytes(base64: &str) -> u64 {
    let padding = if base64.ends_with("==") {
        2
    } else if base64.ends_with('=') {
        1
    } else {
        0
    };
    ((base64.len() as u64 * 3) / 4).saturating_sub(padding)
}

/// `Attachments`.
pub struct Attachments {
    stored: IndexMap<String, Stored>,
    queued: Vec<String>,
    calls: usize,
    closed: bool,
    /// Whether the current model accepts images; checked on every `add`.
    model_takes_images: Rc<dyn Fn() -> bool>,
    now: Rc<dyn Fn() -> u64>,
}

impl Attachments {
    pub fn new(model_takes_images: Rc<dyn Fn() -> bool>) -> Self {
        Self::with_clock(model_takes_images, Rc::new(now_ms))
    }

    pub fn with_clock(model_takes_images: Rc<dyn Fn() -> bool>, now: Rc<dyn Fn() -> u64>) -> Self {
        Self {
            stored: IndexMap::new(),
            queued: Vec::new(),
            calls: 0,
            closed: false,
            model_takes_images,
            now,
        }
    }

    /// `register(image)`: keep an operation's image; the script gets only
    /// its descriptor `{handle, mimeType, bytes}`.
    pub fn register(&mut self, image: &UserBlock) -> Value {
        let handle = format!("att_{}", random_hex(32));
        let (data, mime_type) = match image {
            UserBlock::Image { data, mime_type } => (data.as_str(), mime_type.as_str()),
            UserBlock::Text { .. } => ("", ""),
        };
        let bytes = decoded_bytes(data);
        if !self.closed {
            let expires_at = (self.now)() + limits::TTL_MS;
            self.stored.insert(
                handle.clone(),
                Stored {
                    image: image.clone(),
                    bytes,
                    expires_at,
                },
            );
            self.evict();
        }
        json!({ "handle": handle, "mimeType": mime_type, "bytes": bytes })
    }

    fn evict(&mut self) {
        let handles: Vec<String> = self.stored.keys().cloned().collect();
        for handle in handles {
            let total: u64 = self.stored.values().map(|item| item.bytes).sum();
            if self.stored.len() <= limits::RETAINED && total <= limits::RETAINED_BYTES {
                return;
            }
            if !self.queued.contains(&handle) {
                self.stored.shift_remove(&handle);
            }
        }
    }

    /// `attachments.add(handle)`: queue an image for the outer result;
    /// `{queued}`.
    pub fn add(&mut self, handle: &str) -> Result<Value, PtcError> {
        self.calls += 1;
        if self.calls > limits::CALLS {
            return Err(PtcError::new(
                "QuotaExceeded",
                format!("More than {} attachments.add calls", limits::CALLS),
            ));
        }
        if !is_handle(handle) {
            return Err(PtcError::new(
                "InvalidArguments",
                "attachments.add takes an image descriptor (or its handle) from an operation result",
            ));
        }
        let unknown = || {
            PtcError::new(
                "InvalidArguments",
                "Unknown attachment handle: it was never issued in this ptc call, or was dropped",
            )
        };
        if self.closed {
            return Err(unknown());
        }
        let Some(item) = self.stored.get(handle) else {
            return Err(unknown());
        };
        let bytes = item.bytes;
        if item.expires_at <= (self.now)() {
            self.stored.shift_remove(handle);
            return Err(PtcError::new(
                "InvalidArguments",
                "This attachment handle expired",
            ));
        }
        if !(self.model_takes_images)() {
            return Err(PtcError::new(
                "CapabilityUnavailable",
                "The current model does not accept images; describe the image in text instead",
            ));
        }
        if self.queued.iter().any(|queued| queued == handle) {
            return Ok(json!({ "queued": self.queued.len() }));
        }
        if self.queued.len() >= limits::COUNT {
            return Err(PtcError::new(
                "QuotaExceeded",
                format!("At most {} attachments per ptc call", limits::COUNT),
            ));
        }
        if bytes > limits::BYTES_EACH {
            return Err(PtcError::new(
                "QuotaExceeded",
                format!(
                    "The image is larger than {} bytes and cannot be attached",
                    limits::BYTES_EACH
                ),
            ));
        }
        let total: u64 = self
            .queued
            .iter()
            .map(|queued| self.stored.get(queued).map_or(0, |item| item.bytes))
            .sum();
        if total + bytes > limits::BYTES_TOTAL {
            return Err(PtcError::new(
                "QuotaExceeded",
                format!(
                    "Attachments of one ptc call are limited to {} bytes in total",
                    limits::BYTES_TOTAL
                ),
            ));
        }
        self.queued.push(handle.to_owned());
        Ok(json!({ "queued": self.queued.len() }))
    }

    /// `close(deliver)`: the end of the execution. The queued images (only
    /// when `deliver`, and not expired), then every handle is gone.
    pub fn close(&mut self, deliver: bool) -> Vec<UserBlock> {
        let now = (self.now)();
        let images = if deliver {
            self.queued
                .iter()
                .filter_map(|handle| self.stored.get(handle))
                .filter(|item| item.expires_at > now)
                .map(|item| item.image.clone())
                .collect()
        } else {
            Vec::new()
        };
        self.closed = true;
        self.stored.clear();
        self.queued.clear();
        images
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use base64::Engine;

    use super::*;

    fn image(bytes: usize) -> UserBlock {
        UserBlock::Image {
            data: base64::engine::general_purpose::STANDARD.encode(vec![0u8; bytes]),
            mime_type: "image/png".to_owned(),
        }
    }

    fn takes(images: bool) -> Rc<dyn Fn() -> bool> {
        Rc::new(move || images)
    }

    fn handle_of(descriptor: &Value) -> String {
        descriptor["handle"].as_str().unwrap().to_owned()
    }

    #[test]
    fn handles_are_unguessable_scoped_to_the_instance_and_carry_no_bytes() {
        let mut one = Attachments::new(takes(true));
        let mut other = Attachments::new(takes(true));
        let descriptor = one.register(&image(10));
        let handle = handle_of(&descriptor);
        assert!(is_handle(&handle));
        assert_eq!(descriptor["mimeType"], "image/png");
        assert_eq!(descriptor["bytes"], 10);
        assert_eq!(descriptor.as_object().unwrap().len(), 3);
        assert!(
            other
                .add(&handle)
                .unwrap_err()
                .message
                .contains("Unknown attachment handle")
        );
        assert!(
            one.add(&format!("att_{}", "0".repeat(64)))
                .unwrap_err()
                .message
                .contains("Unknown attachment handle")
        );
        assert_eq!(
            one.add("../etc/passwd").unwrap_err().code,
            "InvalidArguments"
        );
        assert_eq!(one.add(&handle).unwrap(), json!({ "queued": 1 }));
        // Queuing twice is one attachment.
        assert_eq!(one.add(&handle).unwrap(), json!({ "queued": 1 }));
        assert_eq!(one.close(true), vec![image(10)]);
        // Closed: nothing is left.
        assert!(
            one.add(&handle)
                .unwrap_err()
                .message
                .contains("Unknown attachment handle")
        );
    }

    #[test]
    fn enforce_count_size_expiry_and_the_model_and_deliver_nothing_when_cancelled() {
        let now = Rc::new(Cell::new(0u64));
        let images = Rc::new(Cell::new(true));
        let (clock, model) = (now.clone(), images.clone());
        let mut set =
            Attachments::with_clock(Rc::new(move || model.get()), Rc::new(move || clock.get()));
        let handles: Vec<String> = (0..5)
            .map(|_| handle_of(&set.register(&image(1))))
            .collect();
        for handle in &handles[..4] {
            set.add(handle).unwrap();
        }
        assert!(
            set.add(&handles[4])
                .unwrap_err()
                .message
                .contains(&format!("At most {} attachments", limits::COUNT))
        );
        let mut big = Attachments::new(takes(true));
        let descriptor = big.register(&image(limits::BYTES_EACH as usize + 1));
        assert!(
            big.add(&handle_of(&descriptor))
                .unwrap_err()
                .message
                .contains("larger than")
        );
        // Queued images together stay well below one node RPC line (1 MiB, base64).
        assert!((limits::BYTES_TOTAL * 4).div_ceil(3) < 1024 * 1024);
        let mut pair = Attachments::new(takes(true));
        let first = handle_of(&pair.register(&image(300 * 1024)));
        pair.add(&first).unwrap();
        let second = handle_of(&pair.register(&image(300 * 1024)));
        assert!(pair.add(&second).unwrap_err().message.contains("in total"));
        let late = handle_of(&set.register(&image(1)));
        images.set(false);
        assert!(
            set.add(&late)
                .unwrap_err()
                .message
                .contains("does not accept images")
        );
        images.set(true);
        now.set(limits::TTL_MS);
        assert!(set.add(&late).unwrap_err().message.contains("expired"));
        // Queued handles that expired before delivery are dropped too.
        assert!(set.close(true).is_empty());
        let mut cancelled = Attachments::new(takes(true));
        let handle = handle_of(&cancelled.register(&image(1)));
        cancelled.add(&handle).unwrap();
        assert!(cancelled.close(false).is_empty());
    }

    #[test]
    fn keeps_a_bounded_number_of_unqueued_images() {
        let mut set = Attachments::new(takes(true));
        let first = handle_of(&set.register(&image(1)));
        set.add(&first).unwrap();
        let dropped = handle_of(&set.register(&image(1)));
        for _ in 0..limits::RETAINED {
            set.register(&image(1));
        }
        // The oldest unqueued image went; the queued one stays.
        assert!(
            set.add(&dropped)
                .unwrap_err()
                .message
                .contains("Unknown attachment handle")
        );
        assert_eq!(set.close(true).len(), 1);
    }
}
