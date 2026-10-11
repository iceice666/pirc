//! `pirc-node`: the coding node (no subcommand), the chat node (`chat`),
//! and the internal subcommands its agents and sandbox run (`agent`,
//! `ptc-guest`, `sandbox-bridge`). See `pirc_node` for the modules.

use std::process::ExitCode;

use pirc_node::cli::{self, Command};

fn main() -> ExitCode {
    match cli::parse(std::env::args().skip(1).collect()) {
        Command::Run(role) => pirc_node::run_role(role),
        Command::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Command::Help => {
            print!("{}", cli::USAGE);
            ExitCode::SUCCESS
        }
        Command::Agent(args) => pirc_agent::run_agent(args),
        Command::PtcGuest => pirc_ptc::guest::run(),
        Command::SandboxBridge(args) => pirc_node::sandbox::bridge::run(args),
        Command::Unknown(command) => {
            eprint!("Unknown command: {command}\n\n{}", cli::USAGE);
            ExitCode::from(2)
        }
    }
}
