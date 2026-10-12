//! TEMPORARY (M7 layout): the **network** worker's proxy interface, as it
//! will land in [`super::super::proxy`], forwarding to today's proxy
//! (which has no auth token yet). Delete this file at merge and import
//! `super::proxy` in `macos.rs` instead.
#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use tokio::sync::Semaphore;

pub use super::super::proxy::{Allowlist, MAX_NODE_CONNECTIONS, ProxyListener};

/// srt's per-session `proxyAuthToken`.
pub struct ProxyAuth {
    token: String,
}

impl ProxyAuth {
    pub fn generate() -> Self {
        let bytes = crate::util::random_bytes::<16>();
        Self {
            token: bytes.iter().map(|b| format!("{b:02x}")).collect(),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

pub enum EnvPlatform<'a> {
    Linux { helper: &'a Path },
    MacOs,
}

pub fn env_vars(
    platform: EnvPlatform<'_>,
    http_port: u16,
    socks_port: u16,
    auth: &ProxyAuth,
) -> Vec<(String, String)> {
    let _ = (platform, auth);
    super::super::proxy::env_vars(http_port, socks_port)
}

pub async fn serve(
    listener: ProxyListener,
    allowlist: Arc<Allowlist>,
    auth: Arc<ProxyAuth>,
    node: Arc<Semaphore>,
) {
    let _ = auth;
    super::super::proxy::serve(listener, allowlist, node).await;
}

impl ProxyListener {
    /// A TCP listener on `127.0.0.1:0` and its port.
    pub async fn loopback() -> std::io::Result<(ProxyListener, u16)> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        Ok((ProxyListener::Tcp(listener), port))
    }
}
