//! The node process (`node/main.ts` `runNode`). Owner: **core**.

use pirc_config::{Env, NodeConfig};

/// Start the node ([`crate::services::Services::start`]), run the link
/// ([`crate::link::run`]) until SIGINT or SIGTERM (the first one; a second
/// kills), then close it ([`crate::services::Services::close`]).
pub async fn run(config: NodeConfig, env: Env) -> Result<(), String> {
    let _ = (config, env);
    todo!("core: runNode")
}
