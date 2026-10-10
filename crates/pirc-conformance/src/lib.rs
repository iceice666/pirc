//! Black-box conformance harness for the pirc executables.
//!
//! Tests start real `pirc-gateway` and `pirc-node` executables from
//! `PIRC_CONFORMANCE_BIN_DIR` and talk to them only over HTTP and WebSocket,
//! so the same scenarios run against the TypeScript build (whose behavior the
//! committed snapshots record) and the Rust build that replaces it.

mod client;
mod cluster;
mod fake_llm;
mod normalize;

pub use client::{Api, Connection, Response, WebSocket};
pub use cluster::{Cluster, GatewayOptions, HOST, NODE_ID, NODE_TOKEN, ORIGIN, USER, WORKSPACE_ID};
pub use fake_llm::{FakeLlm, Reply};
pub use normalize::{Normalizer, Transcript};

/// Headers a trusted proxy adds to an authenticated browser request.
pub fn browser_headers() -> Vec<(&'static str, String)> {
    vec![
        ("host", HOST.to_owned()),
        ("origin", ORIGIN.to_owned()),
        ("x-pirc-user", USER.to_owned()),
    ]
}
