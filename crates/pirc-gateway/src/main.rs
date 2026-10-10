//! `pirc-gateway`, being rewritten in Rust (plans/rust-rewrite.md). Until the
//! rewrite reaches it, this executable only reports its version; the
//! TypeScript build in `apps/gateway` is the one to run.

use std::process::ExitCode;

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("version" | "--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!(
                "pirc-gateway (Rust) is not implemented yet; run the TypeScript build. See plans/rust-rewrite.md."
            );
            ExitCode::FAILURE
        }
    }
}
