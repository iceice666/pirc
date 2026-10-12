//! The node's browsers: a port of `node/browser.ts`'s `BrowserManager`. One
//! Chromium per workspace (persistent profile under
//! `PIRC_BROWSER_PROFILES_DIR`), a tab group per session, the agent's
//! operations, the viewers (state, screencast, log), the user/agent mode
//! and handoff, recordings, the idle sweep and shutdown.
//!
//! Not a sandbox: the browser has the node account's network access and
//! the workspace profile's logins; [`super::hosts`] limits where it goes.
//!
//! Owner: manager (with [`super::recording`] and [`super::util`]).

use pirc_config::Env;
use pirc_config::node::NodeConfig;
use serde_json::Value;

use super::{BoxFuture, BrowserService, BrowserTarget, Detach, FrameSink};
use crate::error::ApiResult;

pub struct BrowserManager {
    _todo: (),
}

impl BrowserManager {
    pub fn new(_config: &NodeConfig, _env: &Env) -> Self {
        todo!("manager")
    }
}

impl BrowserService for BrowserManager {
    fn enabled(&self) -> bool {
        todo!("manager")
    }

    fn handle(
        &self,
        _target: BrowserTarget,
        _op: String,
        _args: Value,
    ) -> BoxFuture<'_, ApiResult<Value>> {
        todo!("manager")
    }

    fn attach(&self, _session_id: &str, _send: FrameSink) -> Detach {
        todo!("manager")
    }

    fn input(
        &self,
        _target: BrowserTarget,
        _message: Value,
    ) -> BoxFuture<'_, ApiResult<Option<Value>>> {
        todo!("manager")
    }

    fn close_session(&self, _session_id: &str) -> BoxFuture<'_, ()> {
        todo!("manager")
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        todo!("manager")
    }
}
