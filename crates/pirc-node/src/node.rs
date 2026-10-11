//! The node process (`node/main.ts` `runNode`). Owner: **core**.

use pirc_config::{Env, NodeConfig};
use tokio::signal::unix::{SignalKind, signal};

use crate::services::Services;

/// Start the node ([`crate::services::Services::start`]), run the link
/// ([`crate::link::run`]) until SIGINT or SIGTERM (the first one; a second
/// kills), then close it ([`crate::services::Services::close`]).
pub async fn run(config: NodeConfig, env: Env) -> Result<(), String> {
    raise_fd_limit();
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

/// Raise the soft `RLIMIT_NOFILE` to the hard limit, as Bun did for the TS
/// node (its agents inherited it too). systemd starts services with a soft
/// limit of 1024, which the node's sockets, database, terminals and every
/// session's sandbox proxy (in this process, unlike srt's) would share.
/// Failure is logged; the node runs with the limit it has.
fn raise_fd_limit() {
    use nix::sys::resource::{Resource, getrlimit, setrlimit};
    let result = getrlimit(Resource::RLIMIT_NOFILE).and_then(|(soft, hard)| {
        // macOS refuses a soft limit above `OPEN_MAX` (its hard limit is
        // usually unlimited).
        let target = if cfg!(target_os = "macos") {
            hard.min(10240)
        } else {
            hard
        };
        if soft < target {
            setrlimit(Resource::RLIMIT_NOFILE, target, hard)
        } else {
            Ok(())
        }
    });
    if let Err(error) = result {
        crate::log::warn(&format!("cannot raise the open file limit: {error}"));
    }
}
