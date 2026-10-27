//! The model catalog the node's agents start with (`ModelStore` in
//! `apps/gateway/src/models.ts`): the gateway's secret-free catalog from
//! `registered` and `models` frames, always with the node's own inference
//! socket metadata merged in. The runner supplies a private inference lease on
//! its `configure` line; the shared catalog has no usable bearer token.
//! `GET /models` serves the current catalog with only that caller's lease.

use std::sync::RwLock;

use indexmap::IndexMap;
use pirc_protocol::{InferenceConfig, Models};

pub struct ModelStore {
    current: RwLock<Models>,
}

impl Default for ModelStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelStore {
    /// Empty until the gateway's `registered` frame.
    pub fn new() -> Self {
        Self {
            current: RwLock::new(Models {
                providers: IndexMap::new(),
                default_model: None,
                inference: None,
            }),
        }
    }

    pub fn current(&self) -> Models {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The node's own inference endpoint, once its socket listens.
    pub fn inference(&self) -> Option<InferenceConfig> {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .inference
            .clone()
    }

    /// Replace the catalog (`{...models, inference}`): the gateway's
    /// `inference` field, if any, is replaced by `inference`.
    pub fn set(&self, mut models: Models, inference: Option<InferenceConfig>) {
        models.inference = inference;
        *self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = models;
    }

    /// Keep the catalog, change the inference endpoint (set once the
    /// socket listens, before the link connects).
    pub fn set_inference(&self, inference: Option<InferenceConfig>) {
        self.current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .inference = inference;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_node_inference() {
        let store = ModelStore::new();
        let local = InferenceConfig {
            socket_path: "/s".into(),
            token: "t".into(),
        };
        store.set_inference(Some(local.clone()));
        let mut gateway = Models {
            providers: IndexMap::new(),
            default_model: None,
            inference: Some(InferenceConfig {
                socket_path: "/other".into(),
                token: "x".into(),
            }),
        };
        gateway.default_model = None;
        store.set(gateway, store.inference());
        assert_eq!(store.current().inference, Some(local));
    }
}
