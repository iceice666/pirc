//! `pirc-node sandbox-bridge`: runs inside the native sandbox, bridges
//! `127.0.0.1:3128` to the node's proxy socket, then runs the agent with
//! the remaining arguments (spike C's `inner`, replacing socat). Owner:
//! **sandbox**. Internal: not in the help text.

use std::process::ExitCode;

/// The subcommand's arguments after its name.
pub fn run(args: Vec<String>) -> ExitCode {
    let _ = args;
    todo!("sandbox: the in-sandbox bridge")
}
