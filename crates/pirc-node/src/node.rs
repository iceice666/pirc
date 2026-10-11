//! The node process (`node/main.ts` `runNode`). Owner: **core**.

use pirc_config::{Env, NodeConfig};
use tokio::signal::unix::{SignalKind, signal};

use crate::services::Services;

/// Start the node ([`crate::services::Services::start`]), run the link
/// ([`crate::link::run`]) until SIGINT or SIGTERM (the first one; a second
/// kills), then close it ([`crate::services::Services::close`]).
pub async fn run(config: NodeConfig, env: Env) -> Result<(), String> {
    let mut interrupt =
        signal(SignalKind::interrupt()).map_err(|error| format!("SIGINT: {error}"))?;
    let mut terminate =
        signal(SignalKind::terminate()).map_err(|error| format!("SIGTERM: {error}"))?;
    let node = Services::start(config, env).await?;
    let link = tokio::spawn(crate::link::run(node.clone()));
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
    // TS listened `once`: a second signal had its default action and killed
    // the process. Handlers cannot be reset without unsafe code, so a second
    // one exits at once with the status a signal death reports.
    tokio::spawn(async move {
        let code = tokio::select! {
            _ = interrupt.recv() => 130,
            _ = terminate.recv() => 143,
        };
        std::process::exit(code);
    });
    node.close().await;
    let _ = link.await;
    Ok(())
}
