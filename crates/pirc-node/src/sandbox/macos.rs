//! The native macOS backend (srt's `macos-sandbox-utils`, Apache-2.0):
//! `sandbox-exec -p <profile>` with srt's SBPL profile generated from the
//! session policy, and the shared filtering proxy ([`super::proxy`]) on a
//! loopback TCP port, the only outbound address the profile allows.
//! Owner: **macos** (M7).
//!
//! Profile generation is plain text and compiles everywhere, so its golden
//! tests (profiles recorded from srt 0.0.78) run on Linux CI too; only
//! [`super::create`] picks this backend, on macOS.

use pirc_config::{Env, NodeConfig};

use super::{BoxFuture, PrepareInput, Prepared, ReadonlyInput, Sandbox, SandboxStatus};
use crate::error::ApiResult;

/// The Seatbelt backend.
pub struct MacSandbox {
    config: NodeConfig,
    env: Env,
}

impl MacSandbox {
    pub fn new(config: NodeConfig, env: Env) -> Self {
        Self { config, env }
    }
}

impl Sandbox for MacSandbox {
    fn check(&self) -> BoxFuture<'_, SandboxStatus> {
        let _ = (&self.config, &self.env);
        todo!("M7 macos: probe sandbox-exec")
    }

    fn prepare(&self, input: PrepareInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        let _ = input;
        todo!("M7 macos: a session's Seatbelt sandbox")
    }

    fn prepare_readonly(&self, input: ReadonlyInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        let _ = input;
        todo!("M7 macos: the read-only Seatbelt sandbox for panel git")
    }
}
