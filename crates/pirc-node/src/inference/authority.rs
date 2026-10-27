//! Runner-scoped inference authority. The agent's request sessionId is a model
//! cache label, never the authority used to choose which runner may send work.
use super::*;
use crate::store::Store;
use std::sync::Weak;

#[derive(Clone)]
pub(super) struct Identity {
    pub session: String,
    pub workspace: String,
    pub epoch: i64,
    pub mode: pirc_protocol::Mode,
}
/// The callback holds the Node database fence while performing a synchronous
/// admission. Lock order: database -> scope serial -> relay state. No await.
pub(super) type Gate = Arc<dyn Fn(&Identity, &mut dyn FnMut()) -> bool + Send + Sync>;

pub(super) fn node_gate(node: WeakNode) -> Gate {
    Arc::new(move |identity, admit| {
        let Some(node) = node.upgrade() else {
            return false;
        };
        let db = node.db.lock();
        let valid = (|| {
            db.require_session_available(&identity.session)?;
            crate::execution_fences::require_open(&db, &identity.session)?;
            let session = db.get_session(&identity.session)?;
            if session.runner_epoch != identity.epoch || session.workspace_id != identity.workspace
            {
                return Err(crate::error::ApiError::conflict(
                    "Runner environment changed",
                ));
            }
            let workspace = db.get_workspace(&session.workspace_id)?;
            if node.workspace_mode(&workspace)? != identity.mode {
                return Err(crate::error::ApiError::conflict("Runner mode changed"));
            }
            Ok::<(), crate::error::ApiError>(())
        })();
        if valid.is_err() || node.closing() {
            return false;
        }
        admit();
        true
    })
}

pub(super) struct Scope {
    pub identity: Identity,
    pub config: InferenceConfig,
    pub serial: Mutex<bool>,
    pub revoked: watch::Sender<bool>,
}

pub(crate) struct Lease {
    pub config: InferenceConfig,
    relay: Weak<Relay>,
}
impl Lease {
    pub fn close(&self) {
        if let Some(relay) = self.relay.upgrade() {
            relay.revoke(&self.config.token);
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.close();
    }
}

impl Relay {
    pub(super) fn register(self: &Arc<Self>, identity: Identity) -> Lease {
        let config = InferenceConfig {
            socket_path: self.config.socket_path.clone(),
            token: hex(&random_bytes::<32>()),
        };
        let scope = Arc::new(Scope {
            identity,
            config: config.clone(),
            serial: Mutex::new(true),
            revoked: watch::channel(false).0,
        });
        let mut state = self.lock();
        if !state.closed {
            state.scopes.insert(config.token.clone(), scope);
        }
        Lease {
            config,
            relay: Arc::downgrade(self),
        }
    }
    pub(super) fn authenticate(&self, authorization: &str) -> Option<Arc<Scope>> {
        let token = authorization.strip_prefix("Bearer ")?;
        if token.len() != 64 {
            return None;
        }
        self.lock().scopes.iter().find_map(|(key, scope)| {
            bool::from(token.as_bytes().ct_eq(key.as_bytes())).then(|| scope.clone())
        })
    }
    pub(super) fn authorized(&self, scope: &Scope, action: &mut dyn FnMut()) -> bool {
        let mut admitted = false;
        (self.gate)(&scope.identity, &mut || {
            let active = scope.serial.lock().unwrap_or_else(|p| p.into_inner());
            if *active && !self.lock().closed {
                action();
                admitted = true;
            }
        });
        admitted
    }
    fn revoke(&self, token: &str) {
        // Do not hold relay state while waiting for an in-flight send.
        let scope = self.lock().scopes.get(token).cloned();
        let Some(scope) = scope else { return };
        let mut active = scope.serial.lock().unwrap_or_else(|p| p.into_inner());
        if !*active {
            return;
        }
        *active = false;
        scope.revoked.send_replace(true);
        self.lock().scopes.remove(token);
        let ids: Vec<_> = self
            .lock()
            .pending
            .iter()
            .filter(|(_, p)| Arc::ptr_eq(&p.scope, &scope))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.fail(&id, InferenceErrorCode::Unavailable, true);
        }
    }
    pub(super) fn revoke_session(&self, session: &str) {
        let tokens: Vec<_> = self
            .lock()
            .scopes
            .iter()
            .filter(|(_, s)| s.identity.session == session)
            .map(|(token, _)| token.clone())
            .collect();
        for token in tokens {
            self.revoke(&token);
        }
    }
}
