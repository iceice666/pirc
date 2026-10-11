//! `pirc-node agent --session-dir DIR` (`agent/main.ts`): the `configure`
//! handshake, the agent, then RPC until stdin ends.

use std::process::ExitCode;

/// Run one session agent; `args` follow `agent`.
pub fn run_agent(args: Vec<String>) -> ExitCode {
    let _ = args;
    todo!("M4 rpc: runAgent")
}
