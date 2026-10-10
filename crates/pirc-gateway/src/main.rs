//! `pirc-gateway`, being rewritten in Rust (plans/rust-rewrite.md, M2): the
//! central daemon. It authenticates browsers (forward auth), indexes
//! sessions, buffers their events and routes every session request to the
//! node that owns it. It never runs agents, terminals or workspace
//! inspection itself.

// Parts land one M2 sub-item at a time; removed once M2 is complete.
#![allow(dead_code)]

mod app;
mod auth;
mod db;
mod devices;
mod error;
mod events;
mod features;
mod hints;
mod http;
mod log;
mod node_events;
mod nodes;
mod routes;
mod sockets;
mod util;
mod ws;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use pirc_config::{Env, GatewayConfig};

use crate::db::{Db, Store};

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("version" | "--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some(other) => {
            eprintln!("pirc-gateway: unknown command {other}");
            return ExitCode::FAILURE;
        }
        None => {}
    }
    let config = match GatewayConfig::load(&Env::from_process()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("pirc-gateway: {error}");
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("pirc-gateway: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pirc-gateway: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(config: GatewayConfig) -> Result<(), String> {
    let default_database = config.state_dir.join("gateway.sqlite");
    if default_database != config.database_path {
        db::refuse_typescript_database(&default_database)?;
    }
    let db = Arc::new(Db::open(&config.database_path)?);
    let recovery = db
        .lock()
        .recover_startup()
        .map_err(|error| format!("startup recovery: {error}"))?;
    log::info(&format!(
        "daemon startup recovery complete: {}",
        serde_json::to_string(&recovery).unwrap_or_default()
    ));
    if config.auth.proxy_secret.is_none() {
        log::warn(
            "PIRC_PROXY_SECRET is not set: any process that can reach the gateway port from a trusted \
             proxy address (PIRC_TRUSTED_PROXIES) can claim to be any allowed user. Set it and have \
             the proxy send it as x-pirc-proxy-secret (docs/deploy).",
        );
    }
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| format!("cannot listen on {}:{}: {error}", config.host, config.port))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("listener address: {error}"))?;
    // An invalid models file at startup is fatal; a missing one means no providers.
    let env = Env::from_process();
    let models = pirc_providers::load_models_file(
        &config.models_file,
        &|name| env.get(name).map(str::to_owned),
        &env.home(),
    )?
    .unwrap_or_else(app::empty_models);
    let app = app::App::new(config, db, models);
    app.devices.start_sweeper();
    tokio::spawn(reload_on_hangup(app.clone()));
    log::info(&format!("listening on http://{address}"));
    axum::serve(
        listener,
        app::router(app.clone()).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown({
        let app = app.clone();
        async move {
            shutdown().await;
            app.inference.cancel_all();
            app.nodes.close_all();
        }
    })
    .await
    .map_err(|error| format!("server failed: {error}"))
}

/// SIGHUP re-reads the models file.
async fn reload_on_hangup(app: app::AppState) {
    use tokio::signal::unix::{SignalKind, signal};
    let Ok(mut hangup) = signal(SignalKind::hangup()) else {
        return;
    };
    while hangup.recv().await.is_some() {
        log::info("SIGHUP: reloading models");
        app.reload_models();
    }
}

/// SIGINT or SIGTERM.
async fn shutdown() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut interrupt), Ok(mut terminate)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        return std::future::pending().await;
    };
    let name = tokio::select! {
        _ = interrupt.recv() => "SIGINT",
        _ = terminate.recv() => "SIGTERM",
    };
    log::info(&format!("{name}: shutting down"));
}
