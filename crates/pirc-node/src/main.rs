//! `pirc-node`, being rewritten in Rust (plans/rust-rewrite.md). The
//! session agent (`pirc-node agent`) is being ported (M4); the node and
//! chat roles are M6, so the TypeScript build remains the one to run.

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("version" | "--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("agent") => pirc_agent::run_agent(args.collect()),
        _ => {
            eprintln!(
                "pirc-node (Rust) only runs `pirc-node agent` so far; run the TypeScript build. See plans/rust-rewrite.md."
            );
            ExitCode::FAILURE
        }
    }
}
